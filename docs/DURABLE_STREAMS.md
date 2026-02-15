# Durable Streams for Generative UI

A purely functional approach using Effect for reconnectable streams and action batching.

---

## Goals

1. **Reconnectable streams** - Page refresh resumes from last received event
2. **Action batching** - Rapid clicks become single LLM call
3. **Resource efficiency** - Sessions go dormant after inactivity
4. **Pure functional** - No throwing, Effect-based error handling

---

## Endpoint Design

Following the durable streams protocol, we split action submission from event consumption:

### `POST /stream/:sessionId` -- Submit Action
- Pushes action/prompt into the session's `Queue<Action>`
- Returns `202 Accepted` immediately (fire-and-forget)
- Does NOT stream back results
- Creates the SessionProcessor lazily via `getOrCreate`

### `GET /stream/:sessionId?offset=X&live=sse` -- Subscribe to Events
- Subscribes to the session's `PubSub<StreamEventWithOffset>` for real-time patches
- Optional `offset` query param for catch-up replay from DB
- Returns long-lived SSE stream
- Also creates the SessionProcessor lazily via `getOrCreate`

---

## Core Concepts

### SessionProcessor

Each active session has a **SessionProcessor** - a long-running Effect fiber that:
- Owns an **ActionQueue** (`Queue.unbounded<Action>`) for incoming actions (fed by POST)
- Owns an **EventPubSub** (`PubSub.unbounded<StreamEventWithOffset>`) for broadcasting to SSE subscribers (consumed by GET)
- Runs a processing loop: dequeue actions → call LLM via `UIService.generateStream` → dual-write events
- **Dual-write**: each validated patch is written to both the **DurableEventLog** (Turso DB) and published to the **PubSub** (in-memory, real-time)

### ProcessorRegistry

A `Ref<HashMap<SessionId, SessionProcessor>>` that:
- Manages lifecycle of all active processors
- Lazily creates processors on first request (POST or GET, whichever comes first)
- Tracks last activity time per processor
- Uses a `Semaphore(1)` to prevent race conditions during creation
- Releases dormant processors after timeout

### DurableEventLog

SQLite-backed event storage (Turso):
- `stream_events(session_id, offset, event_type, data, created_at)` in the shared schema
- Sequential offsets per session for resumption (single-writer guarantee from processing fiber)
- TTL cleanup for old events
- Only queried on reconnect/catch-up, NOT for live streaming

---

## Architecture Diagram

```
Frontend
  ┌───────────────────────┐     ┌────────────────────────────────────┐
  │ POST /stream/:sid     │     │ GET /stream/:sid?offset=X&live=sse │
  │ (fire-and-forget)     │     │ (long-lived SSE via EventSource)   │
  └──────────┬────────────┘     └─────────────────┬──────────────────┘
             │                                    │
═════════════╪════════════════════════════════════╪══════════════════
             │            Backend                 │
  ┌──────────▼────────────────────────────────────▼──────────────────┐
  │                    ProcessorRegistry                             │
  │              Ref<HashMap<SessionId, SessionProcessor>>           │
  │                                                                  │
  │  ┌────────────────────────────────────────────────────────────┐  │
  │  │              SessionProcessor (per session)                │  │
  │  │                                                            │  │
  │  │  ActionQueue ──► Processing Fiber ──► EventPubSub          │  │
  │  │  Queue<Action>   (dequeue → UIService.generateStream       │  │
  │  │                   → dual-write each event)                 │  │
  │  │                       │              │                     │  │
  │  │                       ▼              ▼                     │  │
  │  │              DurableEventLog    PubSub.publish()           │  │
  │  │              (Turso DB)         (in-memory, real-time)     │  │
  │  └────────────────────────────────────────────────────────────┘  │
  └──────────────────────────────────────────────────────────────────┘
```

