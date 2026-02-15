import { Effect, Stream, Queue, PubSub, Chunk, Ref, pipe } from "effect";
import { UIService } from "../ui.js";
import { DurableEventLog } from "./event-log.js";
import {
  DurableConfig,
  type Action,
  type StreamEvent,
  type StreamEventWithOffset,
} from "./types.js";

export const runProcessingLoop = (
  sessionId: string,
  actionQueue: Queue.Queue<Action>,
  eventPubSub: PubSub.PubSub<StreamEventWithOffset>
) =>
  Effect.gen(function* () {
    const uiService = yield* UIService;
    const eventLog = yield* DurableEventLog;
    const offsetRef = yield* Ref.make(
      yield* eventLog.getLatestOffset(sessionId)
    );

    yield* Effect.log("Processing loop started", { sessionId });

    yield* Effect.forever(
      Effect.gen(function* () {
        const actionsChunk = yield* Queue.takeBetween(
          actionQueue,
          1,
          DurableConfig.MAX_BATCH_SIZE
        );
        const actions = Chunk.toReadonlyArray(actionsChunk);

        yield* Effect.log("Processing actions", {
          sessionId,
          count: actions.length,
        });

        const stream = yield* uiService.generateStream({
          sessionId,
          actions,
        });

        yield* pipe(
          stream,
          Stream.mapEffect((event: StreamEvent) =>
            Effect.gen(function* () {
              const offset = yield* Ref.updateAndGet(offsetRef, (n) => n + 1);
              const eventWithOffset = { ...event, offset };

              // Publish to PubSub first for low-latency delivery
              yield* PubSub.publish(eventPubSub, eventWithOffset);

              // Then persist to durable log
              yield* eventLog.append(sessionId, offset, event);

              return eventWithOffset;
            })
          ),
          Stream.runDrain
        );
      }).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logError("Processing loop error, continuing", {
            sessionId,
            cause: cause.toString(),
          })
        )
      )
    );
  });
