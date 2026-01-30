import { HttpApiBuilder, HttpMiddleware, HttpServer } from "@effect/platform";
import { NodeHttpServer, NodeRuntime, NodeFileSystem, NodePath } from "@effect/platform-node";
import { Config, Effect, Layer, Logger, LogLevel } from "effect";
import { createServer } from "node:http";

import { api, healthGroupLive, makeGenerateGroupLive } from "./api.js";
import { GenerateService, PromptLogger } from "./services/generate/index.js";
import {
  GroqLanguageModelLayer,
  GoogleLanguageModelLayer,
  GoogleEmbeddingModelLayer,
} from "@betalyra/generative-ui-common/server";
import { SessionService } from "./services/session.js";
import {
  DatabaseLayer,
  StoreService,
  MemoryService,
} from "./services/memory/index.js";
import { VdomService, PatchValidator } from "./services/vdom/index.js";
import { UIService } from "./services/ui.js";
import { RequestHandlerService } from "./services/request-handler.js";

// LLM provider layer based on LLM_PROVIDER env var (groq | google)
// Dies on config error - no point running without a model
const LlmLayerLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const selectedProvider = yield* Config.literal(
      "google",
      "groq",
    )("LLM_PROVIDER").pipe(Config.withDefault("groq"));

    const modelId = yield* Config.string("LLM_MODEL").pipe(
      Config.withDefault("openai/gpt-oss-120b"),
    );

    yield* Effect.logInfo(`Using ${selectedProvider} model ${modelId}`);
    if (selectedProvider === "groq") {
      return GroqLanguageModelLayer(modelId);
    } else {
      return GoogleLanguageModelLayer(modelId);
    }
  }).pipe(Effect.orDie),
);

// Embedding model layer (Google text-embedding-004)
const EmbeddingLayerLive = GoogleEmbeddingModelLayer();

// Compose all service layers
// Build from dependencies up: base infra → services → handlers

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

// Prompt logger depends on FileSystem and Path
const PromptLoggerWithDeps = PromptLogger.Default.pipe(
  Layer.provide(NodeFileSystem.layer),
  Layer.provide(NodePath.layer),
);

// Generate service depends on memory, LLM, and prompt logger
const GenerateWithDeps = GenerateService.Default.pipe(
  Layer.provide(MemoryWithDeps),
  Layer.provide(LlmLayerLive),
  Layer.provide(PatchValidator.Default),
  Layer.provide(PromptLoggerWithDeps),
);

// UI service depends on generate, memory, session, vdom
const UIWithDeps = UIService.Default.pipe(
  Layer.provide(GenerateWithDeps),
  Layer.provide(MemoryWithDeps),
  Layer.provide(SessionWithDeps),
  Layer.provide(VdomService.Default),
);

const ServicesLive = RequestHandlerService.Default.pipe(
  Layer.provide(UIWithDeps),
);

// Compose API layers
const ApiLive = HttpApiBuilder.api(api).pipe(
  Layer.provide(healthGroupLive),
  Layer.provide(makeGenerateGroupLive(ServicesLive)),
);

// HTTP server layer
const HttpLive = HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
  Layer.provide(HttpApiBuilder.middlewareCors()),
  Layer.provide(ApiLive),
  HttpServer.withLogAddress,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 34512 })),
  Layer.provide(Logger.minimumLogLevel(LogLevel.Debug)),
);

// Launch (scoped for MemoryService's background queue)
Layer.launch(HttpLive).pipe(Effect.scoped, NodeRuntime.runMain);
