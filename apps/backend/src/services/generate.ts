import { Array as A, Effect, Stream, pipe } from "effect";
import { generateText, ModelMessage, TextPart, streamText } from "ai";
import { z } from "zod";
import { LlmProvider } from "./llm.js";
import { StorageService } from "./storage.js";
import type { Patch } from "./vdom.js";

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

// Unified response schema - AI decides the mode
const UnifiedResponseSchema = z.union([
  z.object({
    mode: z.literal("patches"),
    patches: PatchArraySchema,
  }),
  z.object({
    mode: z.literal("full"),
    html: z.string(),
  }),
]);

export type UnifiedResponse = z.infer<typeof UnifiedResponseSchema>;

export type GenerateOptions = {
  prompt?: string;
  action?: string;
  actionData?: Record<string, unknown>;
  currentHtml?: string;
};

export type GeneratePatchesOptions = {
  currentHtml: string;
  action: string;
  actionData?: Record<string, unknown>;
  previousErrors?: string[];
};

// Static system prompt for full HTML generation - cacheable prefix
const FULL_HTML_SYSTEM_PROMPT = `You are a Generative UI Engine that creates interactive web interfaces.

TECHNICAL REQUIREMENTS:
- Return ONLY raw HTML - no markdown, no code blocks
- Do NOT include <html>, <head>, <body>, <script>, or <style> tags
- Start directly with a <div> element
- Style with Tailwind CSS utility classes

INTERACTIVITY:
Use data-action attributes for interactive elements:

Buttons (triggered on click):
- <button data-action="increment">+</button>
- <button id="delete-123" data-action="delete" data-action-data="{&quot;id&quot;:&quot;123&quot;}">Delete</button>

Form inputs (triggered on change):
- <input type="checkbox" id="todo-1-checkbox" data-action="toggle" data-action-data="{&quot;id&quot;:&quot;1&quot;}">
- <select id="filter" data-action="filter"><option value="all">All</option></select>
- <input type="radio" name="priority" data-action="set-priority" data-action-data="{&quot;level&quot;:&quot;high&quot;}">

All input values are automatically collected and sent with actions.

CRITICAL - UNIQUE IDs:
ALWAYS add unique id attributes to ALL interactive and dynamic elements:
- List containers: id="todo-list", id="cart-items" (required for append/prepend operations)
- List items: id="todo-1", id="todo-2"
- Checkboxes: id="todo-1-checkbox", id="todo-2-checkbox"
- Buttons with data: id="delete-1", id="toggle-1"
- Any element that might be updated: id="counter-value", id="status-text"
This is REQUIRED for the patch system to work correctly. Never rely on complex attribute selectors.

CRITICAL - JSON IN ATTRIBUTES:
When using data-action-data, use HTML entities for quotes:
- CORRECT: data-action-data="{&quot;id&quot;:&quot;4&quot;}"
- WRONG: data-action-data='{"id":"4"}' or data-action-data="{\"id\":\"4\"}"
Always use &quot; for quotes inside attribute values.

ICONS:
Use Iconify web component for icons (loaded on-demand):
- <iconify-icon icon="mdi:home"></iconify-icon>
- <iconify-icon icon="lucide:search" width="20"></iconify-icon>
- <iconify-icon icon="tabler:plus" class="text-blue-500"></iconify-icon>

Popular icon sets:
- mdi: Material Design Icons (mdi:home, mdi:account, mdi:cog, mdi:delete, mdi:plus)
- lucide: Lucide Icons (lucide:search, lucide:menu, lucide:x, lucide:check)
- tabler: Tabler Icons (tabler:plus, tabler:trash, tabler:edit, tabler:settings)
- ph: Phosphor Icons (ph:house, ph:user, ph:gear)

Icons inherit text color via currentColor. Size with width/height attributes or Tailwind classes.
Use icons sparingly to enhance UX, not decorate.

FONTS:
Use any Google Font or open-source font by name (loaded on-demand from Fontsource CDN):
- Inter, Roboto, Open Sans (clean sans-serif)
- Playfair Display, Merriweather (elegant serif)
- JetBrains Mono, Fira Code (monospace)
- Space Grotesk, Poppins (modern geometric)

Example: style="font-family: 'Space Grotesk', sans-serif"

Stick to Inter unless a specific aesthetic is requested.

Design: Light mode (#fafafa background, #0a0a0a text), minimal brutalist UI, generous whitespace, no decorative elements.

Output only HTML, nothing else.`;

