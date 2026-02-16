import { createGroq } from "@ai-sdk/groq";
import { Config, Effect, Layer, Redacted } from "effect";
import {
  LanguageModelProvider,
  type UsageExtractor,
} from "../language-model.js";

// Groq uses OpenAI-compatible format
export const extractGroqUsage: UsageExtractor = (raw) => {
  const usage = raw as {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    raw?: { prompt_tokens_details?: { cached_tokens?: number } };
  };
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    cachedTokens: usage.raw?.prompt_tokens_details?.cached_tokens ?? 0,
  };
};

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
        extractUsage: extractGroqUsage,
        providerName: "groq",
      };
    })
  ).pipe(Layer.orDie);