---

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Session ID generation | Client generates cuid2 | Avoids extra roundtrip; `@paralleldrive/cuid2` already a dependency |
| PubSub subscription timing | Subscribe BEFORE DB read | Prevents missed events during the catch-up gap |
| Deduplication | Filter PubSub events by `offset > dbMaxOffset` | Simple, correct, no complex state needed |
| SSE connection lifecycle | Long-lived, survives across generations | Client keeps EventSource open; `done` events signal generation complete |
| Processing loop | Reuses `UIService.generateStream` | Avoids duplicating VDOM/memory/session logic |
| Offset assignment | Sequential per session, single-writer | Processing fiber is the only writer per session; safe without transactions |
| Batching strategy | Take whatever is queued | Simple, no artificial delays |
| Event retention | 10 minutes | Short retention for reconnection, minimal storage |
| State reconstruction | Done event contains final HTML | Fast for common case, no extra storage |

---

## Interaction Flows

### Flow 1: Fresh session (user types first prompt)

```
Client generates sessionId via cuid2
       │
       ├─── GET /stream/:sessionId?live=sse
       │       │
       │       ▼
       │    ProcessorRegistry.getOrCreate(sessionId)
       │       │
       │       ├─── Processor doesn't exist → create:
       │       │      1. actionQueue = Queue.unbounded<Action>()
       │       │      2. eventPubSub = PubSub.unbounded<StreamEventWithOffset>()
       │       │      3. Fork processing loop fiber
       │       │      4. Store in registry
       │       │
       │       ▼
       │    Subscribe to eventPubSub → SSE stream open (waiting for events)
       │
       ├─── POST /stream/:sessionId { prompt: "build a counter" }
       │       │
       │       ▼
       │    ProcessorRegistry.getOrCreate(sessionId) → already exists
       │    Queue.offer(actionQueue, { type: "prompt", prompt: "build a counter" })
       │    Return 202 Accepted
       │
       ▼
Processing loop (in fiber):
  1. Queue.takeBetween(actionQueue, 1, 10) → gets the prompt action
  2. UIService.generateStream(request)     → reuses existing LLM pipeline
  3. For each event in the stream:
     a. DurableEventLog.append(sessionId, event) → DB write, returns offset
     b. PubSub.publish(eventPubSub, { ...event, offset })
  4. Loop back to step 1
       │
       ▼
SSE delivers events to client as PubSub publishes them
Client stores lastOffset in localStorage for each received event
```

### Flow 2: User clicks 3 times during active generation (batching)

```
Processing loop is busy calling LLM for first action...

POST /stream/:sid { action: "increment" } → Queue has: [action2]
POST /stream/:sid { action: "increment" } → Queue has: [action2, action3]
POST /stream/:sid { action: "increment" } → Queue has: [action2, action3, action4]

Processing loop finishes first generation, goes to step 1:
  1. Queue.takeBetween(1, 10) → takes all 3: [action2, action3, action4]

  2. Batch into single UIRequest:
     action: "batch"
     actionData: { summary: "increment (3x)", actions: [...] }

  3. Single LLM call handles all 3 increments
  4. Emit patches via dual-write
  5. Loop continues
```

### Flow 3: User refreshes page mid-generation (reconnection)

```
Generation in progress, events 0-5 already emitted...

User refreshes browser
       │
       ▼
Page loads, checks localStorage:
  { sessionId: "abc", lastOffset: 3 }
       │
       ▼
GET /stream/abc?offset=3&live=sse
       │
       ▼
ProcessorRegistry.getOrCreate("abc")
       │
       ├─── Processor still exists (generation ongoing)
       │
       ▼
Subscribe-first-then-replay:
  1. Subscribe to PubSub FIRST (buffered — events accumulate)
  2. Read DB: SELECT * FROM stream_events WHERE offset > 3
     Returns: [event4, event5]
  3. Note dbMaxOffset = 5
  4. Stream DB events first (event4, event5)
  5. Drain PubSub subscriber, filter offset <= 5 (dedup)
  6. Continue live: event6, event7...

Client receives: event4, event5, event6, event7...
No gaps, seamless resume
```

### Flow 4: User disconnects, comes back later

