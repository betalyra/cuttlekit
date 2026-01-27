import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { Config, Effect, Layer, Redacted } from "effect";
import {
  LanguageModelProvider,
  type UsageExtractor,
} from "../language-model.js";

// Google Gemini format - cachedContentTokenCount in usage metadata
const extractGoogleUsage: UsageExtractor = (raw) => {
  const usage = raw as {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedContentTokenCount?: number;
    raw?: { cachedContentTokenCount?: number };
  };
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    cachedTokens:
      usage.cachedContentTokenCount ?? usage.raw?.cachedContentTokenCount ?? 0,
  };
};

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
        providerOptions: {
          thinkingConfig: {
            thinkingLevel: "minimal",
          },
        },
        extractUsage: extractGoogleUsage,
        providerName: "google",
      };
    }),
  ).pipe(Layer.orDie);
