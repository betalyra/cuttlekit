import { Effect, Stream, pipe, DateTime, Duration, Ref } from "effect";
import { streamText } from "ai";
import { LanguageModelProvider } from "@betalyra/generative-ui-common/server";
import { StorageService } from "../storage.js";
import { accumulateLinesWithFlush } from "../../stream/utils.js";
import { PatchValidator, type Patch } from "../vdom/index.js";
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
      const { model, providerOptions } = yield* LanguageModelProvider;
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
      // Create attempt stream - uses fullStream for usage tracking
      // ============================================================
      const createAttemptStream = (
        messages: readonly Message[],
        validationDoc: Document,
        usageRef: Ref.Ref<Usage[]>
      ): Stream.Stream<UnifiedResponse, GenerationError | Error> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const result = streamText({
              model,
              messages: messages as Message[],
              providerOptions,
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
                  // Cast to access raw data - AI SDK types are incomplete
                  const raw = part as Record<string, unknown>;

                  // Capture usage from finish-step (has raw provider data with cached_tokens)
                  if (raw.type === "finish-step") {
                    const usage = raw.usage as {
                      inputTokens?: number;
                      outputTokens?: number;
                      totalTokens?: number;
                      raw?: {
                        prompt_tokens_details?: { cached_tokens?: number };
                      };
                    } | undefined;

                    if (usage) {
                      const cachedTokens =
                        usage.raw?.prompt_tokens_details?.cached_tokens ?? 0;

                      yield* Ref.update(usageRef, (usages) => [
                        ...usages,
                        {
                          inputTokens: usage.inputTokens ?? 0,
                          outputTokens: usage.outputTokens ?? 0,
                          totalTokens: usage.totalTokens ?? 0,
                          inputTokenDetails: { cacheReadTokens: cachedTokens },
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
        patchesRef: Ref.Ref<Patch[]>,
        attempt: number
      ): Stream.Stream<UnifiedResponse, Error> => {
        if (attempt >= MAX_RETRY_ATTEMPTS) {
          return Stream.fail(
            new Error(`Max retries (${MAX_RETRY_ATTEMPTS}) exceeded`)
          );
        }

        return pipe(
          createAttemptStream(messages, validationDoc, usageRef),

          // Track successful patches and log
          Stream.tap((response) =>
            Effect.gen(function* () {
              if (response.type === "patches") {
                yield* Ref.update(patchesRef, (ps) => [...ps, ...response.patches]);
              }
              yield* Effect.log(`[Attempt ${attempt}] Emitting response`, {
                type: response.type,
              });
            })
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
                yield* Effect.log(`[Attempt ${attempt}] ${genError._tag}, retrying...`, {
                  error: genError.message,
                  successfulPatches: successfulPatches.length,
                });

                return Stream.concat(
                  Stream.empty,
                  createStreamWithRetry(
                    [...messages, { role: "user", content: buildCorrectivePrompt(genError, successfulPatches) }],
                    validationDoc,
                    usageRef,
                    patchesRef,
                    attempt + 1
                  )
                );
              })
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

          // Create Refs to track state across retries
          const usageRef = yield* Ref.make<Usage[]>([]);
          const patchesRef = yield* Ref.make<Patch[]>([]);
          const startTime = yield* DateTime.now;

          // Create the streaming pipeline with retry - TRUE STREAMING!
          const contentStream = createStreamWithRetry(
            messages,
            validationDoc,
            usageRef,
            patchesRef,
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
                cacheRate: `${cacheRate.toFixed(2)}%`,
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
