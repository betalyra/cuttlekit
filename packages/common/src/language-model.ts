import { Context, Layer } from "effect";
import type { LanguageModel } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";

// ============================================================
// Usage Extraction Types
// ============================================================

export type ExtractedUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cachedTokens: number;
};

export type UsageExtractor = (rawUsage: unknown) => ExtractedUsage;

// Default extractor - no caching info
export const extractDefaultUsage: UsageExtractor = (raw) => {
  const usage = raw as {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    cachedTokens: 0,
  };
};

// ============================================================
// Language Model Config
// ============================================================

export type LanguageModelConfig = {
  readonly model: LanguageModel;
  readonly providerOptions: ProviderOptions;
  readonly extractUsage: UsageExtractor;
  readonly providerName: string;
};

export class LanguageModelProvider extends Context.Tag("LanguageModelProvider")<
  LanguageModelProvider,
  LanguageModelConfig
>() {}

// ============================================================
// Test Layer
// ============================================================

export const TestLanguageModelLayer = (model: LanguageModel) =>
  Layer.succeed(LanguageModelProvider, {
    model,
    providerOptions: {},
    extractUsage: extractDefaultUsage,
    providerName: "test",
  });