```
User closes tab
       │
       ▼
SSE connection closes (PubSub subscription cleaned up automatically)
       │
       ▼
Processing loop continues if actions pending
Events still dual-written (DB persists, PubSub publish is no-op with no subscribers)
       │
       ▼
No new requests for 5 minutes...
       │
       ▼
Dormancy check fiber (runs every 60s):
  1. Iterate ProcessorRegistry
  2. Find processors where (now - lastActivity) > DORMANT_TIMEOUT
  3. For each stale processor:
     a. Scope.close(processor.scope) → interrupts fiber, shuts down queue/pubsub
     b. Remove from registry
     c. Session state remains in DurableEventLog
       │
       ▼
User returns 30 minutes later
       │
       ▼
GET /stream/abc?offset=50&live=sse
       │
       ▼
ProcessorRegistry.getOrCreate("abc")
       │
       ├─── Processor doesn't exist (went dormant)
       │           │
       │           ▼
       │    Create fresh SessionProcessor
       │    Processing fiber starts, blocks on Queue.take (no pending actions)
       │
       ▼
Replay from DB: events after offset 50 (probably including "done" event)
Subscribe to PubSub for future events
Client sees final UI state
```

### Flow 5: Generation completes while user disconnected

```
Processing loop emits final "done" event
       │
       ▼
DurableEventLog.append(sessionId, { type: "done", html: finalHtml })
PubSub.publish({ type: "done", html: finalHtml, offset: 42 })
       │
       ▼
No subscribers — PubSub publish is no-op
       │
       ▼
Processing loop: Queue.take() blocks waiting for next action
       │
       ▼
After DORMANT_TIMEOUT with no activity:
  Processor goes dormant (resources freed)
       │
       ▼
User returns, reconnects with offset=10
       │
       ▼
Replay from DurableEventLog: events 11-42 including "done"
Client receives all missed events, sees final UI
```

---

## Why Not Effect Cache with TTL?

Effect's `Cache` with TTL seems like a natural fit for managing SessionProcessors:

```typescript
const processorCache = yield* Cache.make({
  capacity: 1000,
  timeToLive: Duration.minutes(5),
  lookup: (sessionId: string) => makeSessionProcessor(sessionId),
});
```

**The problem:** Cache has no finalizer callback on eviction. When a cached value expires:
- Cache simply drops the reference
- Our fiber keeps running (leaked)
- Queue and PubSub are never shut down (leaked resources)
- Memory grows unbounded

**Solution:** Manual registry with `Ref<HashMap>` + dormancy checker fiber. This gives us explicit control over the release lifecycle.

---

## Resource Lifecycle with Effect

### SessionProcessor Creation

```typescript
const createProcessor = (sessionId: string) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const actionQueue = yield* Queue.unbounded<Action>();
    const eventPubSub = yield* PubSub.unbounded<StreamEventWithOffset>();
    const lastActivity = yield* Ref.make(Date.now());

    const fiber = yield* pipe(
      runProcessingLoop(sessionId, actionQueue, eventPubSub, deps),
      Effect.forkIn(scope),
    );

    return { sessionId, actionQueue, eventPubSub, lastActivity, fiber, scope };
  });
```

### ProcessorRegistry with Lazy Creation

```typescript
export class ProcessorRegistry extends Effect.Service<ProcessorRegistry>()(
  "ProcessorRegistry",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const processors = yield* Ref.make(HashMap.empty<string, SessionProcessor>());
      const creationLock = yield* Effect.makeSemaphore(1);

      const getOrCreate = (sessionId: string) =>
        creationLock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(processors);
            const existing = HashMap.get(current, sessionId);

            if (Option.isSome(existing)) {
              yield* Ref.set(existing.value.lastActivity, Date.now());
              return existing.value;
            }

            const processor = yield* createProcessor(sessionId);
            yield* Ref.update(processors, HashMap.set(sessionId, processor));
            return processor;
          })
        );

      const release = (sessionId: string) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(processors);
          const existing = HashMap.get(current, sessionId);

          if (Option.isSome(existing)) {
            yield* Scope.close(existing.value.scope, Exit.succeed(void 0));
            yield* Ref.update(processors, HashMap.remove(sessionId));
          }
        });

      return { getOrCreate, touch, release, getAllSessionIds, getLastActivity } as const;
    }),
  }
) {}
```

---

## Processing Loop

The processing loop reuses `UIService.generateStream` to avoid duplicating VDOM/memory/session logic. It consumes the stream and dual-writes each event.

