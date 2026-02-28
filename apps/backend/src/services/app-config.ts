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

// Provider-specific schemas
const DenoProviderDefSchema = Schema.Struct({
  region: Schema.optionalWith(Schema.String, { default: () => "ams" }),
  use_snapshots: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  snapshot_capacity_mb: Schema.optionalWith(Schema.Number, {
    default: () => 10000,
  }),
  volume_capacity_mb: Schema.optionalWith(Schema.Number, {
    default: () => 5000,
  }),
  timeout_seconds: Schema.optionalWith(Schema.Number, { default: () => 300 }),
  memory_mb: Schema.optionalWith(Schema.Number, { default: () => 1280 }),
});

const SandboxDefSchema = Schema.Struct({
  provider: Schema.String,
  init_mode: Schema.optionalWith(Schema.Literal("lazy", "eager"), {
    default: () => "lazy" as const,
  }),
  sandbox_scope: Schema.optionalWith(Schema.Literal("session", "user"), {
    default: () => "user" as const,
  }),
  deno: Schema.optional(DenoProviderDefSchema),
  dependencies: Schema.optionalWith(Schema.Array(SandboxDependencyDefSchema), {
    default: () => [],
  }),
});

const TomlSchema = Schema.Struct({
  default_model: Schema.String,
  background_model: Schema.optional(Schema.String),
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
  readonly backgroundModelId: string;
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
  readonly provider: string;
  readonly initMode: "lazy" | "eager";
  readonly sandboxScope: "session" | "user";
  readonly region: string;
  readonly useSnapshots: boolean;
  readonly snapshotCapacityMb: number;
  readonly volumeCapacityMb: number;
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
// Resolve sandbox config from TOML section
// ============================================================

type SandboxDef = Schema.Schema.Type<typeof SandboxDefSchema>;

const resolveSandbox = (def: SandboxDef) =>
  Effect.gen(function* () {
    // Resolve provider-specific settings
    const providerConfig = def.provider === "deno" ? def.deno : undefined;
    if (!providerConfig) {
      yield* Effect.logWarning(
        `Sandbox provider '${def.provider}' selected but [sandbox.${def.provider}] not configured`,
      );
      return Option.none<SandboxConfig>();
    }

    const dependencies = yield* pipe(
      def.dependencies,
      Effect.forEach((dep) =>
        Effect.gen(function* () {
          const secretValue = dep.secret_env
            ? yield* Config.redacted(dep.secret_env).pipe(
                Config.withDefault(Redacted.make("")),
                Effect.map((v) => (Redacted.value(v) === "" ? undefined : v)),
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
      provider: def.provider,
      initMode: def.init_mode,
      sandboxScope: def.sandbox_scope,
      region: providerConfig.region,
      useSnapshots: providerConfig.use_snapshots,
      snapshotCapacityMb: providerConfig.snapshot_capacity_mb,
      volumeCapacityMb: providerConfig.volume_capacity_mb,
      timeoutSeconds: providerConfig.timeout_seconds,
      memoryMb: providerConfig.memory_mb,
      dependencies,
    } satisfies SandboxConfig);
  });

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

  const backgroundModelId = toml.background_model ?? defaultModelId;

  const models: ModelsConfig = { defaultModelId, backgroundModelId, providers };

  // Resolve sandbox config (optional — absent section = no sandbox)
  const sandbox = toml.sandbox
    ? yield* resolveSandbox(toml.sandbox)
    : Option.none<SandboxConfig>();

  yield* Effect.log("Config loaded", {
    providers: providers.map((p) => p.name),
    models: providers.flatMap((p) => p.models.map((m) => m.id)),
    default: defaultModelId,
    background: backgroundModelId,
    sandbox: Option.match(sandbox, {
      onNone: () => "none",
      onSome: (s) => ({
        provider: s.provider,
        region: s.region,
        initMode: s.initMode,
        sandboxScope: s.sandboxScope,
        useSnapshots: s.useSnapshots,
        deps: s.dependencies.map((d) => d.package),
      }),
    }),
  });

  return { models, sandbox } satisfies AppConfig;
});
