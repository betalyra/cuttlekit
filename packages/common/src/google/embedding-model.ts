import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { Config, Effect, Layer, Redacted } from "effect";
import { EmbeddingModelProvider } from "../embedding-model.js";

// text-embedding-004 outputs 768 dimensions
const DEFAULT_DIMENSIONS = 768;

export const GoogleEmbeddingModelLayer = (
  modelId: string = "text-embedding-004",
  dimensions: number = DEFAULT_DIMENSIONS
) =>
  Layer.effect(
    EmbeddingModelProvider,
    Effect.gen(function* () {
      const apiKey = yield* Config.redacted("GOOGLE_API_KEY");
      const google = createGoogleGenerativeAI({
        apiKey: Redacted.value(apiKey),
      });
      return {
        model: google.textEmbeddingModel(modelId),
        dimensions,
        providerName: "google",
      };
    })
  ).pipe(Layer.orDie);
