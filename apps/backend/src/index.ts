import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpMiddleware,
  HttpServer,
} from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Schema } from "effect";
import { createServer } from "node:http";

const api = HttpApi.make("api").add(
  HttpApiGroup.make("health").add(
    HttpApiEndpoint.get("health", "/health").addSuccess(
      Schema.Struct({
        status: Schema.String,
      }),
      { status: 202 }
    )
  )
);

const healthGroupLive = HttpApiBuilder.group(api, "health", (handlers) =>
  handlers.handle("health", () =>
    Effect.succeed({
      status: "ok",
    })
  )
);

const ApiLive = HttpApiBuilder.api(api).pipe(Layer.provide(healthGroupLive));

const HttpLive = HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
  Layer.provide(ApiLive),
  HttpServer.withLogAddress,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 34512 }))
);

Layer.launch(HttpLive).pipe(NodeRuntime.runMain);
