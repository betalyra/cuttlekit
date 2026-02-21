import { Effect, Config, Redacted, Schema, Option, pipe } from "effect";
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

const SandboxDependencyDefSchema = Schema.Struct({
  package: Schema.String,
  docs: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  secret_env: Schema.optional(Schema.String),
  hosts: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [],
  }),
});

const SandboxDefSchema = Schema.Struct({
  enabled: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  provider: Schema.Literal("deno"),
  mode: Schema.optionalWith(Schema.Literal("lazy", "warm"), {
    default: () => "lazy" as const,
  }),
  region: Schema.optionalWith(Schema.String, { default: () => "ord" }),
  volume_ttl_minutes: Schema.optionalWith(Schema.Number, {
    default: () => 30,
  }),
  volume_capacity_mb: Schema.optionalWith(Schema.Number, {
    default: () => 300,
  }),
  snapshot_capacity_mb: Schema.optionalWith(Schema.Number, {
    default: () => 10000,
  }),
  timeout_seconds: Schema.optionalWith(Schema.Number, { default: () => 300 }),
  memory_mb: Schema.optionalWith(Schema.Number, { default: () => 1280 }),
  dependencies: Schema.optionalWith(Schema.Array(SandboxDependencyDefSchema), {
    default: () => [],
  }),
});

const TomlSchema = Schema.Struct({
  default_model: Schema.String,
  providers: Schema.Record({
    key: Schema.String,
    value: ProviderDefSchema,
  }),
  sandbox: Schema.optional(SandboxDefSchema),
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

export type SandboxDependencyConfig = {
  readonly package: string;
  readonly docs: ReadonlyArray<string>;
  readonly secretEnv: string | undefined;
  readonly secretValue: Redacted.Redacted | undefined;
  readonly hosts: ReadonlyArray<string>;
};

export type SandboxConfig = {
  readonly enabled: boolean;
  readonly provider: "deno";
  readonly mode: "lazy" | "warm";
  readonly region: string;
  readonly volumeTtlMinutes: number;
  readonly volumeCapacityMb: number;
  readonly snapshotCapacityMb: number;
  readonly timeoutSeconds: number;
  readonly memoryMb: number;
  readonly dependencies: ReadonlyArray<SandboxDependencyConfig>;
};

export type AppConfig = {
  readonly models: ModelsConfig;
  readonly sandbox: Option.Option<SandboxConfig>;
};

// Convention: provider "groq" → env var "GROQ_API_KEY"
const apiKeyEnvName = (providerName: string) =>
  `${providerName.toUpperCase()}_API_KEY`;

// ============================================================
// Loader
// ============================================================

export const loadAppConfig = Effect.gen(function* () {
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

  const models: ModelsConfig = { defaultModelId, providers };

  // Resolve sandbox config (optional — absent section = no sandbox)
  const sandbox: Option.Option<SandboxConfig> = toml.sandbox
    ? yield* Effect.gen(function* () {
        const def = toml.sandbox!;

        const dependencies = yield* pipe(
          def.dependencies,
          Effect.forEach((dep) =>
            Effect.gen(function* () {
              const secretValue = dep.secret_env
                ? yield* Config.redacted(dep.secret_env).pipe(
                    Config.withDefault(Redacted.make("")),
                    Effect.map((v) =>
                      Redacted.value(v) === "" ? undefined : v,
                    ),
                  )
                : undefined;

              return {
                package: dep.package,
                docs: dep.docs,
                secretEnv: dep.secret_env,
                secretValue,
                hosts: dep.hosts,
              } satisfies SandboxDependencyConfig;
            }),
          ),
        );

        return Option.some({
          enabled: def.enabled,
          provider: def.provider,
          mode: def.mode,
          region: def.region,
          volumeTtlMinutes: def.volume_ttl_minutes,
          volumeCapacityMb: def.volume_capacity_mb,
          snapshotCapacityMb: def.snapshot_capacity_mb,
          timeoutSeconds: def.timeout_seconds,
          memoryMb: def.memory_mb,
          dependencies,
        } satisfies SandboxConfig);
      })
    : Option.none();

  yield* Effect.log("Config loaded", {
    providers: providers.map((p) => p.name),
    models: providers.flatMap((p) => p.models.map((m) => m.id)),
    default: defaultModelId,
    sandbox: Option.match(sandbox, {
      onNone: () => "none",
      onSome: (s) => ({
        enabled: s.enabled,
        provider: s.provider,
        mode: s.mode,
        deps: s.dependencies.map((d) => d.package),
      }),
    }),
  });

  return { models, sandbox } satisfies AppConfig;
});
