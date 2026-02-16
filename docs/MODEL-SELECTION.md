# Model Selection: Per-Request Model Switching

## Context

Currently, the LLM model is selected at **server startup** via `LLM_PROVIDER` and `LLM_MODEL` env vars — all requests use the same model. We want the frontend to optionally select a model per-request, with the backend validating and routing to the correct provider. If no model is selected, the default (from env vars) is used. If an unsupported model is requested, the POST returns 400.

---

## Design

### ModelRegistry Service (new)

A new `ModelRegistry` service holds all available models as a `Map<string, ModelEntry>`. At startup, it reads API keys and creates model instances for all supported models whose keys are present.

```typescript
type ModelEntry = {
  readonly id: string;           // AI SDK model ID, e.g. "moonshotai/kimi-k2-instruct-0905"
  readonly provider: string;     // "groq" | "google"
  readonly label: string;        // Display name for frontend
  readonly config: LanguageModelConfig;
};
```

**Available models** (hardcoded list, easily extensible):
- Groq: `moonshotai/kimi-k2-instruct-0905` ("Kimi K2"), `openai/gpt-oss-120b` ("GPT-OSS 120B")
- Google: `gemini-3-flash-preview` ("Gemini 3 Flash")

Only models whose provider API key is available are registered. Adding a model = adding an entry to the list.

### Batched Actions & Model Conflict Resolution

Because of action batching, multiple actions queued in rapid succession may each carry a different `model` field (e.g., user switches model between clicks). **Resolution: use the model from the last action in the batch** — the most recent user preference wins. This keeps things simple and predictable.

```typescript
// In processor.ts — extract model from latest action
const modelId = [...actions].reverse().find(a => a.model)?.model;
```

### Threading model through the system

```
POST body { model?: "moonshotai/kimi-k2-instruct-0905" }
  → API validates via ModelRegistry (400 if not found)
  → Action queued with model field
  → Processor extracts model from LAST action in batch
  → UIRequest gets optional modelId
  → GenerateService resolves LanguageModelConfig from ModelRegistry
  → streamText() uses resolved model
```

### Frontend model selector

A `<select>` dropdown in the footer bar, populated by `GET /models` at init. Selected model stored in `app.selectedModel` and included in every POST. Persisted to localStorage so it survives refresh.

---

## Configuration Options

Three approaches for making the model registry configurable. All read API keys from env vars (secrets never go in config files), but differ in how models/providers are declared.

### Option A: Env Vars Only

Uses a `MODELS` env var with a compact format. Each entry is `provider:modelId:label`, comma-separated.

```env
GROQ_API_KEY="sk-..."
GOOGLE_API_KEY="AI..."
LLM_DEFAULT_MODEL="moonshotai/kimi-k2-instruct-0905"
MODELS="groq:moonshotai/kimi-k2-instruct-0905:Kimi K2,groq:openai/gpt-oss-120b:GPT-OSS 120B,google:gemini-3-flash-preview:Gemini 3 Flash"
```

```typescript
const parseModelsConfig = Effect.gen(function* () {
  const raw = yield* Config.string("MODELS");
  return pipe(
    raw.split(","),
    Array.map((entry) => entry.trim().split(":")),
    Array.filter((parts) => parts.length === 3),
    Array.map(([provider, id, label]) => ({ provider, id, label })),
  );
});
```

