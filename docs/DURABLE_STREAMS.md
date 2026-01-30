# Durable Streams for Generative UI

A purely functional approach using Effect for reconnectable streams and action batching.

---

## Goals

1. **Reconnectable streams** - Page refresh resumes from last received event
2. **Action batching** - Rapid clicks become single LLM call
3. **Resource efficiency** - Sessions go dormant after inactivity
4. **Pure functional** - No throwing, Effect-based error handling

---

## Core Concepts

### SessionProcessor

Each active session has a **SessionProcessor** - a long-running Effect fiber that:
- Owns an **ActionQueue** (`Queue.unbounded<Action>`) for incoming actions
- Owns an **EventHub** (`Hub.unbounded<StreamEvent>`) for broadcasting to subscribers
- Runs a processing loop: dequeue actions → call LLM → emit events
- Writes all events to **DurableEventLog** for reconnection

### ProcessorRegistry

A `Ref<HashMap<SessionId, SessionProcessor>>` that:
- Manages lifecycle of all active processors
- Lazily creates processors on first request
- Tracks last activity time per processor
- Releases dormant processors after timeout

### DurableEventLog

SQLite-backed event storage:
- `stream_events(session_id, offset, event_type, data, created_at)`
- Sequential offsets per session for resumption
- TTL cleanup for old events

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              HTTP Layer                                  │
│  POST /generate/stream ─────────────────────────────────────────────────│
│       │                                                                  │
│       ▼                                                                  │
│  ┌─────────────┐     ┌──────────────────────────────────────────────┐   │
│  │  Request    │     │           ProcessorRegistry                   │   │
│  │  Handler    │────▶│  Ref<HashMap<SessionId, SessionProcessor>>   │   │
│  └─────────────┘     │                                               │   │
│       │              │  - getOrCreate(sessionId)                     │   │
│       │              │  - touch(sessionId) // reset inactivity       │   │
│       │              │  - release(sessionId) // go dormant           │   │
│       │              └──────────────────────────────────────────────┘   │
│       │                              │                                   │
│       ▼                              ▼                                   │
│  ┌─────────────┐     ┌──────────────────────────────────────────────┐   │
│  │   SSE       │     │           SessionProcessor                    │   │
│  │  Response   │◀────│                                               │   │
│  │  (subscribe │     │  ┌─────────────┐    ┌─────────────────────┐  │   │
│  │   to Hub)   │     │  │ ActionQueue │───▶│   Processing Loop   │  │   │
│  └─────────────┘     │  │ Queue<Act>  │    │   (Fiber)           │  │   │
│                      │  └─────────────┘    │                     │  │   │
│                      │                     │  dequeue → batch    │  │   │
│                      │                     │  → LLM → emit       │  │   │
│                      │                     └──────────┬──────────┘  │   │
│                      │                                │             │   │
│                      │  ┌─────────────┐    ┌──────────▼──────────┐  │   │
│                      │  │  EventHub   │◀───│  DurableEventLog    │  │   │
│                      │  │ Hub<Event>  │    │  (SQLite)           │  │   │
│                      │  └─────────────┘    └─────────────────────┘  │   │
│                      └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Interaction Flows

### Flow 1: User clicks a button (fresh session)

```
User clicks [+1]
       │
       ▼
POST /generate/stream { sessionId, action: "increment" }
       │
       ▼
ProcessorRegistry.getOrCreate(sessionId)
       │
       ├─── Processor doesn't exist
       │           │
       │           ▼
       │    Create SessionProcessor:
       │      1. actionQueue = Queue.unbounded<Action>()
       │      2. eventHub = Hub.unbounded<StreamEvent>()
       │      3. Fork processing loop fiber
       │      4. Store in registry Ref
       │
       ▼
Queue.offer(actionQueue, { action: "increment", data: {...} })
       │
       ▼
Subscribe to eventHub, return SSE response
       │
       ▼
Processing loop (in fiber):
  1. Queue.take(actionQueue)  // gets the increment action
  2. Build LLM request with current HTML
  3. Stream LLM response
  4. For each patch:
     a. DurableEventLog.append(sessionId, offset++, patch)
     b. Hub.publish(eventHub, patch)
  5. Loop back to step 1
       │
       ▼
SSE sends events to client as Hub publishes them
```

