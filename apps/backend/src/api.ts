import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpServerResponse,
} from "@effect/platform";
import { Effect, PubSub, Queue, Schema, Stream, pipe } from "effect";
import {
  ProcessorRegistry,
  DurableEventLog,
  ActionPayloadSchema,
  type StreamEvent,
  type StreamEventWithOffset,
} from "./services/durable/index.js";
import { SessionService } from "./services/session.js";
import { ModelRegistry } from "./services/model-registry.js";

// ============================================================
// SSE formatting
// ============================================================

const textEncoder = new TextEncoder();

const formatSseEvent = (event: StreamEventWithOffset) =>
  textEncoder.encode(
    `id: ${event.offset}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
  );

// ============================================================
// API definition
// ============================================================

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
    HttpApiGroup.make("sessions").add(
      HttpApiEndpoint.post("create-session", "/sessions")
        .addSuccess(
          Schema.Struct({ sessionId: Schema.String }),
          { status: 201 }
        )
        .addError(HttpApiError.InternalServerError)
    )
  )
  .add(
    HttpApiGroup.make("models").add(
      HttpApiEndpoint.get("list-models", "/models").addSuccess(
        Schema.Struct({
          models: Schema.Array(
            Schema.Struct({
              id: Schema.String,
              provider: Schema.String,
              label: Schema.String,
            })
          ),
          defaultId: Schema.String,
        })
      )
    )
  )
  .add(
    HttpApiGroup.make("stream")
      .add(
        HttpApiEndpoint.post("submit-action", "/stream/:sessionId")
          .setPath(Schema.Struct({ sessionId: Schema.String }))
          .setPayload(ActionPayloadSchema)
          .addSuccess(Schema.Struct({ queued: Schema.Boolean }), {
            status: 202,
          })
          .addError(HttpApiError.BadRequest)
          .addError(HttpApiError.InternalServerError)
      )
      .add(
        HttpApiEndpoint.get("subscribe", "/stream/:sessionId")
          .setPath(Schema.Struct({ sessionId: Schema.String }))
          .setUrlParams(
            Schema.Struct({
              offset: Schema.optional(Schema.NumberFromString),
            })
          )
          .addSuccess(Schema.Unknown)
          .addError(HttpApiError.InternalServerError)
      )
  );

// ============================================================
// Health group handlers
// ============================================================

export const healthGroupLive = HttpApiBuilder.group(
  api,
  "health",
  (handlers) =>
    handlers.handle("health", () =>
      Effect.succeed({
        status: "ok",
      })
    )
);

// ============================================================
// Sessions group handlers
// ============================================================

export const sessionsGroupLive = HttpApiBuilder.group(
  api,
  "sessions",
  (handlers) =>
    handlers.handle("create-session", () =>
      Effect.gen(function* () {
        const sessionService = yield* SessionService;
        const session = yield* sessionService.createSession();
        return { sessionId: session.id };
      }).pipe(
        Effect.mapError(() => new HttpApiError.InternalServerError())
      )
    )
);

// ============================================================
// Models group handlers
// ============================================================

export const modelsGroupLive = HttpApiBuilder.group(
  api,
  "models",
  (handlers) =>
    handlers.handle("list-models", () =>
      Effect.gen(function* () {
        const registry = yield* ModelRegistry;
        return {
          models: registry.availableModels(),
          defaultId: registry.defaultModelId,
        };
      })
    )
);

// ============================================================
// Stream group handlers
// ============================================================

export const streamGroupLive = HttpApiBuilder.group(
  api,
  "stream",
  (handlers) =>
    handlers
      .handle("submit-action", ({ path, payload }) =>
        Effect.gen(function* () {
          // Validate model if specified
          if (payload.model) {
            const modelRegistry = yield* ModelRegistry;
            const available = modelRegistry.availableModels();
            const isValid = available.some((m) => m.id === payload.model);
            if (!isValid) {
              return yield* new HttpApiError.BadRequest();
            }
          }

          const registry = yield* ProcessorRegistry;
          const processor = yield* registry.getOrCreate(path.sessionId);
          yield* registry.touch(path.sessionId);

          yield* Queue.offer(processor.actionQueue, {
            type: payload.prompt ? "prompt" : "action",
            prompt: payload.prompt,
            action: payload.action,
            actionData: payload.actionData,
            currentHtml: payload.currentHtml,
            model: payload.model,
          });

          return { queued: true };
        }).pipe(
          Effect.mapError((err) =>
            err instanceof HttpApiError.BadRequest
              ? err
              : new HttpApiError.InternalServerError()
          )
        )
      )
      .handleRaw("subscribe", ({ path, urlParams }) =>
        Effect.gen(function* () {
          const registry = yield* ProcessorRegistry;
          const eventLog = yield* DurableEventLog;
          const processor = yield* registry.getOrCreate(path.sessionId);
          yield* registry.touch(path.sessionId);

          const clientOffset = urlParams.offset ?? -1;

          // Use unwrapScoped so the PubSub subscription lives as long as
          // the SSE stream (not the handler effect's scope).
          const eventStream = Stream.unwrapScoped(
            Effect.gen(function* () {
              // STEP 1: Subscribe to PubSub FIRST (eager — buffers events)
              const subscription = yield* PubSub.subscribe(
                processor.eventPubSub
              );

              // STEP 2: Read missed events from DB
              const missedRows = yield* eventLog.readFrom(
                path.sessionId,
                clientOffset
              );
              const dbMaxOffset =
                missedRows.length > 0
                  ? missedRows[missedRows.length - 1].offset
                  : clientOffset;

              // STEP 3: Convert DB rows to events with offset
              const missedStream = Stream.fromIterable(
                missedRows.map((row) => ({
                  ...(JSON.parse(row.data) as StreamEvent),
                  offset: row.offset,
                }))
              );

              // STEP 4: Filter PubSub stream to skip already-sent events
              const deduplicatedPubSubStream = pipe(
                Stream.fromQueue(subscription),
                Stream.filter((event) => event.offset > dbMaxOffset)
              );

              // STEP 5: Compose: replay first, then live
              return Stream.concat(missedStream, deduplicatedPubSubStream);
            })
          );

          const bodyStream = pipe(eventStream, Stream.map(formatSseEvent));

          return HttpServerResponse.stream(bodyStream, {
            contentType: "text/event-stream",
            headers: {
              "Cache-Control": "no-cache",
              "X-Accel-Buffering": "no",
              Connection: "keep-alive",
            },
          });
        }).pipe(
          Effect.mapError(() => new HttpApiError.InternalServerError())
        )
      )
);
