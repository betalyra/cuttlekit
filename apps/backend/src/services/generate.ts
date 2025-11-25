import { Context, Effect, Layer } from "effect";
import { generateText } from "ai";
import { LlmService } from "./llm.js";
import type { ConversationMessage } from "./session.js";

export interface GenerateOptions {
  prompt?: string;
  history?: ConversationMessage[];
  type?: "full-page" | "partial-update" | "chat";
  target?: string;
  action?: string;
  actionData?: Record<string, unknown>;
  state?: Record<string, unknown>;
}

export class GenerateService extends Context.Tag("GenerateService")<
  GenerateService,
  {
    readonly generate: (
      options: GenerateOptions
    ) => Effect.Effect<string, Error, never>;
  }
>() {}

export const GenerateServiceLive = Layer.effect(
  GenerateService,
  Effect.gen(function* () {
    const llm = yield* LlmService;

    return {
      generate: (options: GenerateOptions) =>
        Effect.gen(function* () {
          yield* Effect.log("Starting generation", options);

          const { prompt, history = [], type = "full-page", target, action, actionData, state = {} } = options;

          // Build context from conversation history
          const historyContext =
            history.length > 0
              ? `\n\nCONVERSATION HISTORY:\n${history
                  .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
                  .join("\n")}`
              : "";

          // Build action context if an action was triggered
          const actionContext = action
            ? `\n\nACTION TRIGGERED:
Action: ${action}
Action Data: ${JSON.stringify(actionData, null, 2)}
Current Application State: ${JSON.stringify(state, null, 2)}

The user triggered an action. Based on this action and the current state, regenerate the page with the appropriate updates.`
            : "";

          const systemPrompt = `You are a Generative UI Engine that dynamically creates interactive web interfaces.

IMPORTANT CONTEXT:
- You are generating HTML that will be rendered inside an Alpine.js application via x-html
- Alpine directives (@click, x-model, etc.) DO NOT WORK inside x-html for security reasons
- For interactivity, use the ACTION-BASED SYSTEM described below
- This is running in a continuous feedback loop - the user can request changes and you regenerate${historyContext}${actionContext}

${
  type === "partial-update" && target
    ? `PARTIAL UPDATE REQUEST:
Target: ${target}
Prompt: ${prompt}

Generate HTML to replace the element at selector "${target}". Maintain continuity with the rest of the page.`
    : type === "chat"
    ? `CHAT REQUEST:
User message: ${prompt}

Respond conversationally. You can also suggest UI changes or updates.`
    : action
    ? `ACTION REQUEST:
The user clicked a button/element with data-action="${action}".
Look at your most recent HTML in the conversation history.
Parse the current state from that HTML (e.g., counter values, list items, etc.).
Apply the action to update that state.
Regenerate the COMPLETE page with the updated state.

CRITICAL: DO NOT revert to the initial welcome page! Maintain the current interface and only update what the action affects.`
    : prompt
    ? `USER REQUEST: ${prompt}

Regenerate the interface based on this user request. Maintain continuity but apply the requested changes.`
    : `Generate an initial welcome page for this generative UI system. This page should:

1. Welcome the user and explain this is a generative UI system that creates interfaces dynamically
2. Include a prominent input field where users can describe changes they want
3. Include a "Generate" button that triggers regeneration
4. Use a sleek CYBER-MINIMALIST design aesthetic:
   - Monochromatic or limited color palette (black, white, grays, one accent color)
   - Clean lines and geometric shapes
   - NO gradients or minimal if absolutely necessary
   - Lots of negative space
   - Sharp, modern typography
   - Subtle borders and shadows
5. Use Alpine.js for interactivity`
}

CRITICAL TECHNICAL REQUIREMENTS:
- Return ONLY raw HTML - no markdown, no code blocks, no \`\`\`html tags
- Do NOT include <html>, <head>, or <body> tags
- Do NOT include <script> or <style> tags
- Start directly with a <div> element
- Style with Tailwind CSS utility classes

ACTION-BASED INTERACTIVITY SYSTEM:
Since Alpine directives don't work in x-html, use this server-side action system instead:

1. Add data-action attribute to clickable elements (buttons, links, etc.)
2. Optionally add data-action-data with JSON string for parameters
3. When clicked, the action + conversation history is sent back to you (the AI)
4. You regenerate the page based on the action and previous state

HOW TO MAINTAIN STATE:
- Check the conversation history to see what HTML you previously generated
- Look at the action that was triggered and its data
- Generate new HTML that reflects the action's effect
- For lists (todos, items, etc.), add unique identifiers to elements so you can reference them in actions

Examples:
- Simple action: <button data-action="add-todo">Add Todo</button>
- Action with data: <button data-action="delete-todo" data-action-data='{"id": "todo-123"}'>Delete</button>
- Toggle action: <button data-action="toggle-complete" data-action-data='{"id": "todo-123"}'>Mark Complete</button>

Example flow for a todo list:
1. User clicks "Add Todo" button with data-action="add-todo"
2. You see the previous HTML (with existing todos) in conversation history
3. You generate new HTML with all previous todos PLUS the new one
4. Include a unique ID for the new todo so it can be deleted later

IMPORTANT: DO NOT use Alpine directives like @click, x-model, x-bind, etc. - they will not work!
Instead, use regular HTML inputs and data-action buttons to trigger server-side updates.
To get input values, read them from the DOM: the frontend will handle reading input values before sending the action.

Design inspiration for the initial rendering:
- High-contrast monochromatic palette (deep blacks, pure whites)
- Multi-font stratification (use font-sans for headings, font-mono for technical elements)
- Generous whitespace and precise spacing
- Subtle borders and clean geometric shapes
- Smooth transitions and hover states
- Technical precision with fluid aesthetics
- Use light mode

Example cyber-minimalist structure (for initial welcome page):
<div class="min-h-screen bg-white text-black flex items-center justify-center p-8">
  <div class="max-w-3xl w-full space-y-8">
    <!-- Header -->
    <div class="space-y-2">
      <h1 class="text-5xl font-bold tracking-tight">GENERATIVE UI</h1>
      <p class="text-gray-600 text-sm tracking-wide">Dynamic interface generation system</p>
    </div>

    <!-- Input Section -->
    <div class="border-2 border-black">
      <input
        id="prompt"
        type="text"
        class="w-full border-0 px-6 py-4 text-sm placeholder-gray-400 focus:outline-none"
        placeholder="Describe the interface you want to create..."
      />
      <div class="border-t-2 border-black px-6 py-3 flex justify-end">
        <button
          data-action="generate"
          class="px-6 py-2 bg-black text-white text-xs font-medium tracking-wider hover:bg-gray-800 transition-colors"
        >
          GENERATE
        </button>
      </div>
    </div>

    <!-- Info -->
    <div class="text-xs text-gray-500 font-mono">
      Click Generate to create your interface
    </div>
  </div>
</div>

NOTE: All input/textarea/select values are automatically collected and sent with actions.
Just give inputs an id or name attribute, and they'll be included in actionData.
The input with id="prompt" will be sent as actionData.prompt.

Remember: Output only the HTML, nothing else. No explanations, no markdown formatting.`;

          const result = yield* Effect.tryPromise({
            try: () =>
              generateText({
                model: llm.model,
                prompt: systemPrompt,
              }),
            catch: (error) => {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              console.error("Generation error:", error);
              return new Error(`Failed to generate text: ${errorMessage}`);
            },
          });

          yield* Effect.log("Generation completed");
          return result.text;
        }),
    };
  })
);