### Flow 2: User clicks 3 more times during active generation

```
Processing loop is busy calling LLM for first click...

User clicks [+1] ──▶ Queue.offer(action2) ──▶ Queue has: [action2]
User clicks [+1] ──▶ Queue.offer(action3) ──▶ Queue has: [action2, action3]
User clicks [+1] ──▶ Queue.offer(action4) ──▶ Queue has: [action2, action3, action4]

Processing loop finishes first generation, goes to step 1:
  1. Queue.takeBetween(1, 10)  // Take up to 10 pending actions
     Returns: [action2, action3, action4]

  2. Batch into single request:
     action: "batch"
     data: { summary: "increment (3 times)", actions: [...] }

  3. Single LLM call handles all 3 increments
  4. Emit patches (e.g., counter goes from 1 to 4)
  5. Loop continues
```

### Flow 3: User refreshes page mid-generation

```
Generation in progress, events 0-5 already emitted...

User refreshes browser
       │
       ▼
Page loads, checks localStorage:
  { sessionId: "abc", lastOffset: 3 }
       │
       ▼
POST /generate/stream { sessionId: "abc", reconnect: true, fromOffset: 3 }
       │
       ▼
ProcessorRegistry.getOrCreate("abc")
       │
       ├─── Processor still exists (generation ongoing)
       │
       ▼
1. Read missed events from DurableEventLog:
   SELECT * FROM stream_events
   WHERE session_id = "abc" AND offset > 3
   Returns: [event4, event5]

2. Send missed events immediately via SSE

3. Subscribe to eventHub for live events (event6, event7, ...)

4. Client receives: event4, event5, event6, event7...
   No gaps, seamless resume
```

### Flow 4: User disconnects, comes back later

```
User closes tab
       │
       ▼
SSE connection closes (client unsubscribes from Hub)
       │
       ▼
Processing loop continues if actions pending
Events still written to DurableEventLog
       │
       ▼
No new requests for 5 minutes...
       │
       ▼
Dormancy check fiber (runs every 60s):
  1. Iterate ProcessorRegistry
  2. Find processors where (now - lastActivity) > DORMANT_TIMEOUT
  3. For each stale processor:
     a. Fiber.interrupt(processingFiber)
     b. Queue.shutdown(actionQueue)
     c. Hub.shutdown(eventHub)
     d. Remove from registry Ref
     e. Session state remains in DurableEventLog
       │
       ▼
User returns 30 minutes later
       │
       ▼
POST /generate/stream { sessionId: "abc", reconnect: true, fromOffset: 50 }
       │
       ▼
ProcessorRegistry.getOrCreate("abc")
       │
       ├─── Processor doesn't exist (went dormant)
       │           │
       │           ▼
       │    Rehydrate from DurableEventLog:
       │      1. Create fresh SessionProcessor
       │      2. Load last known state (HTML) from event log
       │      3. Resume processing
       │
       ▼
Send any events after offset 50 (probably none if generation completed)
Subscribe to eventHub for new events
```

### Flow 5: Generation completes while user disconnected

```
Processing loop emits final "done" event
       │
       ▼
DurableEventLog.append(sessionId, "done", { html: finalHtml })
Hub.publish("done", { html: finalHtml })
       │
       ▼
No subscribers (user disconnected) - Hub publish is no-op
       │
       ▼
Processing loop: Queue.take() blocks waiting for next action
       │
       ▼
After DORMANT_TIMEOUT with no activity:
  Processor goes dormant (resources freed)
       │
       ▼
User returns, reconnects with fromOffset: 10
       │
       ▼
Read from DurableEventLog: events 11-15 including "done"
       │
       ▼
Client receives all missed events, sees final UI
No new processor needed (nothing to generate)
```

