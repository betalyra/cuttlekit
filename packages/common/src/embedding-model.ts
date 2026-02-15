import { Context, Layer } from "effect";
import type { EmbeddingModel } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";

export type EmbeddingModelConfig = {
  readonly model: EmbeddingModel;
  readonly dimensions: number;
  readonly providerName: string;
  readonly providerOptions?: ProviderOptions;
};

export class EmbeddingModelProvider extends Context.Tag(
  "EmbeddingModelProvider",
)<EmbeddingModelProvider, EmbeddingModelConfig>() {}

export const TestEmbeddingModelLayer = (
  model: EmbeddingModel,
  dimensions: number,
) =>
  Layer.succeed(EmbeddingModelProvider, {
    model,
    dimensions,
    providerName: "test",
    providerOptions: undefined,
  });
