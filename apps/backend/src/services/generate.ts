import { Effect, Stream, pipe, DateTime, Duration, Option, Either } from "effect";
import { streamText, type LanguageModelMiddleware } from "ai";
import { z } from "zod";
import { LlmProvider } from "@betalyra/generative-ui-common/server";
import { StorageService } from "./storage.js";
import { accumulateLinesWithFlush } from "../stream/utils.js";
import { PatchValidator, PatchValidationError } from "./patch-validator.js";

// Logging middleware to inspect prompts sent to LLM
const loggingMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v3",
  wrapStream: async ({ doStream, params }) => {
    console.log("=== LLM Request ===");
    console.log("Prompt:", JSON.stringify(params, null, 2));
    return doStream();
  },
};

// Wrap async iterable to handle AI SDK cleanup errors gracefully
async function* safeAsyncIterable<T>(
  iterable: AsyncIterable<T>
): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    while (true) {
      const { done, value } = await iterator.next();
      if (done) return;
      yield value;
    }
  } finally {
    try {
      await iterator.return?.();
    } catch {
      // Ignore - AI SDK throws when reader is detached during cleanup
    }
  }
}

// Zod schema for patches - matches the Patch type
const PatchSchema = z.union([
  z.object({ selector: z.string(), text: z.string() }),
  z.object({
    selector: z.string(),
    attr: z.record(z.string(), z.string().nullable()),
  }),
  z.object({ selector: z.string(), append: z.string() }),
  z.object({ selector: z.string(), prepend: z.string() }),
  z.object({ selector: z.string(), html: z.string() }),
  z.object({ selector: z.string(), remove: z.literal(true) }),
]);

const PatchArraySchema = z.array(PatchSchema);

// Unified response schema - AI decides the type
const UnifiedResponseSchema = z.union([
  z.object({
    type: z.literal("patches"),
    patches: PatchArraySchema,
  }),
  z.object({
    type: z.literal("full"),
    html: z.string(),
  }),
  z.object({
    type: z.literal("stats"),
    cacheRate: z.number(), // percentage 0-100
    tokensPerSecond: z.number(),
  }),
]);

export type UnifiedResponse = z.infer<typeof UnifiedResponseSchema>;

// ============================================================
// Retry Types - Immutable state for functional retry loop
// ============================================================

type Message = { readonly role: "system" | "user" | "assistant"; readonly content: string };

// Result of a single stream attempt - either success or validation failure with partial results
type AttemptResult =
  | { readonly _tag: "Success"; readonly responses: readonly UnifiedResponse[] }
  | { readonly _tag: "ValidationFailed"; readonly validResponses: readonly UnifiedResponse[]; readonly error: PatchValidationError };

// Stream item during processing - error as data pattern
type StreamItemResponse = { readonly _tag: "Response"; readonly response: UnifiedResponse; readonly collected: readonly UnifiedResponse[] };
type StreamItemError = { readonly _tag: "Error"; readonly error: PatchValidationError; readonly collected: readonly UnifiedResponse[] };
type StreamItem = StreamItemResponse | StreamItemError;

const MAX_RETRY_ATTEMPTS = 3;

// Build corrective prompt for retry after validation failure
const buildCorrectivePrompt = (error: PatchValidationError): string =>
  `ERROR: Patch validation failed for selector "${error.patch.selector}": ${error.message}
Reason: ${error.reason}
Please fix the patch and continue. Remember:
- Selectors must exist in the current HTML
- If the element doesn't exist yet, create it first with a "full" response or parent patch
- Use only #id selectors, not class or tag selectors`;