---

## Why Not Effect Cache with TTL?

Effect's `Cache` with TTL seems like a natural fit for managing SessionProcessors:

```typescript
// Tempting, but doesn't work for our use case
const processorCache = yield* Cache.make({
  capacity: 1000,
  timeToLive: Duration.minutes(5),
  lookup: (sessionId: string) => makeSessionProcessor(sessionId),
});
```

**The problem:** Cache has no finalizer callback on eviction. When a cached value expires:
- Cache simply drops the reference
- Our fiber keeps running (leaked)
- Queue and Hub are never shut down (leaked resources)
- Memory grows unbounded

**Cache is designed for:**
- Pure computed values (no cleanup needed)
- Idempotent lookups (can recompute safely)

**Our SessionProcessor needs:**
- Active resource cleanup (fiber interrupt, queue/hub shutdown)
- Controlled lifecycle (not just "forget about it")

**Solution:** Manual registry with `Ref<HashMap>` + dormancy checker fiber. This gives us explicit control over the release lifecycle.

---

## Resource Lifecycle with Effect

### SessionProcessor as Scoped Resource

```typescript
const makeSessionProcessor = (sessionId: string) =>
  Effect.acquireRelease(
    // Acquire
    Effect.gen(function* () {
      const actionQueue = yield* Queue.unbounded<Action>();
      const eventHub = yield* Hub.unbounded<StreamEvent>();
      const lastActivity = yield* Ref.make(Date.now());

      // Fork the processing loop
      const fiber = yield* pipe(
        processingLoop(sessionId, actionQueue, eventHub),
        Effect.fork,
      );

      return { sessionId, actionQueue, eventHub, lastActivity, fiber };
    }),
    // Release
    (processor) =>
      Effect.gen(function* () {
        yield* Effect.log(`Releasing processor for ${processor.sessionId}`);
        yield* Fiber.interrupt(processor.fiber);
        yield* Queue.shutdown(processor.actionQueue);
        yield* Hub.shutdown(processor.eventHub);
      }),
  );
```

### ProcessorRegistry with Lazy Creation

```typescript
type ProcessorRegistry = {
  readonly getOrCreate: (sessionId: string) => Effect.Effect<SessionProcessor>;
  readonly touch: (sessionId: string) => Effect.Effect<void>;
  readonly release: (sessionId: string) => Effect.Effect<void>;
};

const makeProcessorRegistry = Effect.gen(function* () {
  const processors = yield* Ref.make(HashMap.empty<string, SessionProcessor>());
  const scope = yield* Effect.scope;

  const getOrCreate = (sessionId: string) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(processors);
      const existing = HashMap.get(current, sessionId);

      if (Option.isSome(existing)) {
        yield* touch(sessionId);
        return existing.value;
      }

      // Create new processor within our scope
      const processor = yield* pipe(
        makeSessionProcessor(sessionId),
        Scope.extend(scope),
      );

      yield* Ref.update(processors, HashMap.set(sessionId, processor));
      return processor;
    });

  const touch = (sessionId: string) =>
    pipe(
      Ref.get(processors),
      Effect.flatMap((map) =>
        pipe(
          HashMap.get(map, sessionId),
          Option.match({
            onNone: () => Effect.void,
            onSome: (p) => Ref.set(p.lastActivity, Date.now()),
          }),
        ),
      ),
    );

  const release = (sessionId: string) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(processors);
      const existing = HashMap.get(current, sessionId);

      if (Option.isSome(existing)) {
        // Trigger the acquireRelease finalizer
        yield* Scope.close(existing.value.scope, Exit.void);
        yield* Ref.update(processors, HashMap.remove(sessionId));
      }
    });

  return { getOrCreate, touch, release } as const;
});
```

### Dormancy Checker (Background Fiber)