// Static system prompt for patch generation - cacheable prefix
const PATCH_SYSTEM_PROMPT = `You are a UI Patch Engine. Generate minimal patches to update the UI.

PATCH TYPES:
- { "selector": "#id", "text": "new text" } - Set text content
- { "selector": ".class", "html": "<div>...</div>" } - Replace innerHTML
- { "selector": "#id", "attr": { "class": "new-class", "disabled": "true" } } - Set attributes
- { "selector": "#id", "attr": { "checked": null } } - Remove attribute (use null to uncheck checkboxes)
- { "selector": "#list", "append": "<li>new item</li>" } - Append child HTML
- { "selector": "#list", "prepend": "<li>new item</li>" } - Prepend child HTML
- { "selector": "#item", "remove": true } - Remove element

RULES:
1. Output ONLY a valid JSON array of patches
2. ALWAYS check the CURRENT HTML for actual element IDs - don't assume IDs exist
3. Use simple ID selectors like "#todo-1", "#counter-value", "#todo-list"
4. NEVER use complex attribute selectors like [data-action-data='{"id":"1"}'] - they will FAIL
5. If an element lacks an ID, use the closest parent with an ID + child selector (e.g., "#todo-list ul")
6. Keep patches minimal - only change what's needed
7. For counters/numbers: just update the text content
8. For lists: use append/prepend to add items, remove to delete
9. For checkboxes: use "#todo-1-checkbox" not input[data-action="toggle"]
10. For boolean attributes (checked, disabled): use "checked" to set, null to remove

Example for checking a checkbox:
[{"selector": "#todo-1-checkbox", "attr": {"checked": "checked"}}]

Example for unchecking a checkbox (use null to remove the attribute):
[{"selector": "#todo-1-checkbox", "attr": {"checked": null}}]

Example for incrementing a counter with current value "5":
[{"selector": "#counter-value", "text": "6"}]

Example for adding a todo (note: use &quot; for JSON in attributes):
[{"selector": "#todo-list", "append": "<li id=\\"todo-4\\"><input type=\\"checkbox\\" id=\\"todo-4-checkbox\\" data-action=\\"toggle\\" data-action-data=\\"{&quot;id&quot;:&quot;4&quot;}\\"> New task</li>"}]

Example for deleting a todo:
[{"selector": "#todo-1", "remove": true}]

Output ONLY the JSON array, no explanation, no markdown.`;

