import { Effect, Stream, pipe, DateTime, Duration } from "effect";
import { streamText, type LanguageModelMiddleware } from "ai";
import { z } from "zod";
import { LlmProvider } from "@betalyra/generative-ui-common/server";
import { StorageService } from "./storage.js";
import { accumulateLinesWithFlush } from "../stream/utils.js";
import { PatchValidator } from "./patch-validator.js";

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

// NOTE: Retry mechanism will be implemented in the processor layer (see docs/PROCESSOR.md)
// For now, validation fails fast and the stream stops on first invalid patch.

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

      const streamUnified = (
        options: UnifiedGenerateOptions
      ): Effect.Effect<Stream.Stream<UnifiedResponse, Error>> =>
        Effect.gen(function* () {
          yield* Effect.log("Streaming unified response", {
            action: options.action,
            prompt: options.prompt,
            hasCurrentHtml: !!options.currentHtml,
          });

          const { sessionId, currentHtml, prompt, action, actionData } =
            options;

          // Fetch prompts and actions separately for optimal caching
          // Prompts change rarely after creation, actions change frequently
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
              `[HISTORY] Prompts: ${recentPrompts
                .map((p) => p.content)
                .join("; ")}`
            );
          }
          if (recentActions.length > 0) {
            historyParts.push(
              `[HISTORY] Actions: ${recentActions
                .map((a) => a.action)
                .join(", ")}`
            );
          }

          // Build current request
          const currentParts: string[] = [];
          if (currentHtml) {
            currentParts.push(`HTML:\n${currentHtml}`);
          }
          if (action) {
            currentParts.push(
              `[NOW] Action: ${action} Data: ${JSON.stringify(
                actionData,
                null,
                0
              )}`
            );
          } else if (prompt) {
            currentParts.push(`[NOW] Prompt: ${prompt}`);
          }

          const messages = [
            { role: "system" as const, content: STREAMING_PATCH_PROMPT },
            ...(historyParts.length > 0
              ? [{ role: "user" as const, content: historyParts.join("\n") }]
              : []),
            { role: "user" as const, content: currentParts.join("\n\n") },
          ];

          // const wrappedModel = wrapLanguageModel({
          //   model: llm.provider.languageModel("openai/gpt-oss-120b"),
          //   middleware: loggingMiddleware,
          // });
          const wrappedModel = llm.provider.languageModel(
            "openai/gpt-oss-120b"
          );

          const startTime = yield* DateTime.now;

          const result = streamText({
            model: wrappedModel,
            messages,

            providerOptions: {
              openai: {
                streamOptions: { includeUsage: true },
              },
            },
          });

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

          // Token stream from LLM
          const tokenStream = Stream.fromAsyncIterable(
            safeAsyncIterable(result.textStream),
            (error) =>
              error instanceof Error
                ? error
                : new Error(`Stream error: ${String(error)}`)
          );

          // Create validation document from current HTML (or empty)
          const validationDoc = yield* patchValidator.createValidationDocument(
            currentHtml ?? ""
          );

          const contentStream = pipe(
            tokenStream,
            accumulateLinesWithFlush,
            Stream.tap((line) => Effect.log("Line", { line })),
            // Parse each line as JSON
            Stream.mapEffect((line) => parseJsonLine(line)),
            // Validate patches before emitting (fail-fast)
            Stream.mapEffect((response) =>
              Effect.gen(function* () {
                if (response.type === "patches") {
                  yield* patchValidator
                    .validateAll(validationDoc, response.patches)
                    .pipe(
                      Effect.mapError(
                        (err) =>
                          new Error(
                            `Patch validation failed: ${err.message} (${err.reason})`
                          )
                      )
                    );
                }
                return response;
              })
            ),
            // Log parsed response
            Stream.tap((response) =>
              Effect.logDebug("Parsed response", {
                response: JSON.stringify(response),
              })
            )
          );

          // Stats event emitted after content stream completes
          const statsStream = Stream.fromEffect(
            Effect.gen(function* () {
              const endTime = yield* DateTime.now;
              const elapsed = DateTime.distanceDuration(startTime, endTime);
              const elapsedMs = Duration.toMillis(elapsed);
              const elapsedSeconds = elapsedMs / 1000;

              const usage = yield* Effect.promise(() => result.usage);
              yield* Effect.log("Usage", { usage: JSON.stringify(usage) });

              const inputTokens = usage.inputTokens ?? 0;
              const outputTokens = usage.outputTokens ?? 0;
              const cachedTokens =
                usage.inputTokenDetails?.cacheReadTokens ?? 0;
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
                totalTokens: usage.totalTokens ?? 0,
                cachedTokens,
                cacheRate: `${cacheRate.toFixed(1)}%`,
                tokensPerSecond: `${tokensPerSecond.toFixed(1)} tok/s`,
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