```typescript
const DORMANT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const CHECK_INTERVAL_MS = 60 * 1000; // 1 minute

const dormancyChecker = (registry: ProcessorRegistry) =>
  pipe(
    Effect.gen(function* () {
      const now = Date.now();
      const processors = yield* Ref.get(registry.processors);

      yield* pipe(
        HashMap.toEntries(processors),
        Effect.forEach(([sessionId, processor]) =>
          Effect.gen(function* () {
            const lastActivity = yield* Ref.get(processor.lastActivity);
            if (now - lastActivity > DORMANT_TIMEOUT_MS) {
              yield* Effect.log(`Session ${sessionId} going dormant`);
              yield* registry.release(sessionId);
            }
          }),
        ),
      );
    }),
    Effect.repeat(Schedule.spaced(CHECK_INTERVAL_MS)),
    Effect.fork, // Run in background
  );
```

---

## Processing Loop

```typescript
const processingLoop = (
  sessionId: string,
  actionQueue: Queue.Queue<Action>,
  eventHub: Hub.Hub<StreamEvent>,
) =>
  Effect.gen(function* () {
    const generate = yield* GenerateService;
    const eventLog = yield* DurableEventLog;

    // Infinite loop - runs until fiber is interrupted
    yield* Effect.forever(
      Effect.gen(function* () {
        // Wait for at least one action, then grab any others waiting
        const actions = yield* Queue.takeBetween(actionQueue, 1, 10);

        // Batch if multiple actions
        const request = actions.length === 1
          ? buildSingleRequest(actions[0])
          : buildBatchRequest(actions);

        // Stream generation
        const stream = yield* generate.streamUnified(request);

        yield* pipe(
          stream,
          Stream.mapEffect((event) =>
            Effect.gen(function* () {
              // Persist to durable log
              const offset = yield* eventLog.append(sessionId, event);

              // Broadcast to subscribers
              yield* Hub.publish(eventHub, { ...event, offset });

              return event;
            }),
          ),
          Stream.runDrain,
        );
      }),
    );
  });
```

---

## HTTP Handler (Effect HTTP)

```typescript
const generateStreamHandler = HttpRouter.post(
  "/generate/stream",
  Effect.gen(function* () {
    const body = yield* HttpServerRequest.schemaBodyJson(GenerateRequestSchema);
    const registry = yield* ProcessorRegistry;
    const eventLog = yield* DurableEventLog;

    // Get or create processor
    const processor = yield* registry.getOrCreate(body.sessionId);

    // Handle reconnection
    const missedEvents = body.reconnect && body.fromOffset !== undefined
      ? yield* eventLog.readFrom(body.sessionId, body.fromOffset)
      : [];

    // Enqueue action if present
    if (body.action) {
      yield* Queue.offer(processor.actionQueue, {
        action: body.action,
        data: body.actionData,
      });
    }

    // Create SSE response
    const eventStream = pipe(
      // First: send missed events
      Stream.fromIterable(missedEvents),
      // Then: subscribe to live events
      Stream.concat(Stream.fromHub(processor.eventHub)),
      // Format as SSE
      Stream.map((event) =>
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
      ),
    );

    return HttpServerResponse.stream(eventStream, {
      contentType: "text/event-stream",
      headers: HttpHeaders.fromInput({
        "Cache-Control": "no-cache",
        "X-Session-Id": body.sessionId,
      }),
    });
  }),
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

      // Append event, return offset
      const append = (sessionId: string, event: StreamEvent) =>
        Effect.gen(function* () {
          // Atomic offset increment using SQL
          const result = yield* Effect.tryPromise(() =>
            db.run(sql`
              INSERT INTO stream_events (session_id, offset, event_type, data, created_at)
              SELECT
                ${sessionId},
                COALESCE(MAX(offset), -1) + 1,
                ${event.type},
                ${JSON.stringify(event)},
                ${Date.now()}
              FROM stream_events
              WHERE session_id = ${sessionId}
              RETURNING offset
            `)
          );
          return result.offset as number;
        });

      // Read events from offset
      const readFrom = (sessionId: string, fromOffset: number) =>
        Effect.tryPromise(() =>
          db.select()
            .from(streamEvents)
            .where(and(
              eq(streamEvents.sessionId, sessionId),
              gt(streamEvents.offset, fromOffset),
            ))
            .orderBy(asc(streamEvents.offset))
        );

      // Get latest offset for session
      const getLatestOffset = (sessionId: string) =>
        Effect.gen(function* () {
          const result = yield* Effect.tryPromise(() =>
            db.select({ offset: max(streamEvents.offset) })
              .from(streamEvents)
              .where(eq(streamEvents.sessionId, sessionId))
          );
          return result[0]?.offset ?? -1;
        });

      // Cleanup old events (called periodically)
      const cleanup = (maxAgeMs: number) =>
        Effect.tryPromise(() =>
          db.delete(streamEvents)
            .where(lt(streamEvents.createdAt, Date.now() - maxAgeMs))
        );

      return { append, readFrom, getLatestOffset, cleanup };
    }),
  },
) {}
```

