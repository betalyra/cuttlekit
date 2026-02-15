import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { Config, Effect, Layer, Redacted } from "effect";
import { EmbeddingModelProvider } from "../embedding-model.js";

// gemini-embedding-001 outputs 3072-dimensional vectors
const DEFAULT_DIMENSIONS = 768; // text-embedding-004 outputs 768 dimensions

export const GoogleEmbeddingModelLayer = (
  modelId: string = "gemini-embedding-001",
  dimensions: number = DEFAULT_DIMENSIONS,
) =>
  Layer.effect(
    EmbeddingModelProvider,
    Effect.gen(function* () {
      const apiKey = yield* Config.redacted("GOOGLE_API_KEY");
      const google = createGoogleGenerativeAI({
        apiKey: Redacted.value(apiKey),
      });
      return {
        model: google.embeddingModel(modelId),
        dimensions,
        providerName: "google",
        providerOptions: {
          google: {
            outputDimensionality: dimensions,
            taskType: "SEMANTIC_SIMILARITY",
            autoTruncate: true,
          },
        },
      };
    }),
  ).pipe(Layer.orDie);
