import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { Config, Context, Effect, Layer, Redacted } from "effect";

type GoogleProvider = ReturnType<typeof createGoogleGenerativeAI>;
type GroqProvider = ReturnType<typeof createGroq>;

export type ILlmProvider = {
  provider: GoogleProvider | GroqProvider;
};

export class LlmProvider extends Context.Tag("LlmProvider")<
  LlmProvider,
  ILlmProvider
>() {}

export const GoogleService = Layer.effect(
  LlmProvider,
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("GOOGLE_API_KEY");

    const google = createGoogleGenerativeAI({
      apiKey: Redacted.value(apiKey),
    });

    return { provider: google };
  })
);

export const GroqService = Layer.effect(
  LlmProvider,
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("GROQ_API_KEY");

    const groq = createGroq({
      apiKey: Redacted.value(apiKey),
    });
    return { provider: groq };
  })
);
