import { Context, Effect, Layer } from "effect";
import { generateText } from "ai";
import { LlmService } from "./llm.js";

export class GenerateService extends Context.Tag("GenerateService")<
  GenerateService,
  {
    readonly generatePage: (
      userPrompt?: string
    ) => Effect.Effect<string, Error, never>;
  }
>() {}

export const GenerateServiceLive = Layer.effect(
  GenerateService,
  Effect.gen(function* () {
    const llm = yield* LlmService;

    return {
      generatePage: (userPrompt?: string) =>
        Effect.gen(function* () {
          yield* Effect.log("Starting page generation", { userPrompt });

          const systemPrompt = `You are a Generative UI Engine that dynamically creates interactive web interfaces.

IMPORTANT CONTEXT:
- You are generating HTML that will be rendered inside an Alpine.js application via x-html
- To communicate with the parent, dispatch a custom event: $dispatch('regenerate', userPrompt)
- This is running in a continuous feedback loop - the user can request changes and you regenerate

${
  userPrompt
    ? `USER REQUEST: ${userPrompt}

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

Example cyber-minimalist structure:
<div x-data="{ userPrompt: '' }" class="min-h-screen bg-black text-white flex items-center justify-center p-8">
  <div class="border border-gray-800 bg-zinc-950 p-12 max-w-2xl w-full">
    <h1 class="text-3xl font-mono tracking-tight mb-2 text-gray-100">GENERATIVE UI</h1>
    <p class="text-sm text-gray-500 mb-8 font-mono">Dynamic interface generation system</p>
    <input x-model="userPrompt" class="w-full bg-zinc-900 border border-gray-800 px-4 py-3 mb-4 text-gray-100 font-mono text-sm focus:outline-none focus:border-gray-700" placeholder="Describe changes..." />
    <button @click="$dispatch('regenerate', userPrompt)" class="w-full bg-white text-black font-mono text-sm py-3 hover:bg-gray-200 transition-colors">GENERATE</button>
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
              const errorMessage = error instanceof Error ? error.message : String(error);
              console.error("Generation error:", error);
              return new Error(`Failed to generate text: ${errorMessage}`);
            },
          });

          yield* Effect.log("Page generation completed");
          return result.text;
        }),
    };
  })
);
