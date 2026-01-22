import { Effect, Stream, pipe, DateTime, Duration, Ref } from "effect";
import { streamText, type TextStreamPart, type LanguageModelUsage } from "ai";
import { LlmProvider } from "@betalyra/generative-ui-common/server";
import { StorageService } from "../storage.js";
import { accumulateLinesWithFlush } from "../../stream/utils.js";
import { PatchValidator } from "../vdom/index.js";
import {
  PatchSchema,
  UnifiedResponseSchema,
  JsonParseError,
  type UnifiedResponse,
  type UnifiedGenerateOptions,
  type Message,
  type Usage,
  type AggregatedUsage,
  MAX_RETRY_ATTEMPTS,
  STREAMING_PATCH_PROMPT,
  buildCorrectivePrompt,
  safeAsyncIterable,
} from "./index.js";
import type { GenerationError } from "./errors.js";

export class GenerateService extends Effect.Service<GenerateService>()(
  "GenerateService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const llm = yield* LlmProvider;
      const storage = yield* StorageService;
      const patchValidator = yield* PatchValidator;

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

          // Try parsing as UnifiedResponse first
          const unifiedResult = UnifiedResponseSchema.safeParse(parseResult);
          if (unifiedResult.success) {
            return unifiedResult.data;
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
            message: `Invalid response format: ${unifiedResult.error.message}`,
          });
        });

      // ============================================================
      // Parse and validate a JSON line - fails with GenerationError
      // ============================================================
      const parseAndValidate = (
        line: string,
        validationDoc: Document
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
      // Convert AI SDK LanguageModelUsage to our Usage type
      // ============================================================
      const convertUsage = (sdkUsage: LanguageModelUsage): Usage => ({
        inputTokens: sdkUsage.inputTokens ?? 0,
        outputTokens: sdkUsage.outputTokens ?? 0,
        totalTokens: sdkUsage.totalTokens ?? 0,
        inputTokenDetails: {
          cacheReadTokens: sdkUsage.inputTokenDetails?.cacheReadTokens ?? 0,
        },
      });

      // ============================================================
      // Create attempt stream - uses fullStream for usage tracking
      // ============================================================
      const createAttemptStream = (
        messages: readonly Message[],
        validationDoc: Document,
        usageRef: Ref.Ref<Usage[]>
      ): Stream.Stream<UnifiedResponse, GenerationError | Error> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const wrappedModel = llm.provider.languageModel("openai/gpt-oss-120b");

            const result = streamText({
              model: wrappedModel,
              messages: messages as Message[],
              providerOptions: {
                openai: { streamOptions: { includeUsage: true } },
              },
            });

            // Use fullStream to get both text AND usage events
            const fullStream = Stream.fromAsyncIterable(
              safeAsyncIterable(result.fullStream),
              (error) =>
                error instanceof Error
                  ? error
                  : new Error(`Stream error: ${String(error)}`)
            );

            return pipe(
              fullStream,
              // Extract text from text-delta, track usage from finish
              Stream.mapEffect((part) =>
                Effect.gen(function* () {
                  const p = part as TextStreamPart<Record<string, never>>;
                  if (p.type === "finish" && p.totalUsage) {
                    // Track usage when we see the finish event
                    yield* Ref.update(usageRef, (usages) => [
                      ...usages,
                      convertUsage(p.totalUsage),
                    ]);
                    return null; // Don't emit finish event as text
                  }
                  if (p.type === "text-delta") {
                    return p.text;
                  }
                  return null; // Ignore other event types
                })
              ),
              // Filter out nulls (non-text events)
              Stream.filter((text): text is string => text !== null),
              // Accumulate text into lines
              accumulateLinesWithFlush,
              Stream.tap((line) => Effect.log("Line", { line })),
              // Parse and validate each line
              Stream.mapEffect((line) => parseAndValidate(line, validationDoc))
            );
          })
        );

      // ============================================================
      // Create stream with retry - uses catchAll for seamless recovery
      // ============================================================
      const createStreamWithRetry = (
        messages: readonly Message[],
        validationDoc: Document,
        usageRef: Ref.Ref<Usage[]>,
        attempt: number
      ): Stream.Stream<UnifiedResponse, Error> => {
        if (attempt >= MAX_RETRY_ATTEMPTS) {
          return Stream.fail(
            new Error(`Max retries (${MAX_RETRY_ATTEMPTS}) exceeded`)
          );
        }

        return pipe(
          createAttemptStream(messages, validationDoc, usageRef),

          // Log successful emissions
          Stream.tap((response) =>
            Effect.log(`[Attempt ${attempt}] Emitting response`, {
              type: response.type,
            })
          ),

          // THE KEY: catchAll intercepts errors and retries on GenerationError
          Stream.catchAll((error: GenerationError | Error) => {
            // Only retry on GenerationError (tagged errors with _tag)
            if (!("_tag" in error)) {
              return Stream.fail(error);
            }

            const genError = error as GenerationError;
            return pipe(
              Stream.fromEffect(
                Effect.log(`[Attempt ${attempt}] ${genError._tag}, retrying...`, {
                  error: genError.message,
                })
              ),
              Stream.drain,
              Stream.concat(
                createStreamWithRetry(
                  [...messages, { role: "user", content: buildCorrectivePrompt(genError) }],
                  validationDoc,
                  usageRef,
                  attempt + 1
                )
              )
            );
          })
        );
      };

      // ============================================================
      // Main entry point - streamUnified
      // ============================================================
      const streamUnified = (
        options: UnifiedGenerateOptions
      ): Effect.Effect<Stream.Stream<UnifiedResponse, Error>, never> =>
        Effect.gen(function* () {
          yield* Effect.log("Streaming unified response", {
            action: options.action,
            prompt: options.prompt,
            hasCurrentHtml: !!options.currentHtml,
          });

          const { sessionId, currentHtml, prompt, action, actionData } = options;

          // Fetch prompts and actions separately for optimal caching
          const [recentPrompts, recentActions] = yield* Effect.all([
            storage
              .getRecentPrompts(sessionId, 3)
              .pipe(Effect.catchAll(() => Effect.succeed([] as const))),
            storage
              .getRecentActions(sessionId, 5)
              .pipe(Effect.catchAll(() => Effect.succeed([] as const))),
          ]);

          // Build history (context only, not to act on)
          const historyParts: string[] = [];
          if (recentPrompts.length > 0) {
            historyParts.push(
              `[HISTORY] Prompts: ${recentPrompts.map((p) => p.content).join("; ")}`
            );
          }
          if (recentActions.length > 0) {
            historyParts.push(
              `[HISTORY] Actions: ${recentActions.map((a) => a.action).join(", ")}`
            );
          }

          // Build current request
          const currentParts: string[] = [];
          if (currentHtml) {
            currentParts.push(`HTML:\n${currentHtml}`);
          }
          if (action) {
            currentParts.push(
              `[NOW] Action: ${action} Data: ${JSON.stringify(actionData, null, 0)}`
            );
          } else if (prompt) {
            currentParts.push(`[NOW] Prompt: ${prompt}`);
          }

          const messages: readonly Message[] = [
            { role: "system", content: STREAMING_PATCH_PROMPT },
            ...(historyParts.length > 0
              ? [{ role: "user" as const, content: historyParts.join("\n") }]
              : []),
            { role: "user", content: currentParts.join("\n\n") },
          ];

          // Create validation document from current HTML (or empty)
          const validationDoc = yield* patchValidator.createValidationDocument(
            currentHtml ?? ""
          );

          // Create Ref to track usage across retries
          const usageRef = yield* Ref.make<Usage[]>([]);
          const startTime = yield* DateTime.now;

          // Create the streaming pipeline with retry - TRUE STREAMING!
          const contentStream = createStreamWithRetry(
            messages,
            validationDoc,
            usageRef,
            0
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
                { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0 }
              );

              yield* Effect.log("Usage", {
                usage: JSON.stringify(aggregatedUsage),
                attempts: usages.length,
              });

              const { inputTokens, outputTokens, cachedTokens } = aggregatedUsage;
              const cacheRate =
                inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0;
              const tokensPerSecond =
                elapsedSeconds > 0 ? outputTokens / elapsedSeconds : 0;

              // Store prompt and action separately for optimal caching
              if (prompt) {
                yield* storage
                  .addPrompt(sessionId, prompt)
                  .pipe(Effect.catchAll(() => Effect.void));
              }
              if (action) {
                yield* storage
                  .addAction(sessionId, action, actionData)
                  .pipe(Effect.catchAll(() => Effect.void));
              }

              yield* Effect.log("Stream completed - Token usage", {
                inputTokens,
                outputTokens,
                totalTokens: aggregatedUsage.totalTokens,
                cachedTokens,
                cacheRate: `${cacheRate.toFixed(1)}%`,
                tokensPerSecond: `${tokensPerSecond.toFixed(1)} tok/s`,
                attempts: usages.length,
              });

              return {
                type: "stats" as const,
                cacheRate: Math.round(cacheRate),
                tokensPerSecond: Math.round(tokensPerSecond),
              };
            })
          );

          return pipe(contentStream, Stream.concat(statsStream));
        });

      return { streamUnified };
    }),
  }
) {}
