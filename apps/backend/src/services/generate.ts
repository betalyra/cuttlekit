import { Effect } from "effect"
import { generateText } from "ai"
import { LlmService } from "./llm.js"
import type { ConversationMessage } from "./session.js"
import type { Patch } from "./vdom.js"

export type GenerateOptions = {
  prompt?: string
  history?: ConversationMessage[]
  action?: string
  actionData?: Record<string, unknown>
}

export type GeneratePatchesOptions = {
  currentHtml: string
  action: string
  actionData?: Record<string, unknown>
  previousErrors?: string[]
}

export class GenerateService extends Effect.Service<GenerateService>()("GenerateService", {
  accessors: true,
  effect: Effect.gen(function* () {
    const llm = yield* LlmService

    const generateFullHtml = (options: GenerateOptions) =>
      Effect.gen(function* () {
        yield* Effect.log("Generating full HTML", options)

        const { prompt, history = [], action, actionData } = options

        const historyContext =
          history.length > 0
            ? `\n\nCONVERSATION HISTORY:\n${history
                .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
                .join("\n")}`
            : ""

        const actionContext = action
          ? `\n\nACTION TRIGGERED:
Action: ${action}
Action Data: ${JSON.stringify(actionData, null, 2)}

The user triggered an action. Generate the appropriate UI.`
          : ""

        const systemPrompt = `You are a Generative UI Engine that creates interactive web interfaces.
${historyContext}${actionContext}

${
  action
    ? `ACTION REQUEST:
The user clicked a button with data-action="${action}".
Look at the conversation history to understand current state.
Generate the COMPLETE page with the updated state.`
    : prompt
    ? `USER REQUEST: ${prompt}
Generate an interface based on this request.`
    : `Generate an initial welcome page for this generative UI system with:
1. Welcome message explaining this is a generative UI system
2. Input field for describing changes
3. "Generate" button with data-action="generate"
4. Cyber-minimalist design (monochromatic, clean lines, lots of whitespace)`
}

TECHNICAL REQUIREMENTS:
- Return ONLY raw HTML - no markdown, no code blocks
- Do NOT include <html>, <head>, <body>, <script>, or <style> tags
- Start directly with a <div> element
- Style with Tailwind CSS utility classes

INTERACTIVITY:
Use data-action attributes for clickable elements:
- <button data-action="increment">+</button>
- <button data-action="delete" data-action-data='{"id": "123"}'>Delete</button>
- All input values are automatically collected and sent with actions

CRITICAL - ESCAPE HATCH:
ALWAYS include a way for the user to request changes or reset. Options:
1. A prompt input field (id="prompt") with a "Generate" button (data-action="generate") - preferred
2. At minimum: a small "Reset" or "New" button in a corner (data-action="reset")
This ensures the user can always escape from any UI state. Place it unobtrusively but visibly.

Design: Light mode, high-contrast monochromatic, clean geometric shapes, generous whitespace.

Output only HTML, nothing else.`

        const result = yield* Effect.tryPromise({
          try: () =>
            generateText({
              model: llm.model,
              prompt: systemPrompt,
            }),
          catch: (error) => {
            const errorMessage = error instanceof Error ? error.message : String(error)
            console.error("Generation error:", error)
            return new Error(`Failed to generate text: ${errorMessage}`)
          },
        })

        yield* Effect.log("Full HTML generation completed")
        return result.text
      })

    const generatePatches = (options: GeneratePatchesOptions) =>
      Effect.gen(function* () {
        yield* Effect.log("Generating patches", { action: options.action, hasErrors: options.previousErrors?.length ?? 0 })

        const { currentHtml, action, actionData, previousErrors = [] } = options

        const errorContext =
          previousErrors.length > 0
            ? `\n\nYOUR PREVIOUS PATCHES FAILED:
${previousErrors.join("\n")}

Please generate corrected patches. Make sure selectors match existing elements.`
            : ""

        const systemPrompt = `You are a UI Patch Engine. Generate minimal patches to update the UI.

CURRENT HTML:
${currentHtml}

ACTION TRIGGERED: ${action}
ACTION DATA: ${JSON.stringify(actionData, null, 2)}
${errorContext}

Generate a JSON array of patches to update the UI. Each patch targets an element by CSS selector.

PATCH TYPES:
- { "selector": "#id", "text": "new text" } - Set text content
- { "selector": ".class", "html": "<div>...</div>" } - Replace innerHTML
- { "selector": "#id", "attr": { "class": "new-class", "disabled": "true" } } - Set attributes
- { "selector": "#list", "append": "<li>new item</li>" } - Append child HTML
- { "selector": "#list", "prepend": "<li>new item</li>" } - Prepend child HTML
- { "selector": "#item", "remove": true } - Remove element

RULES:
1. Output ONLY a valid JSON array of patches
2. Use CSS selectors that exist in the current HTML
3. Keep patches minimal - only change what's needed
4. For counters/numbers: just update the text content
5. For lists: use append/prepend to add items, remove to delete
6. IDs are most reliable selectors

Example for incrementing a counter with current value "5":
[{"selector": "#counter-value", "text": "6"}]

Example for adding a todo:
[{"selector": "#todo-list", "append": "<li id=\\"todo-4\\">New task</li>"}]

Output ONLY the JSON array, no explanation, no markdown.`

        const result = yield* Effect.tryPromise({
          try: () =>
            generateText({
              model: llm.model,
              prompt: systemPrompt,
            }),
          catch: (error) => {
            const errorMessage = error instanceof Error ? error.message : String(error)
            console.error("Patch generation error:", error)
            return new Error(`Failed to generate patches: ${errorMessage}`)
          },
        })

        // Parse the JSON response
        const text = result.text.trim()
        const jsonText = text.startsWith("```")
          ? text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "")
          : text

        const patches = yield* Effect.try({
          try: () => JSON.parse(jsonText) as Patch[],
          catch: (e) => new Error(`Failed to parse patches JSON: ${e}\nResponse was: ${text}`),
        })

        yield* Effect.log("Patch generation completed", { patchCount: patches.length })
        return patches
      })

    return { generateFullHtml, generatePatches }
  }),
}) {}
