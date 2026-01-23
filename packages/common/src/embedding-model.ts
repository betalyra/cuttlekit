import { Context, Layer } from "effect";
import type { EmbeddingModel } from "ai";

export type EmbeddingModelConfig = {
  readonly model: EmbeddingModel<string>;
  readonly dimensions: number;
  readonly providerName: string;
};

export class EmbeddingModelProvider extends Context.Tag("EmbeddingModelProvider")<
  EmbeddingModelProvider,
  EmbeddingModelConfig
>() {}

export const TestEmbeddingModelLayer = (model: EmbeddingModel<string>, dimensions: number) =>
  Layer.succeed(EmbeddingModelProvider, {
    model,
    dimensions,
    providerName: "test",
  });