---

## Frontend Changes

```typescript
// Persist stream state
const STREAM_KEY = "generative-ui-stream";

type StreamState = {
  sessionId: string;
  lastOffset: number;
};

const app = {
  streamState: null as StreamState | null,

  saveOffset(offset: number) {
    if (this.sessionId) {
      this.streamState = { sessionId: this.sessionId, lastOffset: offset };
      localStorage.setItem(STREAM_KEY, JSON.stringify(this.streamState));
    }
  },

  handleStreamEvent(event: StreamEvent & { offset: number }) {
    // Save offset for reconnection
    this.saveOffset(event.offset);

    // Existing handling...
    switch (event.type) { /* ... */ }
  },

  async connect(request: GenerateRequest) {
    const saved = this.loadStreamState();

    const response = await fetch("/generate/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...request,
        sessionId: saved?.sessionId ?? request.sessionId,
        reconnect: !!saved,
        fromOffset: saved?.lastOffset,
      }),
    });

    // Consume SSE, handling both missed and live events uniformly
    await this.consumeSSE(response);
  },

  async init() {
    const saved = this.loadStreamState();
    if (saved) {
      // Reconnect to potentially active stream
      await this.connect({ type: "generate", sessionId: saved.sessionId });
    } else {
      // Fresh start
      this.getElements().contentEl.innerHTML = INITIAL_HTML;
    }
  },
};
```

---

## State Reconstruction Strategy

When a processor goes dormant and later needs to be rehydrated, we need the current HTML state. Three options:

### Option A: Full Reconstruction (No State in DB)

Replay all events from the event log to reconstruct current HTML.

```typescript
const reconstructHtml = (sessionId: string) =>
  Effect.gen(function* () {
    const events = yield* eventLog.readFrom(sessionId, -1);

    let html = INITIAL_HTML;
    for (const event of events) {
      if (event.type === "html") {
        html = event.data.html;
      } else if (event.type === "patch") {
        html = applyPatch(html, event.data.patch);
      }
    }
    return html;
  });
```

| Pros | Cons |
|------|------|
| No additional storage | Slow for long sessions (many events) |
| Events are source of truth | Requires patch application logic on server |
| Simple schema | CPU-intensive on rehydration |

### Option B: Periodic Snapshots

Store HTML snapshots periodically, reconstruct from nearest snapshot.

```typescript
// New table
const snapshots = sqliteTable("session_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull(),
  offset: integer("offset").notNull(), // Snapshot taken at this offset
  html: text("html").notNull(),
  createdAt: integer("created_at").notNull(),
});

const reconstructHtml = (sessionId: string) =>
  Effect.gen(function* () {
    // Find latest snapshot
    const snapshot = yield* getLatestSnapshot(sessionId);
    const startOffset = snapshot?.offset ?? -1;
    const baseHtml = snapshot?.html ?? INITIAL_HTML;

    // Apply events after snapshot
    const events = yield* eventLog.readFrom(sessionId, startOffset);
    return applyEvents(baseHtml, events);
  });
```

