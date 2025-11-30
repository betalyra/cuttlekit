import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer, Schema, Stream } from "effect";
import { RequestHandlerService, type StreamEvent } from "./services/request-handler.js";
import { Request, Response } from "./types/messages.js";

// API definition
export const api = HttpApi.make("api")
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

// Health group handlers
export const healthGroupLive = HttpApiBuilder.group(api, "health", (handlers) =>
  handlers.handle("health", () =>
    Effect.succeed({
      status: "ok",
    })
  )
);

// SSE formatting utilities
const textEncoder = new TextEncoder();

const formatSseEvent = (event: { event: string; data?: string }) => {
  const eventLine = `event: ${event.event}\n`;
  const dataLine = event.data ? `data: ${event.data}\n` : "";
  return textEncoder.encode(`${eventLine}${dataLine}\n`);
};

const streamToSse = (eventStream: Stream.Stream<StreamEvent, Error>) =>
  eventStream.pipe(
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
    Stream.map(formatSseEvent),
    Stream.catchAll((error) =>
      Stream.make(
        formatSseEvent({
          event: "error",
          data: error instanceof Error ? error.message : String(error),
        })
      )
    )
  );

// Generate group handlers
export const makeGenerateGroupLive = <E, R>(
  servicesLayer: Layer.Layer<RequestHandlerService, E, R>
) =>
  HttpApiBuilder.group(api, "generate", (handlers) =>
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
          const requestHandler = yield* RequestHandlerService;

          const eventStream = yield* requestHandler
            .handleStreamRequest(payload)
            .pipe(Effect.mapError(() => new HttpApiError.InternalServerError()));

          const bodyStream = streamToSse(eventStream);

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
  ).pipe(Layer.provide(servicesLayer));
