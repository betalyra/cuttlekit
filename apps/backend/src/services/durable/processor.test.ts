import { describe, expect, it } from "@effect/vitest";
import { Effect, Stream, Queue, PubSub, Layer, Fiber, Chunk, Ref, Option, pipe } from "effect";
import { runProcessingLoop } from "./processor.js";
import { DurableEventLog } from "./event-log.js";
import { UIService } from "../ui.js";
import type { ManagedSandbox, SandboxContext } from "../sandbox/manager.js";
import type { Action, StreamEvent, StreamEventWithOffset } from "./types.js";

const makeSandboxCtx = () =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<Option.Option<ManagedSandbox>>(Option.none());
    const lock = yield* Effect.makeSemaphore(1);
    return { ref, lock } satisfies SandboxContext;
  });

// ============================================================
// Mock UIService — returns a fixed stream of events
// ============================================================

const makeUIServiceMock = (
  eventsPerRequest: StreamEvent[][] = [
    [
      { type: "session", sessionId: "test-session" },
      { type: "patch", patch: { selector: "#root", text: "hello" } },
      { type: "done", html: "<div>hello</div>" },
    ],
  ]
) => {
  const callLog: { sessionId?: string; actions: readonly Action[] }[] = [];
  let callIndex = 0;

  return {
    callLog,
    layer: Layer.succeed(UIService, {
      generateStream: (request: { sessionId?: string; actions: readonly Action[] }) =>
        Effect.gen(function* () {
          callLog.push({
            sessionId: request.sessionId,
            actions: request.actions,
          });
          const events = eventsPerRequest[callIndex] ?? eventsPerRequest[0];
          callIndex++;
          return Stream.fromIterable(events);
        }),
      resolveSession: () =>
        Effect.succeed({ sessionId: "test-session", currentHtml: null }),
    } as unknown as UIService),
  };
};

// ============================================================
// Mock DurableEventLog — records appended events in-memory
// ============================================================

const makeDurableEventLogMock = (initialOffset = -1) => {
  const appendedEvents: {
    sessionId: string;
    offset: number;
    event: StreamEvent;
  }[] = [];

  return {
    appendedEvents,
    layer: Layer.succeed(DurableEventLog, {
      append: (sessionId: string, offset: number, event: StreamEvent) => {
        appendedEvents.push({ sessionId, offset, event });
        return Effect.void;
      },
      getLatestOffset: () => Effect.succeed(initialOffset),
      readFrom: () => Effect.succeed([]),
      getLastHtmlEvent: () => Effect.succeed(null),
      cleanup: Effect.succeed(0),
    } as unknown as DurableEventLog),
  };
};

