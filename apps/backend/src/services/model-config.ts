import { Effect, Config, Redacted, Schema, pipe, Array as Arr } from "effect";
import { FileSystem } from "@effect/platform";
import { parse } from "smol-toml";

// ============================================================
// TOML Schema — structure only, no secrets
// ============================================================

const ModelDefSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
});

const ProviderDefSchema = Schema.Struct({
  options: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
  models: Schema.Array(ModelDefSchema),
});

const TomlSchema = Schema.Struct({
  default_model: Schema.String,
  providers: Schema.Record({
    key: Schema.String,
    value: ProviderDefSchema,
  }),
});

// ============================================================
// Resolved config — TOML structure + secrets from Effect Config
// ============================================================

export type ProviderConfig = {
  readonly name: string;
  readonly apiKey: Redacted.Redacted;
  readonly options: Record<string, unknown>;
  readonly models: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
  }>;
};

export type ModelsConfig = {
  readonly defaultModelId: string;
  readonly providers: ReadonlyArray<ProviderConfig>;
};

// Convention: provider "groq" → env var "GROQ_API_KEY"
const apiKeyEnvName = (providerName: string) =>
  `${providerName.toUpperCase()}_API_KEY`;

// ============================================================
// Loader
// ============================================================

export const loadModelsConfig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  // Read and parse TOML
  const configPath = yield* Config.string("CONFIG_PATH").pipe(
    Config.withDefault("config.toml"),
  );
  const raw = yield* fs.readFileString(configPath);
  const toml = yield* Schema.decodeUnknown(TomlSchema)(parse(raw));

  // Default model (overridable via DEFAULT_MODEL env var)
  const defaultModelId = yield* Config.string("DEFAULT_MODEL").pipe(
    Config.withDefault(toml.default_model),
  );

  // Resolve each provider: read API key (required — fail fast if missing)
  const providers = yield* pipe(
    Object.entries(toml.providers),
    Effect.forEach(([name, def]) =>
      Effect.gen(function* () {
        const apiKey = yield* Config.redacted(apiKeyEnvName(name));
        return {
          name,
          apiKey,
          options: (def.options ?? {}) as Record<string, unknown>,
          models: def.models,
        } satisfies ProviderConfig;
      }),
    ),
  );

  yield* Effect.log("Config loaded", {
    providers: providers.map((p) => p.name),
    models: providers.flatMap((p) => p.models.map((m) => m.id)),
    default: defaultModelId,
  });

  return { defaultModelId, providers } satisfies ModelsConfig;
});
