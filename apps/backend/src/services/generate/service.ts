import { Effect, Stream, pipe, DateTime, Duration, Ref, Option } from "effect";
import { streamText } from "ai";
import {
  LanguageModelProvider,
  type LanguageModelConfig,
} from "@betalyra/generative-ui-common/server";
import { MemoryService, type MemorySearchResult } from "../memory/index.js";
import { accumulateLinesWithFlush } from "../../stream/utils.js";
import { PatchValidator, type Patch } from "../vdom/index.js";
import { ModelRegistry } from "../model-registry.js";
import {
  PatchSchema,
  LLMResponseSchema,
  JsonParseError,
  type UnifiedResponse,
  type UnifiedGenerateOptions,
  type Message,
  type Usage,
  type AggregatedUsage,
  MAX_RETRY_ATTEMPTS,
  buildSystemPrompt,
  buildCorrectivePrompt,
  safeAsyncIterable,
  PromptLogger,
} from "./index.js";
import type { GenerationError } from "./errors.js";
import { ToolService, TOOL_STEP_LIMIT, type SandboxTools } from "./tools.js";
import type { ManagedSandbox, SandboxContext } from "../sandbox/manager.js";

export class GenerateService extends Effect.Service<GenerateService>()(
  "GenerateService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const defaultConfig = yield* LanguageModelProvider;
      const modelRegistry = yield* ModelRegistry;
      const memory = yield* MemoryService;
      const patchValidator = yield* PatchValidator;
      const promptLogger = yield* PromptLogger;
      const toolService = yield* ToolService;

      // ============================================================
      // Parse JSON line - fails with JsonParseError for retry
      // ============================================================
      const parseJsonLine = (line: string) =>
        Effect.gen(function* () {
          const parseResult = yield* Effect.try({
            try: () => JSON.parse(line),
            catch: (error) =>
              new JsonParseError({
                line,
                message: error instanceof Error ? error.message : String(error),
              }),
          });

          // Try parsing as LLM response (patches only)
          const llmResult = LLMResponseSchema.safeParse(parseResult);
          if (llmResult.success) {
            return llmResult.data;
          }

          // Fallback: check if it's a raw patch and wrap it
          const patchResult = PatchSchema.safeParse(parseResult);
          if (patchResult.success) {
            return {
              type: "patches" as const,
              patches: [patchResult.data],
            };
          }

          // Neither valid - fail with JsonParseError
          return yield* new JsonParseError({
            line,
            message: `Invalid response format: ${llmResult.error.message}`,
          });
        });

      // ============================================================
      // Parse and validate a JSON line - fails with GenerationError
      // ============================================================
      const parseAndValidate = (
        line: string,
        validationDoc: Document,
      ): Effect.Effect<UnifiedResponse, GenerationError> =>
        Effect.gen(function* () {
          // Parse JSON (fails with JsonParseError)
          const response = yield* parseJsonLine(line);

          // Validate patches (fails with PatchValidationError)
          if (response.type === "patches") {
            yield* patchValidator.validateAll(validationDoc, response.patches);
          }

          return response;
        });

      // ============================================================
      // Create attempt stream - uses fullStream for usage tracking
      // ============================================================
      const createAttemptStream = (
        messages: readonly Message[],
        validationDoc: Document,
        usageRef: Ref.Ref<Usage[]>,
        modelConfig: LanguageModelConfig,
        requestTools?: SandboxTools,
      ): Stream.Stream<UnifiedResponse, GenerationError | Error> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const result = streamText({
              model: modelConfig.model,
              messages: messages as Message[],
              providerOptions: modelConfig.providerOptions,
              ...(requestTools && {
                tools: requestTools,
                stopWhen: TOOL_STEP_LIMIT,
                toolChoice: "auto",
              }),
            });

            // Use fullStream to get both text AND usage events
            const fullStream = Stream.fromAsyncIterable(
              safeAsyncIterable(result.fullStream),
              (error) =>
                error instanceof Error
                  ? error
                  : new Error(`Stream error: ${String(error)}`),
            );

            return pipe(
              fullStream,
              // Extract text from text-delta, track usage from finish
              Stream.mapEffect((part) =>
                Effect.gen(function* () {
                  // Cast to access raw data - AI SDK types are incomplete
                  const raw = part as Record<string, unknown>;

                  // Capture usage from finish-step using provider-specific extractor
                  if (raw.type === "finish-step") {
                    if (raw.usage) {
                      const extracted = modelConfig.extractUsage(raw.usage);
                      yield* Ref.update(usageRef, (usages) => [
                        ...usages,
                        {
                          inputTokens: extracted.inputTokens,
                          outputTokens: extracted.outputTokens,
                          totalTokens: extracted.totalTokens,
                          inputTokenDetails: {
                            cacheReadTokens: extracted.cachedTokens,
                          },
                        },
                      ]);
                    }
                    return null;
                  }

                  if (raw.type === "finish") {
                    return null; // Skip finish, we already captured from finish-step
                  }

                  if (raw.type === "text-delta") {
                    return (raw as { text: string }).text;
                  }

                  return null; // Ignore other event types
                }),
              ),
              // Filter out nulls (non-text events)
              Stream.filter((text): text is string => text !== null),
              // Accumulate text into lines
              accumulateLinesWithFlush,
              Stream.tap((line) => Effect.log("Line", { line })),
              // Parse and validate each line
              Stream.mapEffect((line) => parseAndValidate(line, validationDoc)),
            );
          }),
        );

      // ============================================================
      // Create stream with retry - uses catchAll for seamless recovery
      // ============================================================
      const createStreamWithRetry = (
        messages: readonly Message[],
        validationDoc: Document,
        usageRef: Ref.Ref<Usage[]>,
        patchesRef: Ref.Ref<Patch[]>,
        modeRef: Ref.Ref<"patches" | "full">,
        attempt: number,
        modelConfig: LanguageModelConfig,
        requestTools?: SandboxTools,
      ): Stream.Stream<UnifiedResponse, Error> => {
        if (attempt >= MAX_RETRY_ATTEMPTS) {
          return Stream.fail(
            new Error(`Max retries (${MAX_RETRY_ATTEMPTS}) exceeded`),
          );
        }

        return pipe(
          createAttemptStream(
            messages,
            validationDoc,
            usageRef,
            modelConfig,
            requestTools,
          ),

          // Track successful patches, mode, and log
          Stream.tap((response) =>
            Effect.gen(function* () {
              if (response.type === "patches") {
                yield* Ref.update(patchesRef, (ps) => [
                  ...ps,
                  ...response.patches,
                ]);
              } else if (response.type === "full") {
                yield* Ref.set(modeRef, "full");
              }
              yield* Effect.log(`[Attempt ${attempt}] Emitting response`, {
                type: response.type,
              });
            }),
          ),

          // THE KEY: catchAll intercepts errors and retries on GenerationError
          Stream.catchAll((error: GenerationError | Error) => {
            // Only retry on GenerationError (tagged errors with _tag)
            if (!("_tag" in error)) {
              return Stream.fail(error);
            }

            const genError = error as GenerationError;
            return Stream.unwrap(
              Effect.gen(function* () {
                const successfulPatches = yield* Ref.get(patchesRef);
                yield* Ref.set(patchesRef, []); // Reset for next attempt
                yield* Effect.log(
                  `[Attempt ${attempt}] ${genError._tag}, retrying...`,
                  {
                    error: genError.message,
                    successfulPatches: successfulPatches.length,
                  },
                );

                return Stream.concat(
                  Stream.empty,
                  createStreamWithRetry(
                    [
                      ...messages,
                      {
                        role: "user",
                        content: buildCorrectivePrompt(
                          genError,
                          successfulPatches,
                        ),
                      },
                    ],
                    validationDoc,
                    usageRef,
                    patchesRef,
                    modeRef,
                    attempt + 1,
                    modelConfig,
                    requestTools,
                  ),
                );
              }),
            );
          }),
        );
      };

      // ============================================================
      // Main entry point - streamUnified
      // ============================================================
      const streamUnified = (options: UnifiedGenerateOptions) =>
        Effect.gen(function* () {
          const { sessionId, currentHtml, actions } = options;

          const modelConfig = options.modelId
            ? yield* modelRegistry.resolve(options.modelId)
            : defaultConfig;

          // Build per-request sandbox tools (only when sandbox is configured)
          // Reuse session-scoped sandboxCtx (warm mode) or create fresh one (lazy)
          const packageInfo = toolService.listPackageInfo();
          const requestTools =
            packageInfo.length > 0
              ? yield* Effect.gen(function* () {
                  const sandboxCtx: SandboxContext = options.sandboxCtx ?? {
                    ref: yield* Ref.make<Option.Option<ManagedSandbox>>(
                      Option.none(),
                    ),
                    lock: yield* Effect.makeSemaphore(1),
                  };
                  const runtime = yield* Effect.runtime<never>();
                  return toolService.makeTools({
                    sessionId,
                    sandboxCtx,
                    runtime,
                  });
                })
              : undefined;

          yield* Effect.log("Streaming unified response", {
            provider: modelConfig.providerName,
            model: options.modelId ?? "default",
            actionCount: actions.length,
            hasCurrentHtml: !!currentHtml,
          });

          // Build memory search query from all actions/prompts
          const searchQueryParts = actions.map((a) =>
            a.type === "prompt" && a.prompt
              ? a.prompt
              : `user action: ${a.action}`,
          );
          const searchQuery = searchQueryParts.join("; ");

          // Fetch recent entries and semantic search results
          const [recentEntries, relevantEntries] = yield* Effect.all([
            memory
              .getRecent(sessionId, 5)
              .pipe(
                Effect.catchAll(() =>
                  Effect.succeed([] as MemorySearchResult[]),
                ),
              ),
            memory
              .search(sessionId, searchQuery, 8)
              .pipe(
                Effect.catchAll(() =>
                  Effect.succeed([] as MemorySearchResult[]),
                ),
              ),
          ]);

          // Filter out recent from relevant to avoid duplicates
          const recentIds = new Set(recentEntries.map((e) => e.id));
          const uniqueRelevant = relevantEntries
            .filter((e) => !recentIds.has(e.id))
            .slice(0, 3);

          // Build history (context only, not to act on)
          const historyParts: string[] = [];
          if (recentEntries.length > 0) {
            historyParts.push(
              `[RECENT CHANGES]\n${recentEntries
                .map(
                  (e, i) =>
                    `${i + 1}. ${e.promptSummary ? `"${e.promptSummary}" → ` : ""}${e.changeSummary}`,
                )
                .join("\n")}`,
            );
          }
          if (uniqueRelevant.length > 0) {
            historyParts.push(
              `[RELEVANT PAST CONTEXT]\n${uniqueRelevant
                .map(
                  (e) =>
                    `- ${e.promptSummary ? `"${e.promptSummary}" → ` : ""}${e.changeSummary}`,
                )
                .join("\n")}`,
            );
          }

          // Build current actions (most volatile - goes at end)
          // Lists all batched actions/prompts in chronological order (1 = oldest, N = latest)
          const actionLines = actions.map((a, i) =>
            a.type === "prompt" && a.prompt
              ? `${i + 1}. Prompt: ${a.prompt}`
              : `${i + 1}. Action: ${a.action} Data: ${JSON.stringify(a.actionData, null, 0)}`,
          );
          const actionPart =
            actionLines.length > 0 ? `[NOW]\n${actionLines.join("\n")}` : null;

          // Message structure optimized for prompt caching:
          // 1. System prompt (static - always cached)
          // 2. Single user message: HTML → History → [NOW] (most volatile last)
          const userContent = [
            currentHtml ? `HTML:\n${currentHtml}` : null,
            ...historyParts,
            actionPart,
          ]
            .filter(Boolean)
            .join("\n\n");

          const messages: readonly Message[] = [
            {
              role: "system",
              content: buildSystemPrompt(
                packageInfo.length > 0 ? packageInfo : undefined,
              ),
            },
            { role: "user", content: userContent },
          ];

          // Log prompt to file if enabled
          yield* promptLogger.logMessages(messages);

          // Create validation document from current HTML (or empty)
          const validationDoc = yield* patchValidator.createValidationDocument(
            currentHtml ?? "",
          );

          // Create Refs to track state across retries
          const usageRef = yield* Ref.make<Usage[]>([]);
          const patchesRef = yield* Ref.make<Patch[]>([]);
          const modeRef = yield* Ref.make<"patches" | "full">("patches");
          const startTime = yield* DateTime.now;

          // Create the streaming pipeline with retry - TRUE STREAMING!
          const contentStream = createStreamWithRetry(
            messages,
            validationDoc,
            usageRef,
            patchesRef,
            modeRef,
            0,
            modelConfig,
            requestTools,
          );

          // Stats stream runs AFTER content stream completes
          const statsStream = Stream.fromEffect(
            Effect.gen(function* () {
              const endTime = yield* DateTime.now;
              const elapsed = DateTime.distanceDuration(startTime, endTime);
              const elapsedMs = Duration.toMillis(elapsed);
              const elapsedSeconds = elapsedMs / 1000;

              // Get accumulated usage from Ref
              const usages = yield* Ref.get(usageRef);

              const aggregatedUsage = usages.reduce<AggregatedUsage>(
                (acc, usage) => ({
                  inputTokens: acc.inputTokens + (usage.inputTokens ?? 0),
                  outputTokens: acc.outputTokens + (usage.outputTokens ?? 0),
                  totalTokens: acc.totalTokens + (usage.totalTokens ?? 0),
                  cachedTokens:
                    acc.cachedTokens +
                    (usage.inputTokenDetails?.cacheReadTokens ?? 0),
                }),
                {
                  inputTokens: 0,
                  outputTokens: 0,
                  totalTokens: 0,
                  cachedTokens: 0,
                },
              );

              yield* Effect.log("Usage", {
                usage: JSON.stringify(aggregatedUsage),
                attempts: usages.length,
              });

              const { inputTokens, outputTokens, cachedTokens } =
                aggregatedUsage;
              const cacheRate =
                inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0;
              const tokensPerSecond =
                elapsedSeconds > 0 ? outputTokens / elapsedSeconds : 0;

              // Note: Memory saving is now handled by UIService after stream completes

              yield* Effect.log("Stream completed - Token usage", {
                inputTokens,
                outputTokens,
                totalTokens: aggregatedUsage.totalTokens,
                cachedTokens,
                cacheRate: `${cacheRate.toFixed(2)}%`,
                tokensPerSecond: `${tokensPerSecond.toFixed(1)} tok/s`,
                attempts: usages.length,
              });

              const mode = yield* Ref.get(modeRef);
              const patches = yield* Ref.get(patchesRef);

              return {
                type: "stats" as const,
                cacheRate: Math.round(cacheRate),
                tokensPerSecond: Math.round(tokensPerSecond),
                mode,
                patchCount: patches.length,
              };
            }),
          );

          return pipe(contentStream, Stream.concat(statsStream));
        });

      return { streamUnified };
    }),
  },
) {}