```typescript
export const runProcessingLoop = (
  sessionId: string,
  actionQueue: Queue.Queue<Action>,
  eventPubSub: PubSub.PubSub<StreamEventWithOffset>,
  deps: ProcessorDeps,
) =>
  Effect.gen(function* () {
    yield* Effect.forever(
      Effect.gen(function* () {
        // Wait for at least one action, then grab any others waiting
        const actionsChunk = yield* Queue.takeBetween(actionQueue, 1, 10);
        const actions = Chunk.toReadonlyArray(actionsChunk);

        // Build UIRequest (single or batched)
        const request = actions.length === 1
          ? buildSingleRequest(sessionId, actions[0])
          : buildBatchRequest(sessionId, actions);

        // Get stream from UIService (reuses existing LLM pipeline)
        const stream = yield* deps.generateStream(request);

        // Consume stream, dual-writing each event
        yield* pipe(
          stream,
          Stream.mapEffect((event) =>
            Effect.gen(function* () {
              // 1. Persist to durable log (DB)
              const offset = yield* deps.appendEvent(sessionId, event);

              // 2. Broadcast to live subscribers (in-memory)
              const eventWithOffset = { ...event, offset };
              yield* PubSub.publish(eventPubSub, eventWithOffset);

              return eventWithOffset;
            }),
          ),
          Stream.runDrain,
        );
      }),
    );
  });
```

---

## HTTP Handlers

### POST `/stream/:sessionId` -- Submit Action

```typescript
handlers.handle("submit-action", ({ path, payload }) =>
  Effect.gen(function* () {
    const registry = yield* ProcessorRegistry;
    const processor = yield* registry.getOrCreate(path.sessionId);
    yield* registry.touch(path.sessionId);

    yield* Queue.offer(processor.actionQueue, {
      type: payload.prompt ? "prompt" : "action",
      prompt: payload.prompt,
      action: payload.action,
      actionData: payload.actionData,
      currentHtml: payload.currentHtml,
    });

    return { queued: true }; // 202 Accepted
  })
);
```

### GET `/stream/:sessionId?offset=X&live=sse` -- Subscribe to Events

