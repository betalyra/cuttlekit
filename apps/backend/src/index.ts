import { HttpApiBuilder, HttpMiddleware, HttpServer } from "@effect/platform";
import { NodeHttpServer, NodeRuntime, NodeFileSystem } from "@effect/platform-node";
import { Config, Effect, Layer, Logger, LogLevel } from "effect";
import { createServer } from "node:http";

import { api, healthGroupLive, sessionsGroupLive, streamGroupLive, modelsGroupLive } from "./api.js";
import { GenerateService } from "./services/generate/index.js";
import {
  GroqLanguageModelLayer,
  GoogleLanguageModelLayer,
  GoogleEmbeddingModelLayer,
  InceptionLanguageModelLayer,
} from "@betalyra/generative-ui-common/server";
import { SessionService } from "./services/session.js";
import {
  DatabaseLayer,
  StoreService,
  MemoryService,
} from "./services/memory/index.js";
import { VdomService, PatchValidator } from "./services/vdom/index.js";
import { UIService } from "./services/ui.js";
import {
  DurableEventLog,
  ProcessorRegistry,
  dormancyChecker,
  eventCleanup,
} from "./services/durable/index.js";
import { ModelRegistry } from "./services/model-registry.js";
import { SandboxService } from "./services/sandbox/index.js";
import { ChunkingService, DocSearchService } from "./services/doc-search/index.js";
import { ToolService } from "./services/generate/tools.js";

// LLM provider layer based on LLM_PROVIDER env var (groq | google)
// Dies on config error - no point running without a model
const LlmLayerLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const selectedProvider = yield* Config.literal(
      "google",
      "groq",
      "inception",
    )("LLM_PROVIDER").pipe(Config.withDefault("groq"));

    const modelId = yield* Config.string("LLM_MODEL").pipe(
      Config.withDefault("openai/gpt-oss-120b"),
    );

    yield* Effect.logInfo(`Using ${selectedProvider} model ${modelId}`);
    if (selectedProvider === "groq") {
      return GroqLanguageModelLayer(modelId);
    } else if (selectedProvider === "inception") {
      return InceptionLanguageModelLayer(modelId);
    } else {
      return GoogleLanguageModelLayer(modelId);
    }
  }).pipe(Effect.orDie),
);

// Embedding model layer (Google text-embedding-004)
const EmbeddingLayerLive = GoogleEmbeddingModelLayer();

// Compose all service layers
// Build from dependencies up: base infra → services → durable → API

// Database and store
const StoreWithDb = StoreService.Default.pipe(Layer.provide(DatabaseLayer));

// Memory service with store and embedding
const MemoryWithDeps = MemoryService.Default.pipe(
  Layer.provide(StoreWithDb),
  Layer.provide(EmbeddingLayerLive),
  Layer.provide(LlmLayerLive),
);

// Session service depends on store
const SessionWithDeps = SessionService.Default.pipe(Layer.provide(StoreWithDb));

// Model registry depends on FileSystem (reads config.toml)
const ModelRegistryLive = ModelRegistry.Default.pipe(
  Layer.provide(NodeFileSystem.layer),
);

// Sandbox service depends on FileSystem (reads config.toml)
const SandboxWithDeps = SandboxService.Default.pipe(
  Layer.provide(NodeFileSystem.layer),
);

// Doc search service depends on store, embedding, chunking, and config
const DocSearchWithDeps = DocSearchService.Default.pipe(
  Layer.provide(StoreWithDb),
  Layer.provide(EmbeddingLayerLive),
  Layer.provide(ChunkingService.Default),
  Layer.provide(NodeFileSystem.layer),
);

// Tool service depends on doc search, store, and sandbox
const ToolServiceWithDeps = ToolService.Default.pipe(
  Layer.provide(DocSearchWithDeps),
  Layer.provide(StoreWithDb),
  Layer.provide(SandboxWithDeps),
);

// Generate service depends on memory, LLM, model registry, prompt logger, and tools
const GenerateWithDeps = GenerateService.Default.pipe(
  Layer.provide(MemoryWithDeps),
  Layer.provide(LlmLayerLive),
  Layer.provide(ModelRegistryLive),
  Layer.provide(PatchValidator.Default),
  Layer.provide(ToolServiceWithDeps),
);

// UI service depends on generate, memory, session, vdom, store, doc search
const UIWithDeps = UIService.Default.pipe(
  Layer.provide(GenerateWithDeps),
  Layer.provide(MemoryWithDeps),
  Layer.provide(SessionWithDeps),
  Layer.provide(VdomService.Default),
  Layer.provide(StoreWithDb),
  Layer.provide(DocSearchWithDeps),
);

// Durable event log depends on database
const EventLogWithDeps = DurableEventLog.Default.pipe(
  Layer.provide(DatabaseLayer),
);

// Processor registry depends on UI service, event log, sandbox, and store
const RegistryWithDeps = ProcessorRegistry.Default.pipe(
  Layer.provide(UIWithDeps),
  Layer.provide(EventLogWithDeps),
  Layer.provide(SandboxWithDeps),
  Layer.provide(StoreWithDb),
);

// Background jobs layer - forks dormancy checker and event cleanup
const BackgroundJobs = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.forkScoped(dormancyChecker);
    yield* Effect.forkScoped(eventCleanup);
    yield* Effect.log("Background jobs started");
  })
).pipe(
  Layer.provide(RegistryWithDeps),
  Layer.provide(EventLogWithDeps),
);

// Compose API layers
const ApiLive = HttpApiBuilder.api(api).pipe(
  Layer.provide(healthGroupLive),
  Layer.provide(sessionsGroupLive),
  Layer.provide(modelsGroupLive),
  Layer.provide(streamGroupLive),
  Layer.provide(SessionWithDeps),
  Layer.provide(ModelRegistryLive),
  Layer.provide(VdomService.Default),
  Layer.provide(RegistryWithDeps),
  Layer.provide(EventLogWithDeps),
  Layer.provide(BackgroundJobs),
);

// HTTP server layer
const HttpLive = HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
  Layer.provide(HttpApiBuilder.middlewareCors()),
  Layer.provide(ApiLive),
  HttpServer.withLogAddress,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 34512 })),
  Layer.provide(Logger.minimumLogLevel(LogLevel.Debug)),
);

// Launch (scoped for background fibers)
Layer.launch(HttpLive).pipe(Effect.scoped, NodeRuntime.runMain);
