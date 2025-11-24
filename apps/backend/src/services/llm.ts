import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { Config, Context, Effect, Layer, Redacted } from "effect";
import type { LanguageModel } from "ai";

export class LlmService extends Context.Tag("LlmService")<
  LlmService,
  {
    readonly model: LanguageModel;
  }
>() {}

export const LlmServiceLive = Layer.effect(
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