```typescript
handlers.handle("subscribe", ({ path, urlParams }) =>
  Effect.gen(function* () {
    const registry = yield* ProcessorRegistry;
    const eventLog = yield* DurableEventLog;
    const processor = yield* registry.getOrCreate(path.sessionId);
    yield* registry.touch(path.sessionId);

    const clientOffset = urlParams.offset ?? -1;

    // STEP 1: Subscribe to PubSub FIRST (buffered)
    const pubSubStream = Stream.fromPubSub(processor.eventPubSub);

    // STEP 2: Read missed events from DB
    const missedRows = yield* eventLog.readFrom(path.sessionId, clientOffset);
    const dbMaxOffset = missedRows.length > 0
      ? missedRows[missedRows.length - 1].offset
      : clientOffset;

    // STEP 3: Convert DB rows to events
    const missedStream = Stream.fromIterable(
      missedRows.map((row) => ({
        ...(JSON.parse(row.data) as StreamEvent),
        offset: row.offset,
      }))
    );

    // STEP 4: Filter PubSub stream to skip already-sent events
    const deduplicatedPubSubStream = pipe(
      pubSubStream,
      Stream.filter((event) => event.offset > dbMaxOffset),
    );

    // STEP 5: Compose: replay first, then live
    const eventStream = pipe(
      Stream.concat(missedStream, deduplicatedPubSubStream),
      Stream.map((event) =>
        `id: ${event.offset}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
      ),
    );

    return HttpServerResponse.stream(eventStream, {
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
      },
    });
  })
);
```

---

## DurableEventLog Service

```typescript
export class DurableEventLog extends Effect.Service<DurableEventLog>()(
  "DurableEventLog",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const { db } = yield* Database;

      const append = (sessionId: string, event: StreamEvent) =>
        Effect.gen(function* () {
          const maxOffsetResult = yield* Effect.promise(() =>
            db
              .select({ maxOffset: sql<number>`COALESCE(MAX(${streamEvents.offset}), -1)` })
              .from(streamEvents)
              .where(eq(streamEvents.sessionId, sessionId))
          );

          const nextOffset = (maxOffsetResult[0]?.maxOffset ?? -1) + 1;

          yield* Effect.promise(() =>
            db.insert(streamEvents).values({
              sessionId,
              offset: nextOffset,
              eventType: event.type,
              data: JSON.stringify(event),
              createdAt: Date.now(),
            })
          );

          return nextOffset;
        });

      const readFrom = (sessionId: string, fromOffset: number) =>
        Effect.promise(() =>
          db.select().from(streamEvents)
            .where(and(eq(streamEvents.sessionId, sessionId), gt(streamEvents.offset, fromOffset)))
            .orderBy(streamEvents.offset)
        );

      const getLatestOffset = (sessionId: string) =>
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            db.select({ maxOffset: sql<number>`COALESCE(MAX(${streamEvents.offset}), -1)` })
              .from(streamEvents)
              .where(eq(streamEvents.sessionId, sessionId))
          );
          return result[0]?.maxOffset ?? -1;
        });

      const getLastHtmlEvent = (sessionId: string) =>
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            db.select().from(streamEvents)
              .where(and(
                eq(streamEvents.sessionId, sessionId),
                sql`${streamEvents.eventType} IN ('done', 'html')`
              ))
              .orderBy(desc(streamEvents.offset))
              .limit(1)
          );
          return result[0] ?? null;
        });

      const cleanup = Effect.gen(function* () {
        const cutoff = Date.now() - DurableConfig.EVENT_RETENTION_MS;
        const result = yield* Effect.promise(() =>
          db.delete(streamEvents).where(lt(streamEvents.createdAt, cutoff))
        );
        return result.rowsAffected ?? 0;
      });

      return { append, readFrom, getLatestOffset, getLastHtmlEvent, cleanup } as const;
    }),
  }
) {}
```

---

## Frontend Changes

The frontend splits from a single `POST + read SSE response` into two separate operations:

- **EventSource** (GET) for subscribing to the event stream (long-lived, auto-reconnects)
- **fetch** (POST) for submitting actions (fire-and-forget)

```typescript
const app = {
  sessionId: null as string | null,
  eventSource: null as EventSource | null,
  lastOffset: -1,

  // Connect SSE (called once on page load or reconnect)
  connectSSE(sessionId: string) {
    if (this.eventSource) this.eventSource.close();

    const params = new URLSearchParams({ live: "sse" });
    if (this.lastOffset >= 0) params.set("offset", String(this.lastOffset));

    const url = `http://localhost:34512/stream/${sessionId}?${params}`;
    this.eventSource = new EventSource(url);

    for (const eventType of ["session", "patch", "html", "stats", "done"]) {
      this.eventSource.addEventListener(eventType, (e) => {
        const event = JSON.parse((e as MessageEvent).data);
        this.lastOffset = event.offset;
        this.saveStreamState();
        this.handleStreamEvent(event);
      });
    }

    this.eventSource.onerror = () => {
      // EventSource auto-reconnects; offset is in URL for catch-up
    };
  },

  // Submit action (fire-and-forget POST)
  async submitAction(request: { action?: string; prompt?: string; ... }) {
    if (!this.sessionId) {
      this.sessionId = createId(); // cuid2
      this.connectSSE(this.sessionId);
    }

    this.setLoading(true);

    await fetch(`http://localhost:34512/stream/${this.sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    // Response is 202 — results come via SSE
  },

  // Persist stream state for reconnection
  saveStreamState() {
    if (this.sessionId) {
      localStorage.setItem("generative-ui-stream", JSON.stringify({
        sessionId: this.sessionId,
        lastOffset: this.lastOffset,
      }));
    }
  },

  init() {
    const saved = loadStreamState();
    if (saved) {
      this.sessionId = saved.sessionId;
      this.lastOffset = saved.lastOffset;
      this.connectSSE(saved.sessionId);
    } else {
      contentEl.innerHTML = INITIAL_HTML;
      this.setLoading(false, true);
    }
    // ... rest of existing init
  },

  resetSession() {
    this.sessionId = null;
    this.lastOffset = -1;
    if (this.eventSource) this.eventSource.close();
    this.eventSource = null;
    localStorage.removeItem("generative-ui-stream");
    // ... rest of existing reset
  },
};
```

---

## State Reconstruction Strategy

When a processor goes dormant and later needs to be rehydrated, we use the `done` event which already contains the final HTML:

```typescript
const reconstructHtml = (sessionId: string) =>
  Effect.gen(function* () {
    const lastHtmlEvent = yield* eventLog.getLastHtmlEvent(sessionId);

    if (lastHtmlEvent) {
      const parsed = JSON.parse(lastHtmlEvent.data);
      const baseHtml = parsed.html;

      // Apply any patches after the last html/done event
      const laterPatches = yield* eventLog.readFrom(sessionId, lastHtmlEvent.offset);
      return applyEvents(baseHtml, laterPatches);
    }

    // No done event yet - full reconstruction from all events
    return yield* fullReconstruct(sessionId);
  });
```

For completed sessions (common case), this is a single DB query. For interrupted sessions (rare), it falls back to replaying all events.

---

## Background Jobs

### Dormancy Checker

```typescript
const dormancyChecker = Effect.gen(function* () {
  const registry = yield* ProcessorRegistry;

  yield* pipe(
    Effect.gen(function* () {
      const now = Date.now();
      const sessionIds = yield* registry.getAllSessionIds;

      for (const sessionId of sessionIds) {
        const lastActivity = yield* registry.getLastActivity(sessionId);
        if (lastActivity && now - lastActivity > DurableConfig.DORMANCY_TIMEOUT_MS) {
          yield* registry.release(sessionId);
        }
      }
    }),
    Effect.catchAll((error) => Effect.log(`Dormancy checker error: ${error}`)),
    Effect.repeat(Schedule.spaced(Duration.millis(DurableConfig.DORMANCY_CHECK_INTERVAL_MS))),
  );
});
```

### Event Cleanup

```typescript
const eventCleanup = Effect.gen(function* () {
  const eventLog = yield* DurableEventLog;

  yield* pipe(
    Effect.gen(function* () {
      const deleted = yield* eventLog.cleanup;
      if (deleted > 0) yield* Effect.log(`Cleaned up ${deleted} old events`);
    }),
    Effect.catchAll((error) => Effect.log(`Event cleanup error: ${error}`)),
    Effect.repeat(Schedule.spaced(Duration.millis(DurableConfig.CLEANUP_INTERVAL_MS))),
  );
});
```

---

## File Structure

```
apps/backend/src/services/
  durable/
    index.ts              -- Re-exports
    types.ts              -- Effect Schemas: Action, StreamEvent, ActionPayload, SessionProcessor, DurableConfig
    event-log.ts          -- DurableEventLog service (append, readFrom, getLatestOffset, cleanup)
    processor.ts          -- Processing loop (consumes UIService.generateStream, dual-writes)
    registry.ts           -- ProcessorRegistry service (getOrCreate, touch, release)
    jobs.ts               -- Dormancy checker + event cleanup background fibers
apps/backend/src/
  api.ts                  -- Modified: replace generate group with stream group (POST + GET)
  index.ts                -- Modified: wire new services into Layer composition
apps/backend/src/services/memory/
  schema.ts               -- Modified: added stream_events table to shared schema
apps/webpage/src/
  main.ts                 -- Modified: EventSource for GET SSE + fetch POST
```

---

## Implementation Order

1. **Phase 1:** Types and schema (`types.ts`, `schema.ts` update, drizzle generate)
2. **Phase 2:** DurableEventLog service (`event-log.ts`)
3. **Phase 3:** SessionProcessor processing loop (`processor.ts`)
4. **Phase 4:** ProcessorRegistry service (`registry.ts`)
5. **Phase 5:** Background jobs (`jobs.ts`)
6. **Phase 6:** HTTP endpoints - POST + GET SSE (`api.ts`)
7. **Phase 7:** Frontend changes (`main.ts`)
8. **Phase 8:** Wire layers + remove old endpoint (`index.ts`)