| Pros | Cons |
|------|------|
| Fast reconstruction | Additional storage |
| Bounded replay time | Snapshot frequency tuning |
| Can delete old events after snapshot | More complex cleanup logic |

### Option C: Always Store Final HTML (Recommended)

Store HTML in the `done` event. Most sessions end with a `done` event.

```typescript
// done event already contains final HTML
{ type: "done", html: "<div>...</div>", offset: 42 }

const reconstructHtml = (sessionId: string) =>
  Effect.gen(function* () {
    // Find the last "done" or "html" event
    const lastHtmlEvent = yield* Effect.tryPromise(() =>
      db.select()
        .from(streamEvents)
        .where(and(
          eq(streamEvents.sessionId, sessionId),
          inArray(streamEvents.eventType, ["done", "html"]),
        ))
        .orderBy(desc(streamEvents.offset))
        .limit(1)
    );

    if (lastHtmlEvent[0]) {
      const data = JSON.parse(lastHtmlEvent[0].data);
      const baseHtml = data.html;

      // Apply any patches after this event
      const laterPatches = yield* eventLog.readFrom(sessionId, lastHtmlEvent[0].offset);
      return applyEvents(baseHtml, laterPatches);
    }

    // No done event yet - full reconstruction
    return yield* fullReconstruct(sessionId);
  });
```

| Pros | Cons |
|------|------|
| No extra storage (done event exists) | Requires patch replay if interrupted mid-generation |
| Fast for completed sessions | Slightly more complex query |
| Natural - done is the checkpoint | - |

**Decision:** Use Option C. The `done` event already captures final HTML. For interrupted sessions (rare), fall back to full reconstruction. This gives us fast rehydration for the common case with no schema changes.

---

## Event Log Cleanup with Turso

Global configuration: 24-hour retention.

### Turso Scheduled Cleanup

Turso supports scheduled statements. We can set up a daily cleanup job:

```sql
-- Run daily via Turso scheduled job or cron
DELETE FROM stream_events
WHERE created_at < unixepoch() * 1000 - 86400000; -- 24 hours in ms
```

### Application-Level Cleanup

Alternatively, run cleanup as part of the dormancy checker:

```typescript
const EVENT_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

const cleanupJob = pipe(
  Effect.gen(function* () {
    const cutoff = Date.now() - EVENT_RETENTION_MS;

    const deleted = yield* Effect.tryPromise(() =>
      db.delete(streamEvents)
        .where(lt(streamEvents.createdAt, cutoff))
        .returning({ count: count() })
    );

    if (deleted[0]?.count > 0) {
      yield* Effect.log(`Cleaned up ${deleted[0].count} old events`);
    }
  }),
  Effect.repeat(Schedule.spaced(Duration.hours(1))),
  Effect.fork,
);
```

### Cleanup with Snapshots (If Using Option B)

If using periodic snapshots, we can be more aggressive:

```typescript
// Delete events older than the oldest needed snapshot
const cleanupWithSnapshots = (sessionId: string) =>
  Effect.gen(function* () {
    const oldestNeededSnapshot = yield* getOldestActiveSnapshot(sessionId);
    if (oldestNeededSnapshot) {
      yield* Effect.tryPromise(() =>
        db.delete(streamEvents)
          .where(and(
            eq(streamEvents.sessionId, sessionId),
            lt(streamEvents.offset, oldestNeededSnapshot.offset),
          ))
      );
    }
  });
```

---

## Rate Limiting

Use Effect's `RateLimiter` to protect against abuse and manage LLM costs.

### Rate Limiter Types

```typescript
import { RateLimiter } from "effect";

// Per-session: max 10 actions per minute
const sessionRateLimiter = (sessionId: string) =>
  RateLimiter.make({ limit: 10, interval: Duration.minutes(1) });

// Global: max 100 concurrent LLM calls
const globalConcurrencyLimiter = Effect.makeSemaphore(100);

// Global: max 1000 LLM calls per minute (cost protection)
const globalRateLimiter = RateLimiter.make({
  limit: 1000,
  interval: Duration.minutes(1)
});
```

