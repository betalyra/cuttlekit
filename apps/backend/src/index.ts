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
import { GenerateServiceLive } from "./services/generate.js";
import { LlmServiceLive } from "./services/llm.js";
import { SessionServiceLive } from "./services/session.js";
import {
  RequestHandlerService,
  RequestHandlerServiceLive,
} from "./services/request-handler.js";
import { Request, Response } from "./types/messages.js";

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
        .setPayload(Request)
        .addSuccess(Response)
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
  handlers.handle("generate", ({ payload }) =>
    Effect.gen(function* () {
      const requestHandler = yield* RequestHandlerService;

      return yield* requestHandler.handleRequest(payload).pipe(
        Effect.mapError(() => new HttpApiError.InternalServerError())
      );
    })
  )
).pipe(
  Layer.provide(RequestHandlerServiceLive),
  Layer.provide(GenerateServiceLive),
  Layer.provide(SessionServiceLive),
  Layer.provide(LlmServiceLive)
);

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
