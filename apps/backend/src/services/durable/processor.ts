import { Effect, Stream, Queue, PubSub, Chunk, Ref, pipe } from "effect";
import { UIService } from "../ui.js";
import { DurableEventLog } from "./event-log.js";
import {
  DurableConfig,
  type Action,
  type StreamEvent,
  type StreamEventWithOffset,
} from "./types.js";
import type { SandboxContext } from "../sandbox/manager.js";

export const runProcessingLoop = (
  sessionId: string,
  actionQueue: Queue.Queue<Action>,
  eventPubSub: PubSub.PubSub<StreamEventWithOffset>,
  sandboxCtx: SandboxContext,
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

        // Use the model from the last action that specifies one
        const modelId = [...actions].reverse().find((a) => a.model)?.model;

        yield* Effect.log("Processing actions", {
          sessionId,
          count: actions.length,
          modelId,
          actions: actions.map((a) =>
            a.type === "prompt" ? `prompt: ${a.prompt}` : `action: ${a.action}`,
          ),
        });

        const stream = yield* uiService.generateStream({
          sessionId,
          actions,
          modelId,
          sandboxCtx,
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
