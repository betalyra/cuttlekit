import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { Config, Context, Effect, Layer, Redacted } from "effect";
import type { LanguageModel } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";

export type LanguageModelConfig = {
  readonly model: LanguageModel;
  readonly providerOptions: ProviderOptions;
};

export class LanguageModelProvider extends Context.Tag("LanguageModelProvider")<
  LanguageModelProvider,
  LanguageModelConfig
>() {}

export const GroqLanguageModelLayer = (modelId: string) =>
  Layer.effect(
    LanguageModelProvider,
    Effect.gen(function* () {
      const apiKey = yield* Config.redacted("GROQ_API_KEY");
      const groq = createGroq({ apiKey: Redacted.value(apiKey) });
      return {
        model: groq(modelId),
        providerOptions: {
          openai: { streamOptions: { includeUsage: true } },
        },
      };
    })
  ).pipe(Layer.orDie);

export const GoogleLanguageModelLayer = (modelId: string) =>
  Layer.effect(
    LanguageModelProvider,
    Effect.gen(function* () {
      const apiKey = yield* Config.redacted("GOOGLE_API_KEY");
      const google = createGoogleGenerativeAI({
        apiKey: Redacted.value(apiKey),
      });
      return {
        model: google(modelId),
        providerOptions: {},
      };
    })
  ).pipe(Layer.orDie);

export const TestLanguageModelLayer = (model: LanguageModel) =>
  Layer.succeed(LanguageModelProvider, {
    model,
    providerOptions: {},
  });
