import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpMiddleware,
  HttpServer,
} from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { createServer } from "node:http"
import { GenerateService } from "./services/generate.js"
import { LlmServiceLive } from "./services/llm.js"
import { SessionService } from "./services/session.js"
import { VdomService } from "./services/vdom.js"
import { RequestHandlerService } from "./services/request-handler.js"
import { Request, Response } from "./types/messages.js"

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
  )

const healthGroupLive = HttpApiBuilder.group(api, "health", (handlers) =>
  handlers.handle("health", () =>
    Effect.succeed({
      status: "ok",
    })
  )
)

// Wire up all services using Effect.Service.Default layers
const ServicesLive = RequestHandlerService.Default.pipe(
  Layer.provide(SessionService.Default),
  Layer.provide(VdomService.Default),
  Layer.provide(GenerateService.Default.pipe(Layer.provide(LlmServiceLive))),
)

const generateGroupLive = HttpApiBuilder.group(api, "generate", (handlers) =>
  handlers.handle("generate", ({ payload }) =>
    Effect.gen(function* () {
      const requestHandler = yield* RequestHandlerService

      return yield* requestHandler.handleRequest(payload).pipe(
        Effect.mapError(() => new HttpApiError.InternalServerError())
      )
    })
  )
).pipe(Layer.provide(ServicesLive))

const ApiLive = HttpApiBuilder.api(api).pipe(
  Layer.provide(healthGroupLive),
  Layer.provide(generateGroupLive)
)

const HttpLive = HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
  Layer.provide(HttpApiBuilder.middlewareCors()),
  Layer.provide(ApiLive),
  HttpServer.withLogAddress,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 34512 }))
)

Layer.launch(HttpLive).pipe(NodeRuntime.runMain)