// Streaming system prompt - outputs patches as minified JSON lines
const STREAMING_PATCH_PROMPT = `You are a UI Patch Engine. Generate minimal patches to update the UI.

OUTPUT FORMAT:
Output one minified JSON object per line. Each line must be a complete, valid JSON object:
{"mode":"patches","patches":[{"selector":"#id","text":"new value"}]}
{"mode":"patches","patches":[{"selector":"#list","append":"<li>item</li>"}]}

RULES:
- Each line is a SEPARATE batch of patches that can be applied immediately
- Keep each line minimal - group related patches together
- NO spaces or formatting - minified JSON only
- Each line must end with a newline character

PATCH TYPES:
- {"selector":"#id","text":"new text"} - Set text content
- {"selector":"#id","html":"<div>...</div>"} - Replace innerHTML
- {"selector":"#id","attr":{"class":"x","disabled":null}} - Set/remove attributes
- {"selector":"#list","append":"<li>...</li>"} - Append child
- {"selector":"#list","prepend":"<li>...</li>"} - Prepend child
- {"selector":"#id","remove":true} - Remove element

SELECTOR RULES:
- Use simple ID selectors (#id) - complex selectors will fail
- Check the CURRENT HTML for actual element IDs before patching
- For checkboxes: use attr with "checked":"checked" to check, "checked":null to uncheck

HTML IN PATCHES:
When including HTML in patches, use escaped quotes for attributes:
{"selector":"#list","append":"<li id=\\"item-1\\">Text</li>"}

For data-action-data, use &quot; for inner quotes:
{"selector":"#list","append":"<button data-action-data=\\"{&quot;id&quot;:&quot;1&quot;}\\">Click</button>"}

ICONS:
Use Iconify: <iconify-icon icon="mdi:plus"></iconify-icon>

Output ONLY minified JSON lines, nothing else.`;

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

      const generateFullHtml = (options: GenerateOptions) =>
        Effect.gen(function* () {
          yield* Effect.log("Generating full HTML", options);

          const { prompt, action, actionData, currentHtml } = options;

          // Build user message with dynamic content
          const userMessageParts: TextPart[] = [];

          if (currentHtml) {
            userMessageParts.push({
              type: "text",
              text: `CURRENT UI STATE:\n${currentHtml}\n\nIMPORTANT: Preserve the existing design, layout, colors, and style. Only make changes that are explicitly requested.`,
            });
          }

          if (action) {
            userMessageParts.push({
              type: "text",
              text: `ACTION TRIGGERED: ${action}\nAction Data: ${JSON.stringify(
                actionData,
                null,
                0
              )}\n\nThe user clicked a button with data-action="${action}". Generate the COMPLETE page with the updated state.`,
            });
          } else if (prompt) {
            userMessageParts.push({
              type: "text",
              text: `USER REQUEST: ${prompt}\n\nGenerate an interface based on this request.`,
            });
          } else {
            userMessageParts.push({
              type: "text",
              text: `Generate a simple centered welcome message for a generative UI system.
Keep it minimal: just a heading and a short description explaining that users can describe what they want to create.
Cyber-minimalist design (monochromatic, clean lines, lots of whitespace).`,
            });
          }

          const messages: ModelMessage[] = [
            { role: "system" as const, content: FULL_HTML_SYSTEM_PROMPT },
            { role: "user" as const, content: userMessageParts },
          ];

          const result = yield* Effect.tryPromise({
            try: () =>
              generateText({
                model: llm.provider.languageModel("openai/gpt-oss-20b"),
                messages,
              }),
            catch: (error) => {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              console.error("Generation error:", error);
              return new Error(`Failed to generate text: ${errorMessage}`);
            },
          });

          // Log token usage with cache stats
          const usage = result.usage;
          const inputTokens = usage.inputTokens ?? 0;
          const cachedTokens = usage.cachedInputTokens ?? 0;
          const cacheHitRate =
            inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0;

          yield* Effect.log("Full HTML generation completed - Token usage", {
            inputTokens,
            outputTokens: usage.outputTokens ?? 0,
            totalTokens: usage.totalTokens ?? 0,
            cachedTokens,
            cacheHitRate: `${cacheHitRate.toFixed(1)}%`,
          });

          return result.text;
        });

      const generatePatches = (options: GeneratePatchesOptions) =>
        Effect.gen(function* () {
          yield* Effect.log("Generating patches", {
            action: options.action,
            hasErrors: options.previousErrors?.length ?? 0,
          });

          const {
            currentHtml,
            action,
            actionData,
            previousErrors = [],
          } = options;

          // Build user message with dynamic content
          const userMessageParts = [
            `CURRENT HTML:\n${currentHtml}`,
            `ACTION TRIGGERED: ${action}\nACTION DATA: ${JSON.stringify(
              actionData,
              null,
              0
            )}`,
          ];

          if (previousErrors.length > 0) {
            userMessageParts.push(
              `YOUR PREVIOUS PATCHES FAILED:\n${previousErrors.join(
                "\n"
              )}\n\nPlease generate corrected patches. Make sure selectors match existing elements.`
            );
          }

          const messages = [
            { role: "system" as const, content: PATCH_SYSTEM_PROMPT },
            { role: "user" as const, content: userMessageParts.join("\n\n") },
          ];

          const result = yield* Effect.tryPromise({
            try: () =>
              generateText({
                model: llm.provider.languageModel("openai/gpt-oss-20b"),
                messages,
              }),
            catch: (error) => {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              console.error("Patch generation error:", error);
              return new Error(`Failed to generate patches: ${errorMessage}`);
            },
          });

          // Log token usage with cache stats
          const usage = result.usage;
          const inputTokens = usage.inputTokens ?? 0;
          const cachedTokens = usage.cachedInputTokens ?? 0;
          const cacheHitRate =
            inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0;

          yield* Effect.log("Patch generation - Token usage", {
            inputTokens,
            outputTokens: usage.outputTokens ?? 0,
            totalTokens: usage.totalTokens ?? 0,
            cachedTokens,
            cacheHitRate: `${cacheHitRate.toFixed(1)}%`,
          });

          // Parse the JSON response
          const text = result.text.trim();
          const jsonText = text.startsWith("```")
            ? text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "")
            : text;

          const patches = yield* Effect.try({
            try: () => JSON.parse(jsonText) as Patch[],
            catch: (e) =>
              new Error(
                `Failed to parse patches JSON: ${e}\nResponse was: ${text}`
              ),
          });

          yield* Effect.log("Patch generation completed", {
            patchCount: patches.length,
          });
          return patches;
        });

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

          // Build history messages optimized for Groq prompt caching:
          // 1. System prompt (static - always cached)
          // 2. Prompt history (semi-static - high cache hits, rarely changes)
          // 3. Action summary (dynamic but compact)
          // 4. Current request (always fresh)

          // Add prompts as separate user messages (stable prefix for caching)
          const promptMessages = pipe(
            recentPrompts,
            A.map((p) => ({
              role: "user" as const,
              content: `USER REQUEST: ${p.content}`,
            }))
          );

          // Add action summary as single compact message (changes frequently)
          const actionMessage =
            recentActions.length > 0
              ? [
                  {
                    role: "user" as const,
                    content: `RECENT ACTIONS: ${pipe(
                      recentActions,
                      A.map(
                        (a) =>
                          `${a.action}${
                            a.data ? `(${JSON.stringify(a.data)})` : ""
                          }`
                      ),
                      (actions) => actions.join(", ")
                    )}`,
                  },
                ]
              : [];

          const historyMessages = [...promptMessages, ...actionMessage];

          // Build current user message (dynamic - placed last)
          const currentMessageParts: string[] = [];
          if (currentHtml) {
            currentMessageParts.push(`CURRENT HTML:\n${currentHtml}`);
          }
          if (action) {
            currentMessageParts.push(
              `ACTION TRIGGERED: ${action}\nACTION DATA: ${JSON.stringify(
                actionData,
                null,
                0
              )}`
            );
          }
          if (prompt) {
            currentMessageParts.push(`USER REQUEST: ${prompt}`);
          }

          const messages = [
            { role: "system" as const, content: STREAMING_PATCH_PROMPT },
            ...historyMessages,
            {
              role: "user" as const,
              content: currentMessageParts.join("\n\n"),
            },
          ];

          const result = streamText({
            model: llm.provider.languageModel("openai/gpt-oss-20b"),
            messages,
          });

          const parseJsonLine = (line: string) =>
            Effect.try({
              try: () => JSON.parse(line) as UnifiedResponse,
              catch: () => new Error(`Failed to parse JSON line: ${line}`),
            });

          // Token stream from LLM
          const tokenStream = Stream.fromAsyncIterable(
            safeAsyncIterable(result.textStream),
            (error) =>
              error instanceof Error
                ? error
                : new Error(`Stream error: ${String(error)}`)
          );

          // Append trailing newline to flush any remaining buffer content
          const tokenStreamWithFlush = pipe(
            tokenStream,
            Stream.concat(Stream.make("\n"))
          );

          const effectStream = pipe(
            tokenStreamWithFlush,
            // Buffer tokens until newline, emit completed lines immediately
            Stream.mapAccum("", (buffer, token) => {
              const combined = buffer + token;
              const parts = combined.split("\n");
              const completedLines = parts.slice(0, -1);
              const newBuffer = parts[parts.length - 1];
              return [newBuffer, completedLines] as const;
            }),
            // Flatten array of lines into individual line emissions
            Stream.mapConcat((lines) => lines),
            // Filter out empty lines
            Stream.filter((line) => line.trim().length > 0),
            // Parse each line as JSON
            Stream.mapEffect((line) => parseJsonLine(line)),
            // Log parsed response
            Stream.tap((response) =>
              Effect.logDebug("Parsed response", { response })
            ),
            Stream.ensuring(
              Effect.gen(function* () {
                const usage = yield* Effect.promise(() => result.usage);

                const inputTokens = usage.inputTokens ?? 0;
                const cachedTokens = usage.cachedInputTokens ?? 0;
                const cacheHitRate =
                  inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0;

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
                  outputTokens: usage.outputTokens ?? 0,
                  totalTokens: usage.totalTokens ?? 0,
                  cachedTokens,
                  cacheHitRate: `${cacheHitRate.toFixed(1)}%`,
                });
              })
            )
          );

          return effectStream;
        });

      return {
        generateFullHtml,
        generatePatches,
        streamUnified,
      };
    }),
  }
) {}
