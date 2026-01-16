import {
  HttpApiBuilder,
  HttpMiddleware,
  HttpServer,
  KeyValueStore,
} from "@effect/platform";
import { NodeHttpServer, NodeRuntime, NodeFileSystem, NodePath } from "@effect/platform-node";
import { Config, Effect, Layer, Logger, LogLevel } from "effect";
import { createServer } from "node:http";

import { api, healthGroupLive, makeGenerateGroupLive } from "./api.js";
import { GenerateService } from "./services/generate.js";
import { GoogleService, GroqService } from "@betalyra/generative-ui-common/server";
import { SessionService } from "./services/session.js";
import { StorageService } from "./services/storage.js";
import { VdomService } from "./services/vdom.js";
import { UIService } from "./services/ui.js";
import { RequestHandlerService } from "./services/request-handler.js";
import { PatchValidator } from "./services/patch-validator.js";

// Storage layer based on STORAGE env var (memory | file)
const StorageLayerLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const storageType = yield* Config.literal(
      "memory",
      "file"
    )("STORAGE").pipe(Config.withDefault("memory"));

    if (storageType === "file") {
      yield* Effect.logInfo("Using file-based storage at ./.data");
      return KeyValueStore.layerFileSystem("./.data").pipe(
        Layer.provide(NodeFileSystem.layer),
        Layer.provide(NodePath.layer)
      );
    } else {
      yield* Effect.logInfo("Using in-memory storage");
      return KeyValueStore.layerMemory;
    }
  })
);

// LLM provider layer based on LLM_PROVIDER env var (groq | google)
const LlmLayerLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const selectedProvider = yield* Config.literal(
      "google",
      "groq"
    )("LLM_PROVIDER").pipe(Config.withDefault("groq"));

    if (selectedProvider === "groq") {
      return GroqService;
    } else if (selectedProvider === "google") {
      return GoogleService;
    } else {
      return yield* Effect.fail(
        new Error(`Invalid LLM provider: ${selectedProvider}`)
      );
    }
  })
);

// Compose all service layers
// Build from dependencies up: base infra → services → handlers
const StorageWithKV = StorageService.Default.pipe(
  Layer.provide(StorageLayerLive)
);

const GenerateWithDeps = GenerateService.Default.pipe(
  Layer.provide(StorageWithKV),
  Layer.provide(LlmLayerLive),
  Layer.provide(PatchValidator.Default)
);

const UIWithDeps = UIService.Default.pipe(
  Layer.provide(GenerateWithDeps),
  Layer.provide(StorageWithKV),
  Layer.provide(SessionService.Default),
  Layer.provide(VdomService.Default)
);

const ServicesLive = RequestHandlerService.Default.pipe(
  Layer.provide(UIWithDeps)
);

// Compose API layers
const ApiLive = HttpApiBuilder.api(api).pipe(
  Layer.provide(healthGroupLive),
  Layer.provide(makeGenerateGroupLive(ServicesLive))
);

// HTTP server layer
const HttpLive = HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
  Layer.provide(HttpApiBuilder.middlewareCors()),
  Layer.provide(ApiLive),
  HttpServer.withLogAddress,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 34512 })),
  Layer.provide(Logger.minimumLogLevel(LogLevel.Debug))
);

// Launch
Layer.launch(HttpLive).pipe(NodeRuntime.runMain);
