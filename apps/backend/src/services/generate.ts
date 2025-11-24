import { Context, Effect, Layer } from "effect";
import { generateText } from "ai";
import { LlmService } from "./llm.js";
import type { ConversationMessage } from "./session.js";

export interface GenerateOptions {
  prompt?: string;
  history?: ConversationMessage[];
  type?: "full-page" | "partial-update" | "chat";
  target?: string;
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

          const { prompt, history = [], type = "full-page", target } = options;

          // Build context from conversation history
          const historyContext =
            history.length > 0
              ? `\n\nCONVERSATION HISTORY:\n${history
                  .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
                  .join("\n")}`
              : "";

          const systemPrompt = `You are a Generative UI Engine that dynamically creates interactive web interfaces.

IMPORTANT CONTEXT:
- You are generating HTML that will be rendered inside an Alpine.js application via x-html
- To communicate with the parent, dispatch a custom event: $dispatch('regenerate', userPrompt)
- This is running in a continuous feedback loop - the user can request changes and you regenerate${historyContext}

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
- Use x-data for local state within your generated component
- To trigger regeneration, dispatch an event: @click="$dispatch('regenerate', userPrompt)"
- Style with Tailwind CSS utility classes

Design inspiration for the initial rendering:
- High-contrast monochromatic palette (deep blacks, pure whites)
- Multi-font stratification (use font-sans for headings, font-mono for technical elements)
- Generous whitespace and precise spacing
- Subtle borders and clean geometric shapes
- Smooth transitions and hover states
- Technical precision with fluid aesthetics
- Use light mode

Example cyber-minimalist structure:
<div x-data="{ userPrompt: '' }" class="min-h-screen bg-black text-white flex items-center justify-center p-8">
  <div class="max-w-3xl w-full space-y-8">
    <!-- Header -->
    <div class="space-y-2">
      <h1 class="text-5xl font-bold tracking-tight text-white">GENERATIVE UI</h1>
      <p class="text-gray-400 text-sm tracking-wide">Dynamic interface generation system</p>
    </div>

    <!-- Input Section -->
    <div class="border border-gray-800 bg-zinc-950/50 backdrop-blur">
      <input
        x-model="userPrompt"
        @keydown.enter="$dispatch('regenerate', userPrompt)"
        class="w-full bg-transparent border-0 px-6 py-4 text-white text-sm placeholder-gray-600 focus:outline-none"
        placeholder="Describe the interface you want to create..."
      />
      <div class="border-t border-gray-800 px-6 py-3 flex justify-end">
        <button
          @click="$dispatch('regenerate', userPrompt)"
          class="px-6 py-2 bg-white text-black text-xs font-medium tracking-wider hover:bg-gray-200 transition-colors"
        >
          GENERATE
        </button>
      </div>
    </div>

    <!-- Info -->
    <div class="text-xs text-gray-600 font-mono">
      Press Enter or click Generate to create your interface
    </div>
  </div>
</div>

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
