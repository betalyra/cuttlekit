import { Effect, Stream, pipe } from "effect";
import { generateText, streamObject, ModelMessage, TextPart } from "ai";
import { z } from "zod";
import { LlmProvider } from "./llm.js";
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

CRITICAL - ESCAPE HATCH:
ALWAYS include a way for the user to request changes or reset. Options:
1. A prompt input field (id="prompt") with a "Generate" button (data-action="generate") - preferred
2. At minimum: a small "Reset" or "New" button in a corner (data-action="reset")
This ensures the user can always escape from any UI state.
PLACEMENT: Put the prompt input in a fixed footer at the bottom of the page (position: fixed, bottom: 0).
Keep it minimal and unobtrusive so it doesn't interfere with the main UI content.
Only place it elsewhere if the user explicitly requests a different layout.

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

// Unified system prompt - AI decides mode
const UNIFIED_SYSTEM_PROMPT = `You are a Generative UI Engine that creates and updates interactive web interfaces.

OUTPUT FORMAT:
Return a JSON object with one of these structures:

1. PATCHES MODE (for small, targeted updates):
{"mode": "patches", "patches": [
  {"selector": "#id", "text": "new text"},
  {"selector": "#id", "attr": {"class": "new-class"}},
  {"selector": "#list", "append": "<li>new</li>"},
  {"selector": "#id", "remove": true}
]}

2. FULL HTML MODE (for new UIs or major changes):
{"mode": "full", "html": "<div>...complete HTML...</div>"}

WHEN TO USE EACH MODE:
- Use PATCHES for: counter increments, checkbox toggles, adding/removing list items, style changes to specific elements
- Use FULL HTML for: initial page generation, major redesigns, when the request affects most of the page, or when no current HTML exists

PATCH TYPES:
- {"selector": "#id", "text": "new text"} - Set text content
- {"selector": "#id", "html": "<div>...</div>"} - Replace innerHTML
- {"selector": "#id", "attr": {"class": "x", "style": "..."}} - Set attributes (null removes)
- {"selector": "#list", "append": "<li>...</li>"} - Append child
- {"selector": "#list", "prepend": "<li>...</li>"} - Prepend child
- {"selector": "#id", "remove": true} - Remove element

PATCH RULES:
- Use simple ID selectors (#id) - complex selectors will fail
- Check the CURRENT HTML for actual element IDs before patching
- For multiple style changes, batch them in one patch with the html type on a container

HTML RULES (when mode is "full"):
- Return ONLY raw HTML - no markdown, no code blocks
- Do NOT include <html>, <head>, <body>, <script>, or <style> tags
- Start directly with a <div> element
- Style with Tailwind CSS utility classes

INTERACTIVITY:
Use data-action attributes for interactive elements:
- <button data-action="increment">+</button>
- <button id="delete-123" data-action="delete" data-action-data="{&quot;id&quot;:&quot;123&quot;}">Delete</button>
- <input type="checkbox" id="todo-1-checkbox" data-action="toggle" data-action-data="{&quot;id&quot;:&quot;1&quot;}">

CRITICAL - UNIQUE IDs:
ALWAYS add unique id attributes to ALL interactive and dynamic elements.
This is REQUIRED for the patch system to work correctly.

CRITICAL - JSON IN ATTRIBUTES:
Use &quot; for quotes inside data-action-data attribute values.

CRITICAL - ESCAPE HATCH:
ALWAYS include a prompt input (id="prompt") with a "Generate" button (data-action="generate") in a fixed footer.

ICONS:
Use Iconify: <iconify-icon icon="mdi:home"></iconify-icon>
Popular sets: mdi, lucide, tabler, ph

FONTS:
Use any Google Font by name (loaded on-demand from Fontsource CDN):
Example: style="font-family: 'Space Grotesk', sans-serif"
Stick to Inter unless a specific aesthetic is requested.

Design: Light mode (#fafafa background, #0a0a0a text), minimal brutalist UI, generous whitespace.

Output ONLY the JSON object, nothing else.`;

