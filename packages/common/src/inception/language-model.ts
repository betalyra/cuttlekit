import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Config, Effect, Layer, Redacted } from "effect";
import {
  LanguageModelProvider,
  extractDefaultUsage,
} from "../language-model.js";

export const InceptionLanguageModelLayer = (modelId: string) =>
  Layer.effect(
    LanguageModelProvider,
    Effect.gen(function* () {
      const apiKey = yield* Config.redacted("INCEPTION_API_KEY");
      const inception = createOpenAICompatible({
        name: "inception",
        baseURL: "https://api.inceptionlabs.ai/v1",
        apiKey: Redacted.value(apiKey),
        includeUsage: true,
      });
      return {
        model: inception.chatModel(modelId),
        providerOptions: {
          openaiCompatible: { reasoningEffort: "instant" },
        },
        extractUsage: extractDefaultUsage,
        providerName: "inception",
      };
    }),
  ).pipe(Layer.orDie);
