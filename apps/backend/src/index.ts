import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpMiddleware,
  HttpServer,
  HttpServerResponse,
} from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Config, Effect, Layer, Schema, Stream } from "effect";
import { createServer } from "node:http";
import { GenerateService } from "./services/generate.js";
import { GoogleService, GroqService } from "./services/llm.js";
import { SessionService } from "./services/session.js";
import { VdomService } from "./services/vdom.js";
import { UIService } from "./services/ui.js";
import { RequestHandlerService } from "./services/request-handler.js";
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
    HttpApiGroup.make("generate")
      .add(
        HttpApiEndpoint.post("generate", "/generate")
          .setPayload(Request)
          .addSuccess(Response)
          .addError(HttpApiError.InternalServerError)
      )
      .add(
        HttpApiEndpoint.post("generate-stream", "/generate/stream")
          .setPayload(Request)
          .addSuccess(Schema.Unknown)
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

// Wire up all services using Effect.Service.Default layers
const ServicesLive = RequestHandlerService.Default.pipe(
  Layer.provideMerge(UIService.Default),
  Layer.provideMerge(SessionService.Default),
  Layer.provideMerge(VdomService.Default),
  Layer.provideMerge(GenerateService.Default),
  Layer.provideMerge(
    Layer.unwrapEffect(
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
    )
  )
);

const textEncoder = new TextEncoder();

const generateGroupLive = HttpApiBuilder.group(api, "generate", (handlers) =>
  handlers
    .handle("generate", ({ payload }) =>
      Effect.gen(function* () {
        const requestHandler = yield* RequestHandlerService;

        return yield* requestHandler
          .handleRequest(payload)
          .pipe(Effect.mapError(() => new HttpApiError.InternalServerError()));
      })
    )
    .handle("generate-stream", ({ payload }) =>
      Effect.gen(function* () {
        const uiService = yield* UIService;

        const eventStream = yield* uiService.generateStream({
          sessionId: payload.sessionId,
          currentHtml: payload.type === "generate" ? payload.currentHtml : undefined,
          prompt: payload.type === "generate" ? payload.prompt : payload.type === "update" ? payload.prompt : undefined,
          action: payload.type === "generate" ? payload.action : undefined,
          actionData: payload.type === "generate" ? payload.actionData : undefined,
        });

        const bodyStream = eventStream.pipe(
          Stream.map((event) => ({
            event: "message" as const,
            data: JSON.stringify(event),
          })),
          Stream.concat(
            Stream.make({
              event: "close" as const,
              data: undefined as string | undefined,
            })
          ),
          Stream.map((sseEvent) => {
            const eventLine = `event: ${sseEvent.event}\n`;
            const dataLine = sseEvent.data ? `data: ${sseEvent.data}\n` : "";
            return textEncoder.encode(`${eventLine}${dataLine}\n`);
          }),
          Stream.catchAll((error) =>
            Stream.make(
              textEncoder.encode(
                `event: error\ndata: ${error instanceof Error ? error.message : String(error)}\n\n`
              )
            )
          )
        );

        return HttpServerResponse.stream(bodyStream, {
          contentType: "text/event-stream",
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            Connection: "keep-alive",
          },
        });
      }).pipe(Effect.mapError(() => new HttpApiError.InternalServerError()))
    )
).pipe(Layer.provide(ServicesLive));

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