// Streaming system prompt - compact but complete
const STREAMING_PATCH_PROMPT = `You are a Generative UI Engine.

OUTPUT: JSONL, one JSON per line with "type" field. Stream multiple small lines, NOT one big line.
{"type":"patches","patches":[...]} - 1-3 patches per line MAX. Many changes = many lines.
{"type":"full","html":"..."} - only when no HTML exists or 50%+ restructure needed

JSON ESCAPING: Use single quotes for HTML attributes to avoid escaping.
CORRECT: {"html":"<div class='flex'>"}
WRONG: {"html":"<div class=\\"flex\\">"}

PATCH FORMAT (exact JSON, #id selectors only):
{"selector":"#id","text":"plain text"} - textContent, NO HTML
{"selector":"#id","html":"<p>HTML</p>"} - innerHTML with HTML
{"selector":"#id","attr":{"class":"x"}} - change attributes
{"selector":"#id","append":"<li>new</li>"} - add to end
{"selector":"#id","prepend":"<li>new</li>"} - add to start
{"selector":"#id","remove":true} - delete element

HTML RULES:
- Raw HTML only, no markdown/code blocks, no html/head/body/script/style tags
- Start with <div>, style with Tailwind CSS
- Light mode (#fafafa bg, #0a0a0a text), minimal brutalist, generous whitespace

INTERACTIVITY - NO JavaScript/onclick (won't work):
- Buttons: <button id="inc-btn" data-action="increment">+</button>
- With data: <button id="del-1" data-action="delete" data-action-data="{&quot;id&quot;:&quot;1&quot;}">Delete</button>
- Inputs: <input id="filter" data-action="filter"> (triggers on change)
- Checkbox: <input type="checkbox" id="todo-1-cb" data-action="toggle" data-action-data="{&quot;id&quot;:&quot;1&quot;}">
- Select: <select id="sort" data-action="sort"><option value="asc">Asc</option></select>
- Radio: <input type="radio" name="prio" id="prio-high" data-action="set-prio" data-action-data="{&quot;level&quot;:&quot;high&quot;}">
Use &quot; for JSON in data-action-data. Input values auto-sent with actions.

IDs REQUIRED: All interactive/dynamic elements need unique id. Containers: id="todo-list". Items: id="todo-1". Buttons: id="add-btn".

ICONS: <iconify-icon icon="mdi:plus"></iconify-icon> Any Iconify set (mdi, lucide, tabler, ph, etc). Use sparingly.

FONTS: Any Fontsource font via style="font-family: 'FontName'". Default Inter. Common: Roboto, Libre Baskerville, JetBrains Mono, Space Grotesk, Poppins.`;

export type UnifiedGenerateOptions = {
  sessionId: string;
  currentHtml?: string;
  prompt?: string;
  action?: string;
  actionData?: Record<string, unknown>;
};

export class GenerateService extends Effect.Service<GenerateService>()(
  "GenerateService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const llm = yield* LlmProvider;
      const storage = yield* StorageService;
      const patchValidator = yield* PatchValidator;

      // ============================================================
      // Parse JSON line - pure function
      // ============================================================
      const parseJsonLine = (line: string) =>
        Effect.try({
          try: () => {
            const parsed = JSON.parse(line);

            // Try parsing as UnifiedResponse first
            const unifiedResult = UnifiedResponseSchema.safeParse(parsed);
            if (unifiedResult.success) {
              return unifiedResult.data;
            }

            // Fallback: check if it's a raw patch and wrap it
            const patchResult = PatchSchema.safeParse(parsed);
            if (patchResult.success) {
              return {
                type: "patches" as const,
                patches: [patchResult.data],
              };
            }

            // Neither valid - throw with details
            throw new Error(
              `Invalid response format: ${unifiedResult.error.message}`
            );
          },
          catch: (error) =>
            error instanceof Error
              ? error
              : new Error(`Failed to parse JSON line: ${line}`),
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
            Stream.mapEffect(parseJsonLine),
            Stream.mapAccumEffect(
              [] as readonly UnifiedResponse[],
              (collected, response): Effect.Effect<readonly [readonly UnifiedResponse[], StreamItem], never, never> =>
                Effect.gen(function* () {
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
      type IterateState = {
        readonly attempt: number;
        readonly messages: readonly Message[];
        readonly allResponses: readonly UnifiedResponse[];
        readonly done: boolean;
        readonly lastError?: PatchValidationError;
        readonly usagePromises: readonly PromiseLike<unknown>[];
      };

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

                // Validation failed - prepare retry with corrective prompt
                yield* Effect.log("Validation failed, preparing retry", {
                  attempt: state.attempt + 1,
                  error: result.error.message,
                  selector: result.error.patch.selector,
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

              type Usage = {
                inputTokens?: number;
                outputTokens?: number;
                totalTokens?: number;
                inputTokenDetails?: { cacheReadTokens?: number };
              };

              type AggregatedUsage = {
                inputTokens: number;
                outputTokens: number;
                totalTokens: number;
                cachedTokens: number;
              };

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
