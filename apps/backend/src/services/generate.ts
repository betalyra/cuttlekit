import { Effect, Stream } from "effect";
import { generateText, streamObject, ModelMessage, TextPart } from "ai";
import { z } from "zod";
import { LlmProvider } from "./llm.js";
import type { ConversationMessage } from "./session.js";
import type { Patch } from "./vdom.js";

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

export type GenerateOptions = {
  prompt?: string;
  history?: ConversationMessage[];
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
Use data-action attributes for clickable elements:
- <button data-action="increment">+</button>
- <button id="delete-123" data-action="delete" data-action-data="{&quot;id&quot;:&quot;123&quot;}">Delete</button>
- All input values are automatically collected and sent with actions

CRITICAL - UNIQUE IDs:
ALWAYS add unique id attributes to ALL interactive and dynamic elements:
- Checkboxes: id="todo-1-checkbox", id="todo-2-checkbox"
- List items: id="todo-1", id="todo-2"
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
This ensures the user can always escape from any UI state. Place it unobtrusively but visibly.

Design: Light mode, high-contrast monochromatic, clean geometric shapes, generous whitespace.

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
2. ALWAYS use simple ID selectors like "#todo-1", "#counter-value", "#delete-btn-1"
3. NEVER use complex attribute selectors like [data-action-data='{"id":"1"}'] - they will FAIL
4. Keep patches minimal - only change what's needed
5. For counters/numbers: just update the text content
6. For lists: use append/prepend to add items, remove to delete
7. For checkboxes: use "#todo-1-checkbox" not input[data-action="toggle"]
8. For boolean attributes (checked, disabled): use "checked" to set, null to remove

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

          yield* Effect.log("Full HTML generation completed");
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
            result.partialObjectStream,
            (error) =>
              error instanceof Error
                ? error
                : new Error(`Stream error: ${String(error)}`)
          ).pipe(
            Stream.mapConcat((partialArray) => {
              // partialArray is the array as it's being built
              // Emit only new patches that we haven't emitted yet
              if (!partialArray || !Array.isArray(partialArray)) {
                return [];
              }
              const newPatches = partialArray.slice(emittedCount);
              emittedCount = partialArray.length;
              // Only emit complete patches (validated by Zod schema)
              return newPatches.flatMap((p) => {
                const result = PatchSchema.safeParse(p);
                return result.success ? [result.data] : [];
              });
            })
          );

          return effectStream;
        });

      return { generateFullHtml, generatePatches, streamPatches };
    }),
  }
) {}