### Integration Points

**1. Action Enqueueing (Per-Session)**

```typescript
const enqueueAction = (sessionId: string, action: Action) =>
  Effect.gen(function* () {
    const limiter = yield* getSessionLimiter(sessionId);

    // This will block if rate exceeded
    yield* RateLimiter.take(limiter, 1);

    const processor = yield* registry.getOrCreate(sessionId);
    yield* Queue.offer(processor.actionQueue, action);
  });
```

**2. LLM Call (Global)**

```typescript
const processingLoop = (...) =>
  Effect.gen(function* () {
    const globalLimiter = yield* GlobalRateLimiter;
    const concurrencySem = yield* GlobalConcurrencySemaphore;

    yield* Effect.forever(
      Effect.gen(function* () {
        const actions = yield* Queue.takeBetween(actionQueue, 1, 10);

        // Acquire both rate limit and concurrency permit
        yield* RateLimiter.take(globalLimiter, 1);

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Semaphore.withPermit(concurrencySem)(
              streamLLMResponse(actions)
            );
          })
        );
      })
    );
  });
```

### Rate Limiter Registry

Per-session limiters need lifecycle management (similar to processors):

```typescript
export class RateLimiterRegistry extends Effect.Service<RateLimiterRegistry>()(
  "RateLimiterRegistry",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const limiters = yield* Ref.make(HashMap.empty<string, RateLimiter>());

      const getOrCreate = (sessionId: string) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(limiters);
          const existing = HashMap.get(current, sessionId);

          if (Option.isSome(existing)) {
            return existing.value;
          }

          const limiter = yield* RateLimiter.make({
            limit: 10,
            interval: Duration.minutes(1),
          });

          yield* Ref.update(limiters, HashMap.set(sessionId, limiter));
          return limiter;
        });

      // Clean up limiters for dormant sessions
      const remove = (sessionId: string) =>
        Ref.update(limiters, HashMap.remove(sessionId));

      return { getOrCreate, remove };
    }),
  }
) {}
```

### Rate Limit Exceeded Response

When rate limited, return appropriate HTTP response:

```typescript
const enqueueAction = (sessionId: string, action: Action) =>
  pipe(
    Effect.gen(function* () {
      const limiter = yield* rateLimiterRegistry.getOrCreate(sessionId);
      yield* RateLimiter.take(limiter, 1);
      // ... enqueue
    }),
    Effect.timeout(Duration.seconds(5)), // Don't wait forever
    Effect.catchTag("TimeoutException", () =>
      Effect.fail(new RateLimitExceeded({ sessionId }))
    ),
  );

// In HTTP handler
Effect.catchTag("RateLimitExceeded", (err) =>
  HttpServerResponse.json(
    { error: "Rate limit exceeded", retryAfter: 60 },
    { status: 429 }
  )
);
```

---

## Design Decisions Summary

| Question | Decision | Rationale |
|----------|----------|-----------|
| Batching strategy | Take whatever is queued | Simple, no artificial delays |
| Hub vs PubSub | Hub + offset reconnection | Offset-based is sufficient, simpler |
| Event retention | 24h global | Balance storage vs. reconnection window |
| State reconstruction | Option C (done event) | Fast for common case, no extra storage |
| Rate limiting | Per-session + global | Protect against abuse and costs |

---

## Next Steps

Once this high-level design is approved:

1. Define exact service interfaces with Effect types
2. Add `stream_events` table with Drizzle migration
3. Implement `DurableEventLog` service
4. Implement `ProcessorRegistry` with Ref + HashMap + acquireRelease
5. Implement `RateLimiterRegistry` service
6. Modify `GenerateService` to work with Queue/Hub pattern
7. Add HTTP handlers with reconnection logic
8. Add dormancy checker and cleanup background fibers
9. Frontend: localStorage offset tracking and reconnection
10. Testing: reconnection scenarios, rate limiting, batching