describe("runProcessingLoop", () => {
  it.live("processes a single action and dual-writes events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const uiMock = makeUIServiceMock();
        const eventLogMock = makeDurableEventLogMock();

        const actionQueue = yield* Queue.unbounded<Action>();
        const eventPubSub = yield* PubSub.unbounded<StreamEventWithOffset>();
        const sandboxCtx = yield* makeSandboxCtx();
        const subscription = yield* PubSub.subscribe(eventPubSub);

        const fiber = yield* pipe(
          runProcessingLoop("test-session", actionQueue, eventPubSub, sandboxCtx),
          Effect.provide(uiMock.layer),
          Effect.provide(eventLogMock.layer),
          Effect.fork
        );

        yield* Queue.offer(actionQueue, {
          type: "prompt",
          prompt: "build a dashboard",
        });

        yield* Effect.sleep("100 millis");

        const chunk = yield* Queue.takeAll(subscription);
        const events = Chunk.toReadonlyArray(chunk);

        expect(uiMock.callLog).toHaveLength(1);
        expect(uiMock.callLog[0].actions).toHaveLength(1);
        expect(uiMock.callLog[0].actions[0].prompt).toBe("build a dashboard");

        expect(events).toHaveLength(3);
        expect(events[0].type).toBe("session");
        expect(events[0].offset).toBe(0);
        expect(events[1].type).toBe("patch");
        expect(events[1].offset).toBe(1);
        expect(events[2].type).toBe("done");
        expect(events[2].offset).toBe(2);

        expect(eventLogMock.appendedEvents).toHaveLength(3);
        expect(eventLogMock.appendedEvents[0].offset).toBe(0);
        expect(eventLogMock.appendedEvents[1].offset).toBe(1);
        expect(eventLogMock.appendedEvents[2].offset).toBe(2);

        yield* Fiber.interrupt(fiber);
      })
    )
  );

  it.live("batches multiple queued actions into a single request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const uiMock = makeUIServiceMock();
        const eventLogMock = makeDurableEventLogMock();

        const actionQueue = yield* Queue.unbounded<Action>();
        const eventPubSub = yield* PubSub.unbounded<StreamEventWithOffset>();

        const sandboxCtx = yield* makeSandboxCtx();

        // Enqueue multiple actions BEFORE starting the loop
        yield* Queue.offer(actionQueue, {
          type: "prompt",
          prompt: "add a header",
        });
        yield* Queue.offer(actionQueue, {
          type: "action",
          action: "increment",
        });
        yield* Queue.offer(actionQueue, {
          type: "prompt",
          prompt: "make it blue",
        });

        const fiber = yield* pipe(
          runProcessingLoop("test-session", actionQueue, eventPubSub, sandboxCtx),
          Effect.provide(uiMock.layer),
          Effect.provide(eventLogMock.layer),
          Effect.fork
        );

        yield* Effect.sleep("100 millis");

        expect(uiMock.callLog).toHaveLength(1);
        expect(uiMock.callLog[0].actions).toHaveLength(3);
        expect(uiMock.callLog[0].actions[0].prompt).toBe("add a header");
        expect(uiMock.callLog[0].actions[1].action).toBe("increment");
        expect(uiMock.callLog[0].actions[2].prompt).toBe("make it blue");

        yield* Fiber.interrupt(fiber);
      })
    )
  );

  it.live("publishes to PubSub before persisting to event log", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const operationLog: string[] = [];

        const uiLayer = Layer.succeed(UIService, {
          generateStream: () =>
            Effect.succeed(
              Stream.fromIterable([
                { type: "done", html: "<div>test</div>" } as StreamEvent,
              ])
            ),
          resolveSession: () =>
            Effect.succeed({ sessionId: "s", currentHtml: null }),
        } as unknown as UIService);

        const eventLogLayer = Layer.succeed(DurableEventLog, {
          append: () =>
            Effect.gen(function* () {
              yield* Effect.yieldNow();
              operationLog.push("append");
            }),
          getLatestOffset: () => Effect.succeed(-1),
          readFrom: () => Effect.succeed([]),
          getLastHtmlEvent: () => Effect.succeed(null),
          cleanup: Effect.succeed(0),
        } as unknown as DurableEventLog);

        const actionQueue = yield* Queue.unbounded<Action>();
        const eventPubSub = yield* PubSub.unbounded<StreamEventWithOffset>();
        const sandboxCtx = yield* makeSandboxCtx();

        const subscription = yield* PubSub.subscribe(eventPubSub);
        yield* Effect.fork(
          Effect.forever(
            Effect.gen(function* () {
              yield* Queue.take(subscription);
              operationLog.push("publish");
            })
          )
        );

        const fiber = yield* pipe(
          runProcessingLoop("test-session", actionQueue, eventPubSub, sandboxCtx),
          Effect.provide(uiLayer),
          Effect.provide(eventLogLayer),
          Effect.fork
        );

        yield* Queue.offer(actionQueue, { type: "prompt", prompt: "test" });
        yield* Effect.sleep("100 millis");

        expect(operationLog).toEqual(["publish", "append"]);

        yield* Fiber.interrupt(fiber);
      })
    )
  );

  it.live("continues offsets from event log on startup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const uiMock = makeUIServiceMock();
        const eventLogMock = makeDurableEventLogMock(5);

        const actionQueue = yield* Queue.unbounded<Action>();
        const eventPubSub = yield* PubSub.unbounded<StreamEventWithOffset>();
        const sandboxCtx = yield* makeSandboxCtx();

        const fiber = yield* pipe(
          runProcessingLoop("test-session", actionQueue, eventPubSub, sandboxCtx),
          Effect.provide(uiMock.layer),
          Effect.provide(eventLogMock.layer),
          Effect.fork
        );

        yield* Queue.offer(actionQueue, { type: "prompt", prompt: "test" });
        yield* Effect.sleep("100 millis");

        expect(eventLogMock.appendedEvents[0].offset).toBe(6);
        expect(eventLogMock.appendedEvents[1].offset).toBe(7);
        expect(eventLogMock.appendedEvents[2].offset).toBe(8);

        yield* Fiber.interrupt(fiber);
      })
    )
  );

  it.live("processes sequential requests with accumulating offsets", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const uiMock = makeUIServiceMock([
          [
            { type: "session", sessionId: "s" },
            { type: "done", html: "<div>first</div>" },
          ],
          [
            { type: "patch", patch: { selector: "#root", text: "updated" } },
            { type: "done", html: "<div>updated</div>" },
          ],
        ]);
        const eventLogMock = makeDurableEventLogMock();

        const actionQueue = yield* Queue.unbounded<Action>();
        const eventPubSub = yield* PubSub.unbounded<StreamEventWithOffset>();
        const sandboxCtx = yield* makeSandboxCtx();

        const fiber = yield* pipe(
          runProcessingLoop("test-session", actionQueue, eventPubSub, sandboxCtx),
          Effect.provide(uiMock.layer),
          Effect.provide(eventLogMock.layer),
          Effect.fork
        );

        yield* Queue.offer(actionQueue, { type: "prompt", prompt: "first" });
        yield* Effect.sleep("100 millis");

        yield* Queue.offer(actionQueue, { type: "prompt", prompt: "second" });
        yield* Effect.sleep("100 millis");

        expect(uiMock.callLog).toHaveLength(2);
        expect(eventLogMock.appendedEvents.map((e) => e.offset)).toEqual([
          0, 1, 2, 3,
        ]);

        yield* Fiber.interrupt(fiber);
      })
    )
  );
});
