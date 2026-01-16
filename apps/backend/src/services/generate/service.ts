import { Effect, Stream, pipe, DateTime, Duration, Option, Either } from "effect";
import { streamText } from "ai";
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
  type AttemptResult,
  type StreamItem,
  type IterateState,
  type Usage,
  type AggregatedUsage,
  MAX_RETRY_ATTEMPTS,
  STREAMING_PATCH_PROMPT,
  buildCorrectivePrompt,
  safeAsyncIterable,
} from "./index.js";

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
      // Run single attempt - streams and validates with error-as-data
      // ============================================================
      const runAttempt = (
        messages: readonly Message[],
        validationDoc: Document
      ) =>
        Effect.gen(function* () {
          const wrappedModel = llm.provider.languageModel("openai/gpt-oss-120b");

          const result = streamText({
            model: wrappedModel,
            messages: messages as Message[],
            providerOptions: {
              openai: { streamOptions: { includeUsage: true } },
            },
          });

          // Token stream from LLM
          const tokenStream = Stream.fromAsyncIterable(
            safeAsyncIterable(result.textStream),
            (error) =>
              error instanceof Error
                ? error
                : new Error(`Stream error: ${String(error)}`)
          );

          // Process stream with mapAccumEffect - error as data pattern
          // State: accumulated valid responses
          // Output: StreamItem (either Response or Error)
          const processedStream = pipe(
            tokenStream,
            accumulateLinesWithFlush,
            Stream.tap((line) => Effect.log("Line", { line })),
            Stream.mapAccumEffect(
              [] as readonly UnifiedResponse[],
              (collected, line): Effect.Effect<readonly [readonly UnifiedResponse[], StreamItem], never, never> =>
                Effect.gen(function* () {
                  // Parse JSON line - catch errors as data
                  const parseResult = yield* parseJsonLine(line).pipe(Effect.either);

                  if (Either.isLeft(parseResult)) {
                    // JSON parsing failed - emit error with collected responses
                    const item: StreamItem = {
                      _tag: "Error",
                      error: parseResult.left,
                      collected,
                    };
                    return [collected, item] as const;
                  }

                  const response = parseResult.right;

                  // Validate patches
                  if (response.type === "patches") {
                    const validationResult = yield* patchValidator
                      .validateAll(validationDoc, response.patches)
                      .pipe(Effect.either);

                    if (Either.isLeft(validationResult)) {
                      // Validation failed - emit error with collected responses
                      const item: StreamItem = {
                        _tag: "Error",
                        error: validationResult.left,
                        collected,
                      };
                      return [collected, item] as const;
                    }
                  }

                  // Valid response - accumulate
                  const newCollected = [...collected, response];
                  const item: StreamItem = {
                    _tag: "Response",
                    response,
                    collected: newCollected,
                  };
                  return [newCollected, item] as const;
                })
            ),
            // Stop at first error
            Stream.takeUntil((item: StreamItem) => item._tag === "Error")
          );

          // Run stream and get last item (contains full state)
          const lastItem = yield* pipe(processedStream, Stream.runLast);

          const attemptResult: AttemptResult = Option.match(lastItem, {
            onNone: () => ({ _tag: "Success" as const, responses: [] as readonly UnifiedResponse[] }),
            onSome: (item: StreamItem) =>
              item._tag === "Error"
                ? {
                    _tag: "ValidationFailed" as const,
                    validResponses: item.collected,
                    error: item.error,
                  }
                : { _tag: "Success" as const, responses: item.collected },
          });

          return { ...attemptResult, usagePromise: result.usage };
        });

      // ============================================================
      // Run with retry - functional retry loop using Effect.iterate
      // ============================================================
      const runWithRetry = (
        initialMessages: readonly Message[],
        validationDoc: Document
      ) =>
        Effect.gen(function* () {
          const initialState: IterateState = {
            attempt: 0,
            messages: initialMessages,
            allResponses: [],
            done: false,
            usagePromises: [],
          };

          const finalState = yield* Effect.iterate(initialState, {
            while: (s): s is IterateState => !s.done && s.attempt < MAX_RETRY_ATTEMPTS,
            body: (state): Effect.Effect<IterateState, Error> =>
              Effect.gen(function* () {
                yield* Effect.log("Running generation attempt", {
                  attempt: state.attempt + 1,
                  maxAttempts: MAX_RETRY_ATTEMPTS,
                });

                const result = yield* runAttempt(state.messages, validationDoc);

                if (result._tag === "Success") {
                  // All patches validated - done!
                  yield* Effect.log("Attempt succeeded", {
                    responseCount: result.responses.length,
                  });
                  return {
                    ...state,
                    allResponses: [...state.allResponses, ...result.responses],
                    done: true,
                    usagePromises: [...state.usagePromises, result.usagePromise],
                  } satisfies IterateState;
                }

                // Generation failed - prepare retry with corrective prompt
                const errorDetails =
                  result.error._tag === "JsonParseError"
                    ? { type: "json_parse", line: result.error.line.slice(0, 100) }
                    : { type: "validation", selector: result.error.patch.selector, reason: result.error.reason };

                yield* Effect.log("Generation failed, preparing retry", {
                  attempt: state.attempt + 1,
                  error: result.error.message,
                  ...errorDetails,
                  validResponsesCollected: result.validResponses.length,
                });

                const correctiveMessage: Message = {
                  role: "user",
                  content: buildCorrectivePrompt(result.error),
                };

                return {
                  attempt: state.attempt + 1,
                  messages: [...state.messages, correctiveMessage],
                  allResponses: [...state.allResponses, ...result.validResponses],
                  done: false,
                  lastError: result.error,
                  usagePromises: [...state.usagePromises, result.usagePromise],
                } satisfies IterateState;
              }),
          });

          // Check if we exhausted retries without success
          if (!finalState.done && finalState.lastError) {
            yield* Effect.log("Max retries exceeded", {
              attempts: finalState.attempt,
              lastError: finalState.lastError.message,
            });
            return yield* Effect.fail(
              new Error(
                `Max retries (${MAX_RETRY_ATTEMPTS}) exceeded. Last error: ${finalState.lastError.message}`
              )
            );
          }

          return {
            responses: finalState.allResponses,
            usagePromises: finalState.usagePromises,
          };
        });

      // ============================================================
      // Main entry point - streamUnified
      // ============================================================
      const streamUnified = (
        options: UnifiedGenerateOptions
      ): Effect.Effect<Stream.Stream<UnifiedResponse, never>, Error> =>
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

          const startTime = yield* DateTime.now;

          // Run generation with retry
          const { responses, usagePromises } = yield* runWithRetry(
            messages,
            validationDoc
          );

          // Content stream from collected responses
          const contentStream = pipe(
            Stream.fromIterable(responses),
            Stream.tap((response) =>
              Effect.logDebug("Emitting response", {
                response: JSON.stringify(response),
              })
            )
          );

          // Stats stream - aggregates usage from all attempts
          const statsStream = Stream.fromEffect(
            Effect.gen(function* () {
              const endTime = yield* DateTime.now;
              const elapsed = DateTime.distanceDuration(startTime, endTime);
              const elapsedMs = Duration.toMillis(elapsed);
              const elapsedSeconds = elapsedMs / 1000;

              // Aggregate usage from all attempts
              const usages = yield* Effect.promise(() =>
                Promise.all(usagePromises)
              );

              const initialUsage: AggregatedUsage = {
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                cachedTokens: 0,
              };

              const aggregatedUsage = (usages as Usage[]).reduce<AggregatedUsage>(
                (acc, usage) => ({
                  inputTokens: acc.inputTokens + (usage.inputTokens ?? 0),
                  outputTokens: acc.outputTokens + (usage.outputTokens ?? 0),
                  totalTokens: acc.totalTokens + (usage.totalTokens ?? 0),
                  cachedTokens:
                    acc.cachedTokens +
                    (usage.inputTokenDetails?.cacheReadTokens ?? 0),
                }),
                initialUsage
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
