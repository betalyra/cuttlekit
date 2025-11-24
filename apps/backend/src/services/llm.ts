import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { Config, Context, Effect, Layer, Redacted } from "effect";
import type { LanguageModel } from "ai";

export class LlmService extends Context.Tag("LlmService")<
  LlmService,
  {
    readonly model: LanguageModel;
  }
>() {}

export const GoogleServiceLive = Layer.effect(
  LlmService,
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("GOOGLE_API_KEY");

    const google = createGoogleGenerativeAI({
      apiKey: Redacted.value(apiKey),
    });

    const model = google("gemini-2.5-flash-lite");

    return {
      model,
    };
  })
);

export const GroqServiceLive = Layer.effect(
  LlmService,
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("GROQ_API_KEY");

    const groq = createGroq({
      apiKey: Redacted.value(apiKey),
    });

    const model = groq("openai/gpt-oss-20b");

    return {
      model,
    };
  })
);

// Default export for convenience
export const LlmServiceLive = GroqServiceLive;