export type UnifiedGenerateOptions = {
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
              text: `Generate an initial welcome page for this generative UI system with:
1. Welcome message explaining this is a generative UI system
2. Input field for describing changes
3. "Generate" button with data-action="generate"
4. Cyber-minimalist design (monochromatic, clean lines, lots of whitespace)`,
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
          const cacheHitRate = inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0;

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
          const cacheHitRate = inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0;

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

      const streamPatches = (
        options: GeneratePatchesOptions
      ): Effect.Effect<Stream.Stream<Patch, Error>, Error> =>
        Effect.gen(function* () {
          yield* Effect.log("Streaming patches", {
            action: options.action,
            hasErrors: options.previousErrors?.length ?? 0,
          });

          const {
            currentHtml,
            action,
            actionData,
            previousErrors = [],
          } = options;

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

          const result = streamObject({
            model: llm.provider.languageModel("openai/gpt-oss-20b"),
            messages,
            schema: PatchArraySchema,
            mode: "json",
          });

          // Track which patches we've already emitted
          let emittedCount = 0;

          // Convert partial object stream to stream of individual patches
          const effectStream = Stream.fromAsyncIterable(
            safeAsyncIterable(result.partialObjectStream),
            (error) =>
              error instanceof Error
                ? error
                : new Error(`Stream error: ${String(error)}`)
          ).pipe(
            Stream.mapConcatEffect((partialArray) =>
              Effect.gen(function* () {
                yield* Effect.logDebug("[streamPatches] Received partial", {
                  isArray: Array.isArray(partialArray),
                  length: Array.isArray(partialArray) ? partialArray.length : 0,
                  emittedCount,
                  raw: JSON.stringify(partialArray)?.slice(0, 200),
                });

                if (!partialArray) {
                  return [];
                }

                // Handle both array and single object responses
                const patchArray = Array.isArray(partialArray)
                  ? partialArray
                  : [partialArray];
                const newPatches = patchArray.slice(emittedCount);
                emittedCount = patchArray.length;

                const validPatches = yield* pipe(
                  newPatches,
                  Effect.forEach((p) =>
                    Effect.gen(function* () {
                      const result = PatchSchema.safeParse(p);
                      if (!result.success) {
                        yield* Effect.logDebug(
                          "[streamPatches] Invalid patch",
                          {
                            patch: p,
                            error: result.error.message,
                          }
                        );
                        return null;
                      }
                      return result.data as Patch;
                    })
                  ),
                  Effect.map((results: (Patch | null)[]) =>
                    results.filter((p): p is Patch => p !== null)
                  )
                );

                if (validPatches.length > 0) {
                  yield* Effect.logDebug("[streamPatches] Emitting patches", {
                    patches: validPatches,
                  });
                }
                return validPatches;
              })
            )
          );

          return effectStream;
        });

      const streamUnified = (
        options: UnifiedGenerateOptions
      ): Effect.Effect<Stream.Stream<UnifiedResponse, Error>, Error> =>
        Effect.gen(function* () {
          yield* Effect.log("Streaming unified response", {
            action: options.action,
            prompt: options.prompt,
            hasCurrentHtml: !!options.currentHtml,
          });

          const { currentHtml, prompt, action, actionData } = options;

          // Build user message parts
          const contextPart = currentHtml
            ? `CURRENT HTML:\n${currentHtml}`
            : "NO CURRENT HTML - this is an initial page generation. You MUST use full mode.";

          const actionPart = action
            ? `ACTION TRIGGERED: ${action}\nACTION DATA: ${JSON.stringify(
                actionData,
                null,
                0
              )}`
            : null;

          const promptPart = prompt ? `USER REQUEST: ${prompt}` : null;

          const defaultPart =
            !currentHtml && !prompt && !action
              ? `Generate an initial welcome page for this generative UI system with:
1. Welcome message explaining this is a generative UI system
2. Input field for describing changes
3. "Generate" button with data-action="generate"
4. Cyber-minimalist design (monochromatic, clean lines, lots of whitespace)`
              : null;

          const userMessage = [contextPart, actionPart, promptPart, defaultPart]
            .filter((p): p is string => p !== null)
            .join("\n\n");

          const messages = [
            { role: "system" as const, content: UNIFIED_SYSTEM_PROMPT },
            { role: "user" as const, content: userMessage },
          ];

          const result = streamObject({
            model: llm.provider.languageModel("openai/gpt-oss-20b"),
            messages,
            schema: UnifiedResponseSchema,
            mode: "json",
          });

          // Partial schemas for streaming validation
          const PartialPatchesSchema = z.object({
            mode: z.literal("patches"),
            patches: z.array(z.unknown()),
          });

          const FullHtmlSchema = z.object({
            mode: z.literal("full"),
            html: z.string(),
          });

          let emittedPatchCount = 0;
          let emittedFull = false;

          const effectStream = Stream.fromAsyncIterable(
            safeAsyncIterable(result.partialObjectStream),
            (error) =>
              error instanceof Error
                ? error
                : new Error(`Stream error: ${String(error)}`)
          ).pipe(
            Stream.mapConcatEffect((partial) =>
              Effect.gen(function* () {
                // Try parsing as patches mode
                const patchesResult = PartialPatchesSchema.safeParse(partial);
                if (patchesResult.success) {
                  const newPatches =
                    patchesResult.data.patches.slice(emittedPatchCount);
                  const validatedPatches = yield* pipe(
                    newPatches,
                    Effect.forEach((p) =>
                      Effect.sync(() => PatchSchema.safeParse(p))
                    ),
                    Effect.map((results) =>
                      results
                        .filter((r) => r.success)
                        .map((r) => r.data as Patch)
                    )
                  );

                  emittedPatchCount += validatedPatches.length;

                  return validatedPatches.map(
                    (patch): UnifiedResponse => ({
                      mode: "patches",
                      patches: [patch],
                    })
                  );
                }

                // Try parsing as full HTML mode
                const fullResult = FullHtmlSchema.safeParse(partial);
                if (fullResult.success && !emittedFull) {
                  emittedFull = true;
                  return [fullResult.data];
                }

                return [];
              })
            ),
            Stream.ensuring(
              Effect.gen(function* () {
                const usage = yield* Effect.promise(() => result.usage);

                const inputTokens = usage.inputTokens ?? 0;
                const cachedTokens = usage.cachedInputTokens ?? 0;
                const cacheHitRate = inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0;

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
        streamPatches,
        streamUnified,
      };
    }),
  }
) {}