**Pros:** No extra files or dependencies. Works well with Docker/CI. Simple to parse.
**Cons:** Gets unwieldy with many models. No way to set per-provider options (e.g., Google's `thinkingLevel`). Flat structure.

### Option B: TOML Config (`smol-toml`)

A `models.toml` file at the project root (or configurable path via `MODELS_CONFIG` env var). Providers and their models are structured hierarchically.

```toml
default_model = "moonshotai/kimi-k2-instruct-0905"

[providers.groq]
api_key_env = "GROQ_API_KEY"

[providers.groq.options]
openai = { streamOptions = { includeUsage = true } }

[[providers.groq.models]]
id = "moonshotai/kimi-k2-instruct-0905"
label = "Kimi K2"

[[providers.groq.models]]
id = "openai/gpt-oss-120b"
label = "GPT-OSS 120B"

[providers.google]
api_key_env = "GOOGLE_API_KEY"

[providers.google.options]
thinkingConfig = { thinkingLevel = "minimal" }

[[providers.google.models]]
id = "gemini-3-flash-preview"
label = "Gemini 3 Flash"
```

```typescript
const TomlConfigSchema = Schema.Struct({
  default_model: Schema.String,
  providers: Schema.Record({
    key: Schema.String,
    value: Schema.Struct({
      api_key_env: Schema.String,
      options: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
      models: Schema.Array(Schema.Struct({
        id: Schema.String,
        label: Schema.String,
      })),
    }),
  }),
});

const loadTomlConfig = (configPath: string) =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() => fs.readFile(configPath, "utf-8"));
    const parsed = parse(raw);
    return yield* Schema.decodeUnknown(TomlConfigSchema)(parsed);
  });

const buildRegistryFromConfig = (config: typeof TomlConfigSchema.Type) =>
  Effect.gen(function* () {
    const models = new Map<string, ModelEntry>();

    yield* pipe(
      Object.entries(config.providers),
      Effect.forEach(([providerName, provider]) =>
        Effect.gen(function* () {
          const apiKey = yield* Config.redacted(provider.api_key_env).pipe(Config.option);
          if (Option.isNone(apiKey)) return;

          const sdkProvider = createProvider(providerName, Redacted.value(apiKey.value));

          yield* pipe(
            provider.models,
            Effect.forEach((model) =>
              Effect.sync(() =>
                models.set(model.id, {
                  id: model.id,
                  provider: providerName,
                  label: model.label,
                  config: buildModelConfig(sdkProvider, model.id, providerName, provider.options),
                })
              )
            ),
          );
        })
      ),
    );

    return models;
  });
```

**Pros:** Clean hierarchical structure. Per-provider options (providerOptions for AI SDK). Easy to read and extend. Supports comments. `smol-toml` is tiny.
**Cons:** Extra file to manage. Extra dependency (`smol-toml`). Slightly more complex parsing.

### Option C: TOML + Env Var Overrides

Same as Option B, but every config value can be overridden by an env var using a convention-based naming scheme. The TOML file serves as the base config, env vars take precedence.

**Convention:** `MODELS_<PATH>` where path segments are uppercase and separated by `_`. Array indices use numeric suffixes.

```env
# Override default model
MODELS_DEFAULT_MODEL="openai/gpt-oss-120b"

# Override a provider option
MODELS_PROVIDERS_GOOGLE_OPTIONS_THINKINGCONFIG_THINKINGLEVEL="none"

# Add/override a model label
MODELS_PROVIDERS_GROQ_MODELS_0_LABEL="Kimi K2 (Fast)"
```

```typescript
const applyEnvOverrides = (config: Record<string, unknown>) =>
  Effect.gen(function* () {
    const env = yield* Effect.sync(() => process.env);

    // Collect all MODELS_* env vars
    const overrides = pipe(
      Object.entries(env),
      Array.filter(([key]) => key.startsWith("MODELS_")),
      Array.map(([key, value]) => ({
        path: key.slice("MODELS_".length).toLowerCase().split("_"),
        value,
      })),
    );

    // Deep-set each override into the config object
    return pipe(
      overrides,
      Array.reduce(config, (acc, { path, value }) => deepSet(acc, path, value)),
    );
  });

const deepSet = (obj: Record<string, unknown>, path: string[], value: unknown): Record<string, unknown> => {
  if (path.length === 0) return obj;
  if (path.length === 1) return { ...obj, [path[0]]: value };
  const [head, ...tail] = path;
  const child = (obj[head] ?? {}) as Record<string, unknown>;
  return { ...obj, [head]: deepSet(child, tail, value) };
};

// Usage in ModelRegistry:
const loadConfig = Effect.gen(function* () {
  const configPath = yield* Config.string("MODELS_CONFIG").pipe(Config.withDefault("models.toml"));
  const baseConfig = yield* loadTomlConfig(configPath);
  const withOverrides = yield* applyEnvOverrides(baseConfig);
  return yield* Schema.decodeUnknown(TomlConfigSchema)(withOverrides);
});
```

**Pros:** Best of both worlds — structured config file with 12-factor env var overrides. Works in Docker/CI (override via env) and locally (edit TOML). Every value is overridable without touching the file.
**Cons:** Most complex to implement. Naming convention for nested paths can be ambiguous (e.g., underscores in key names vs path separators).

### Recommendation

**Start with Option B (TOML)**, add env var overrides (Option C) later if needed. The TOML file is the most maintainable format for declaring providers and models, and per-provider options map cleanly to TOML's nested structure. API keys stay in `.env` — the TOML only references the env var name via `api_key_env`.

---

## Files to Create

| File | Purpose |
|------|---------|
| `apps/backend/src/services/model-registry.ts` | ModelRegistry service — holds all available models, resolve by ID |
| `apps/backend/src/services/model-errors.ts` | `ModelNotFound` tagged error |

## Files to Modify

| File | Change |
|------|--------|
| `packages/common/src/stream.ts` | Add `model?: string` to `ActionSchema` |
| `apps/backend/src/services/durable/types.ts` | Add `model?: string` to `ActionPayloadSchema` |
| `apps/backend/src/services/generate/types.ts` | Add `modelId?: string` to `UnifiedGenerateOptions` |
| `apps/backend/src/services/generate/service.ts` | Resolve model per-request via ModelRegistry |
| `apps/backend/src/services/ui.ts` | Thread `modelId` from UIRequest to GenerateService |
| `apps/backend/src/services/durable/processor.ts` | Extract model from latest action in batch |
| `apps/backend/src/api.ts` | Validate model on POST (400), add `GET /models`, pass model in action |
| `apps/backend/src/index.ts` | Wire ModelRegistry layer |
| `apps/webpage/src/main.ts` | Fetch models, add dropdown, include model in POST |
| `apps/webpage/index.html` | Add `<select id="model-select">` in footer |

---

## Implementation Details

### ModelRegistry Service

```typescript
export class ModelRegistry extends Effect.Service<ModelRegistry>()("ModelRegistry", {
  accessors: true,
  effect: Effect.gen(function* () {
    // Read available API keys (optional — some providers may not be configured)
    const groqKey = yield* Config.redacted("GROQ_API_KEY").pipe(Config.option);
    const googleKey = yield* Config.redacted("GOOGLE_API_KEY").pipe(Config.option);

    const models = new Map<string, ModelEntry>();

    // Register models for each available provider
    if (Option.isSome(groqKey)) {
      const groq = createGroq({ apiKey: Redacted.value(groqKey.value) });
      register(models, "moonshotai/kimi-k2-instruct-0905", "groq", "Kimi K2", groq);
      register(models, "openai/gpt-oss-120b", "groq", "GPT-OSS 120B", groq);
    }

    if (Option.isSome(googleKey)) {
      const google = createGoogleGenerativeAI({ apiKey: Redacted.value(googleKey.value) });
      register(models, "gemini-3-flash-preview", "google", "Gemini 3 Flash", google);
    }

    // Default model from env
    const defaultModelId = yield* Config.string("LLM_MODEL").pipe(
      Config.withDefault("openai/gpt-oss-120b")
    );

    const resolve = (modelId?: string) => {
      const id = modelId ?? defaultModelId;
      const entry = models.get(id);
      if (!entry) return Effect.fail(new ModelNotFound({ modelId: id, available: [...models.keys()] }));
      return Effect.succeed(entry.config);
    };

    const availableModels = () =>
      [...models.values()].map(({ id, provider, label }) => ({ id, provider, label }));

    return { resolve, availableModels, defaultModelId };
  })
}) {}
```

### GenerateService Refactor

Key change: `createAttemptStream` and `createStreamWithRetry` accept `LanguageModelConfig` as parameter instead of capturing it from service-level closure.

```typescript
// In streamUnified:
const modelConfig = options.modelId
  ? yield* modelRegistry.resolve(options.modelId)
  : defaultConfig;  // defaultConfig from LanguageModelProvider (startup env var)

const contentStream = createStreamWithRetry(messages, validationDoc, usageRef, patchesRef, modeRef, 0, modelConfig);
```

### API Endpoint

```typescript
// New endpoint
HttpApiEndpoint.get("list-models", "/models")
  .addSuccess(Schema.Struct({
    models: Schema.Array(Schema.Struct({
      id: Schema.String,
      provider: Schema.String,
      label: Schema.String,
    })),
    defaultId: Schema.String,
  }))

// POST validation (before queuing)
if (payload.model) {
  yield* modelRegistry.resolve(payload.model);  // fails → 400
}
```

### Frontend

- Fetch `GET /models` on init → populate `<select id="model-select">`
- Store `selectedModel` in app state + localStorage
- Include `model: this.selectedModel` in every `submitAction()` POST body
- Model selector in footer between reset button and stats

---

## Implementation Order

1. ModelRegistry service + error type (new files)
2. Add `model` to ActionPayloadSchema + ActionSchema (types)
3. Add `modelId` to UnifiedGenerateOptions + UIRequest (types)
4. Refactor GenerateService to accept LanguageModelConfig per-call
5. Update processor.ts to extract model from actions
6. Update ui.ts to thread modelId
7. Update api.ts — validate model on POST, add GET /models
8. Wire ModelRegistry in index.ts
9. Frontend — fetch models, add dropdown, include in POST

---

## Verification

1. `pnpm build` passes
2. `pnpm dev` starts, logs available models
3. `GET /models` returns correct list
4. Frontend shows model dropdown, defaults to env var model
5. Switching model and submitting prompt uses the selected model (check server logs)
6. POST with unsupported model returns 400
7. POST without model uses default
8. Model selection persists across page refresh
