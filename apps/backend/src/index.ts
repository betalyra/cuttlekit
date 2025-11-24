import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpMiddleware,
  HttpServer,
} from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Schema } from "effect";
import { createServer } from "node:http";
import { GenerateService, GenerateServiceLive } from "./services/generate.js";
import { LlmServiceLive } from "./services/llm.js";

const api = HttpApi.make("api")
  .add(
    HttpApiGroup.make("health").add(
      HttpApiEndpoint.get("health", "/health").addSuccess(
        Schema.Struct({
          status: Schema.String,
        }),
        { status: 202 }
      )
    )
  )
  .add(
    HttpApiGroup.make("generate").add(
      HttpApiEndpoint.post("generate", "/generate")
        .setPayload(
          Schema.Struct({
            prompt: Schema.optional(Schema.String),
          })
        )
        .addSuccess(
          Schema.Struct({
            html: Schema.String,
          })
        )
        .addError(HttpApiError.InternalServerError)
    )
  );

const healthGroupLive = HttpApiBuilder.group(api, "health", (handlers) =>
  handlers.handle("health", () =>
    Effect.succeed({
      status: "ok",
    })
  )
);

const generateGroupLive = HttpApiBuilder.group(api, "generate", (handlers) =>
  Effect.gen(function* () {
    const generateService = yield* GenerateService;

    return handlers.handle("generate", ({ payload }) =>
      Effect.gen(function* () {
        const html = yield* generateService
          .generatePage(payload.prompt)
          .pipe(Effect.mapError(() => new HttpApiError.InternalServerError()));
        return { html };
      })
    );
  })
).pipe(Layer.provide(GenerateServiceLive), Layer.provide(LlmServiceLive));

const ApiLive = HttpApiBuilder.api(api).pipe(
  Layer.provide(healthGroupLive),
  Layer.provide(generateGroupLive)
);

const HttpLive = HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
  Layer.provide(HttpApiBuilder.middlewareCors()),
  Layer.provide(ApiLive),
  HttpServer.withLogAddress,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 34512 }))
);

Layer.launch(HttpLive).pipe(NodeRuntime.runMain);
