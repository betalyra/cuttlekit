import { Effect, pipe, Array as Arr, Redacted, Schema } from "effect";
import { createGroq } from "@ai-sdk/groq";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import {
  type LanguageModelConfig,
  type UsageExtractor,
  extractGroqUsage,
  extractGoogleUsage,
  extractDefaultUsage,
} from "@betalyra/generative-ui-common/server";
import { loadAppConfig, type ProviderConfig } from "./app-config.js";

// ============================================================
// Error
// ============================================================

export class ModelNotFound extends Schema.TaggedError<ModelNotFound>()(
  "ModelNotFound",
  {
    modelId: Schema.String,
    available: Schema.Array(Schema.String),
  },
) {}

// ============================================================
// Types
// ============================================================

type ModelEntry = {
  readonly id: string;
  readonly provider: string;
  readonly label: string;
  readonly config: LanguageModelConfig;
};

type ProviderFactory = {
  readonly create: (apiKey: string) => (modelId: string) => LanguageModel;
  readonly extractUsage: UsageExtractor;
};

// ============================================================
// Provider Factories
// ============================================================

const providerFactories: Record<string, ProviderFactory> = {
  groq: {
    create: (apiKey) => createGroq({ apiKey }),
    extractUsage: extractGroqUsage,
  },
  google: {
    create: (apiKey) => {
      const g = createGoogleGenerativeAI({ apiKey });
      return (modelId: string) => g(modelId);
    },
    extractUsage: extractGoogleUsage,
  },
  inception: {
    create: (apiKey) => {
      const provider = createOpenAICompatible({
        name: "inception",
        baseURL: "https://api.inceptionlabs.ai/v1",
        apiKey,
        includeUsage: true,
      });
      return (modelId: string) => provider.chatModel(modelId);
    },
    extractUsage: extractDefaultUsage,
  },
};

// ============================================================
// Build model entries from a resolved provider config
// ============================================================

const buildModelsForProvider = (provider: ProviderConfig) =>
  Effect.gen(function* () {
    const factory = providerFactories[provider.name];
    if (!factory) {
      yield* Effect.logWarning(`Unknown provider: ${provider.name}, skipping`);
      return [] as readonly ModelEntry[];
    }

    const sdkCreate = factory.create(Redacted.value(provider.apiKey));

    return pipe(
      provider.models,
      Arr.map(
        (modelDef): ModelEntry => ({
          id: modelDef.id,
          provider: provider.name,
          label: modelDef.label,
          config: {
            model: sdkCreate(modelDef.id),
            providerOptions: provider.options as ProviderOptions,
            extractUsage: factory.extractUsage,
            providerName: provider.name,
          },
        }),
      ),
    );
  });

// ============================================================
// Service
// ============================================================

export class ModelRegistry extends Effect.Service<ModelRegistry>()(
  "ModelRegistry",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const { models: config } = yield* loadAppConfig;

      const entries = yield* pipe(
        config.providers,
        Effect.forEach(buildModelsForProvider),
        Effect.map(Arr.flatten),
      );

      const models = new Map<string, ModelEntry>(
        entries.map((e) => [e.id, e]),
      );

      const resolve = (modelId?: string) => {
        const id = modelId ?? config.defaultModelId;
        const entry = models.get(id);
        if (!entry)
          return Effect.fail(
            new ModelNotFound({
              modelId: id,
              available: [...models.keys()],
            }),
          );
        return Effect.succeed(entry.config);
      };

      const resolveBackground = resolve(config.backgroundModelId);

      const availableModels = pipe(
        entries,
        Arr.map(({ id, provider, label }) => ({ id, provider, label })),
      );

      yield* Effect.log("Model registry initialized", {
        models: entries.map((e) => `${e.provider}/${e.id}`),
        default: config.defaultModelId,
        background: config.backgroundModelId,
      });

      return {
        resolve,
        resolveBackground,
        availableModels,
        defaultModelId: config.defaultModelId,
        backgroundModelId: config.backgroundModelId,
      };
    }),
  },
) {}
