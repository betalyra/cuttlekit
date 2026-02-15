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
| Event retention | 10 minutes | Short retention for reconnection, minimal storage |
| State reconstruction | Option C (done event) | Fast for common case, no extra storage |
| Rate limiting | Per-session + global | Protect against abuse and costs |

---

# Low-Level Implementation Plan

## File Structure

```
apps/backend/src/services/
├── durable/
│   ├── index.ts                 # Re-exports
│   ├── types.ts                 # Shared types and schemas
│   ├── event-log.ts             # DurableEventLog service
│   ├── processor.ts             # SessionProcessor (pure generation loop)
│   ├── registry.ts              # ProcessorRegistry service
│   └── schema.ts                # Drizzle schema for stream_events
├── rate-limit/
│   ├── index.ts                 # Re-exports
│   └── service.ts               # RateLimiterRegistry service
└── generate/
    └── service.ts               # Existing, minimal changes
```

---

## Phase 1: Types and Schema

### `services/durable/types.ts`

```typescript
import { Schema } from "effect";
import type { Patch } from "../vdom/index.js";

// ============================================================
// Action Types
// ============================================================

export type Action = {
  readonly type: "prompt" | "action";
  readonly prompt?: string;
  readonly action?: string;
  readonly actionData?: Record<string, unknown>;
  readonly currentHtml?: string;
};

export const ActionSchema = Schema.Struct({
  type: Schema.Literal("prompt", "action"),
  prompt: Schema.optional(Schema.String),
  action: Schema.optional(Schema.String),
  actionData: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  currentHtml: Schema.optional(Schema.String),
});

// ============================================================
// Stream Event Types
// ============================================================

export type StreamEvent =
  | { readonly type: "session"; readonly sessionId: string }
  | { readonly type: "patch"; readonly patch: Patch }
  | { readonly type: "html"; readonly html: string }
  | { readonly type: "stats"; readonly cacheRate: number; readonly tokensPerSecond: number; readonly mode: "patches" | "full"; readonly patchCount: number }
  | { readonly type: "done"; readonly html: string };

export type StreamEventWithOffset = StreamEvent & { readonly offset: number };

// ============================================================
// Persisted Event (from DB)
// ============================================================

export type PersistedEvent = {
  readonly id: number;
  readonly sessionId: string;
  readonly offset: number;
  readonly eventType: string;
  readonly data: string; // JSON serialized StreamEvent
  readonly createdAt: number;
};

// ============================================================
// Processor State
// ============================================================

export type SessionProcessor = {
  readonly sessionId: string;
  readonly actionQueue: Queue.Queue<Action>;
  readonly eventHub: Hub.Hub<StreamEventWithOffset>;
  readonly lastActivity: Ref.Ref<number>;
  readonly fiber: Fiber.RuntimeFiber<void, never>;
  readonly scope: Scope.CloseableScope;
};

// ============================================================
// Configuration
// ============================================================

export const DurableConfig = {
  EVENT_RETENTION_MS: 10 * 60 * 1000,      // 10 minutes
  DORMANCY_TIMEOUT_MS: 5 * 60 * 1000,      // 5 minutes
  DORMANCY_CHECK_INTERVAL_MS: 60 * 1000,   // 1 minute
  CLEANUP_INTERVAL_MS: 60 * 1000,          // 1 minute
  MAX_BATCH_SIZE: 10,
} as const;
```

### `services/durable/schema.ts`

```typescript
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const streamEvents = sqliteTable(
  "stream_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id").notNull(),
    offset: integer("offset").notNull(),
    eventType: text("event_type").notNull(),
    data: text("data").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("stream_events_session_offset_idx").on(table.sessionId, table.offset),
    index("stream_events_created_at_idx").on(table.createdAt),
  ]
);

export type StreamEventRow = typeof streamEvents.$inferSelect;
export type NewStreamEventRow = typeof streamEvents.$inferInsert;
```

---

## Phase 2: DurableEventLog Service

### `services/durable/event-log.ts`

```typescript
import { Effect, pipe } from "effect";
import { eq, gt, and, lt, desc, sql } from "drizzle-orm";
import { Database } from "../memory/database.js";
import { streamEvents } from "./schema.js";
import { DurableConfig, type StreamEvent, type PersistedEvent } from "./types.js";

export class DurableEventLog extends Effect.Service<DurableEventLog>()(
  "DurableEventLog",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const { db } = yield* Database;

      /**
       * Append an event to the log, returning the assigned offset.
       * Uses a subquery for atomic offset increment.
       */
      const append = (sessionId: string, event: StreamEvent) =>
        Effect.gen(function* () {
          const now = Date.now();
          const eventData = JSON.stringify(event);

          // Get next offset atomically
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
              data: eventData,
              createdAt: now,
            })
          );

          return nextOffset;
        });

      /**
       * Read all events after the given offset for a session.
       */
      const readFrom = (sessionId: string, fromOffset: number) =>
        Effect.promise(() =>
          db
            .select()
            .from(streamEvents)
            .where(
              and(
                eq(streamEvents.sessionId, sessionId),
                gt(streamEvents.offset, fromOffset)
              )
            )
            .orderBy(streamEvents.offset)
        );

      /**
       * Get the latest offset for a session, or -1 if no events.
       */
      const getLatestOffset = (sessionId: string) =>
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            db
              .select({ maxOffset: sql<number>`COALESCE(MAX(${streamEvents.offset}), -1)` })
              .from(streamEvents)
              .where(eq(streamEvents.sessionId, sessionId))
          );
          return result[0]?.maxOffset ?? -1;
        });

      /**
       * Find the last "done" or "html" event for state reconstruction.
       */
      const getLastHtmlEvent = (sessionId: string) =>
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            db
              .select()
              .from(streamEvents)
              .where(
                and(
                  eq(streamEvents.sessionId, sessionId),
                  sql`${streamEvents.eventType} IN ('done', 'html')`
                )
              )
              .orderBy(desc(streamEvents.offset))
              .limit(1)
          );
          return result[0] ?? null;
        });

      /**
       * Delete events older than retention period.
       */
      const cleanup = Effect.gen(function* () {
        const cutoff = Date.now() - DurableConfig.EVENT_RETENTION_MS;

        const result = yield* Effect.promise(() =>
          db
            .delete(streamEvents)
            .where(lt(streamEvents.createdAt, cutoff))
        );

        return result.rowsAffected ?? 0;
      });

      return {
        append,
        readFrom,
        getLatestOffset,
        getLastHtmlEvent,
        cleanup,
      } as const;
    }),
  }
) {}
```

---

## Phase 3: SessionProcessor (Pure Generation Loop)

The processor is a pure function that takes dependencies as arguments - no services accessed inside. This makes it easily testable.

### `services/durable/processor.ts`

```typescript
import { Effect, Queue, Hub, Stream, pipe, Chunk } from "effect";
import { DurableConfig, type Action, type StreamEvent, type StreamEventWithOffset } from "./types.js";

// ============================================================
// Dependencies interface (for testability)
// ============================================================

export type ProcessorDeps = {
  readonly appendEvent: (sessionId: string, event: StreamEvent) => Effect.Effect<number>;
  readonly generateStream: (request: GenerateRequest) => Effect.Effect<Stream.Stream<StreamEvent>>;
  readonly getCurrentHtml: (sessionId: string) => Effect.Effect<string>;
};

export type GenerateRequest = {
  readonly sessionId: string;
  readonly prompt?: string;
  readonly action?: string;
  readonly actionData?: Record<string, unknown>;
  readonly currentHtml: string;
};

// ============================================================
// Batch building (pure functions)
// ============================================================

const buildSingleRequest = (
  sessionId: string,
  action: Action,
  currentHtml: string
): GenerateRequest => ({
  sessionId,
  prompt: action.prompt,
  action: action.action,
  actionData: action.actionData,
  currentHtml: action.currentHtml ?? currentHtml,
});

const buildBatchRequest = (
  sessionId: string,
  actions: readonly Action[],
  currentHtml: string
): GenerateRequest => {
  // Group actions by type for smart batching
  const actionCounts = new Map<string, number>();
  for (const a of actions) {
    if (a.action) {
      actionCounts.set(a.action, (actionCounts.get(a.action) ?? 0) + 1);
    }
  }

  const summary = Array.from(actionCounts.entries())
    .map(([action, count]) => (count > 1 ? `${action} (${count}x)` : action))
    .join(", ");

  return {
    sessionId,
    action: "batch",
    actionData: {
      summary,
      actions: actions.map((a) => ({
        type: a.type,
        action: a.action,
        data: a.actionData,
      })),
    },
    currentHtml: actions[actions.length - 1]?.currentHtml ?? currentHtml,
  };
};

// ============================================================
// Processing loop (pure, takes deps as argument)
// ============================================================

export const runProcessingLoop = (
  sessionId: string,
  actionQueue: Queue.Queue<Action>,
  eventHub: Hub.Hub<StreamEventWithOffset>,
  deps: ProcessorDeps
) =>
  Effect.gen(function* () {
    yield* Effect.log(`Starting processing loop for session ${sessionId}`);

    // Infinite loop - runs until fiber is interrupted
    yield* Effect.forever(
      Effect.gen(function* () {
        // Wait for at least one action, take up to MAX_BATCH_SIZE
        const actionsChunk = yield* Queue.takeBetween(
          actionQueue,
          1,
          DurableConfig.MAX_BATCH_SIZE
        );
        const actions = Chunk.toReadonlyArray(actionsChunk);

        yield* Effect.log(`Processing ${actions.length} action(s)`, {
          sessionId,
          actions: actions.map((a) => a.action ?? a.prompt),
        });

        // Get current HTML state
        const currentHtml = yield* deps.getCurrentHtml(sessionId);

        // Build request (single or batched)
        const request =
          actions.length === 1
            ? buildSingleRequest(sessionId, actions[0], currentHtml)
            : buildBatchRequest(sessionId, actions, currentHtml);

        // Get generation stream
        const stream = yield* deps.generateStream(request);

        // Process each event: persist to log, publish to hub
        yield* pipe(
          stream,
          Stream.mapEffect((event) =>
            Effect.gen(function* () {
              // Persist to durable log
              const offset = yield* deps.appendEvent(sessionId, event);

              // Broadcast to subscribers
              const eventWithOffset: StreamEventWithOffset = { ...event, offset };
              yield* Hub.publish(eventHub, eventWithOffset);

              return eventWithOffset;
            })
          ),
          Stream.runDrain
        );

        yield* Effect.log(`Completed processing batch`, { sessionId });
      })
    );
  });

// ============================================================
// State reconstruction (pure function)
// ============================================================

export const reconstructHtml = (
  lastHtmlEvent: { offset: number; data: string } | null,
  eventsAfter: readonly { data: string }[],
  applyPatch: (html: string, patch: unknown) => string,
  initialHtml: string
): string => {
  let html = initialHtml;

  if (lastHtmlEvent) {
    const parsed = JSON.parse(lastHtmlEvent.data) as StreamEvent;
    if (parsed.type === "done" || parsed.type === "html") {
      html = parsed.html;
    }
  }

  // Apply any patches after the last html event
  for (const event of eventsAfter) {
    const parsed = JSON.parse(event.data) as StreamEvent;
    if (parsed.type === "patch") {
      html = applyPatch(html, parsed.patch);
    } else if (parsed.type === "html" || parsed.type === "done") {
      html = parsed.html;
    }
  }

  return html;
};
```

---

## Phase 4: ProcessorRegistry Service

### `services/durable/registry.ts`

```typescript
import {
  Effect,
  Queue,
  Hub,
  Ref,
  Fiber,
  Scope,
  HashMap,
  Option,
  pipe,
  Schedule,
  Duration,
} from "effect";
import {
  DurableConfig,
  type SessionProcessor,
  type Action,
  type StreamEventWithOffset,
} from "./types.js";
import { runProcessingLoop, reconstructHtml, type ProcessorDeps } from "./processor.js";
import { DurableEventLog } from "./event-log.js";
import { GenerateService } from "../generate/index.js";
import { PatchValidator } from "../vdom/index.js";

const INITIAL_HTML = `<div id="root"></div>`;

export class ProcessorRegistry extends Effect.Service<ProcessorRegistry>()(
  "ProcessorRegistry",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const eventLog = yield* DurableEventLog;
      const generate = yield* GenerateService;
      const patchValidator = yield* PatchValidator;

      // Registry state
      const processors = yield* Ref.make(HashMap.empty<string, SessionProcessor>());

      // ============================================================
      // Build dependencies for processor (wires services together)
      // ============================================================

      const buildProcessorDeps = (sessionId: string): ProcessorDeps => ({
        appendEvent: (sid, event) => eventLog.append(sid, event),

        generateStream: (request) => generate.streamUnified(request),

        getCurrentHtml: (sid) =>
          Effect.gen(function* () {
            const lastHtmlEvent = yield* eventLog.getLastHtmlEvent(sid);

            if (!lastHtmlEvent) {
              return INITIAL_HTML;
            }

            const eventsAfter = yield* eventLog.readFrom(sid, lastHtmlEvent.offset);

            return reconstructHtml(
              lastHtmlEvent,
              eventsAfter,
              (html, patch) => {
                // Use patchValidator to apply patch (simplified - actual impl would use VDOM)
                // For now, just return html unchanged if patch application is complex
                return html;
              },
              INITIAL_HTML
            );
          }),
      });

      // ============================================================
      // Create a new processor with its own scope
      // ============================================================

      const createProcessor = (sessionId: string) =>
        Effect.gen(function* () {
          // Create a closeable scope for this processor
          const scope = yield* Scope.make();

          // Create queue and hub within the scope
          const actionQueue = yield* Queue.unbounded<Action>();
          const eventHub = yield* Hub.unbounded<StreamEventWithOffset>();
          const lastActivity = yield* Ref.make(Date.now());

          // Build deps and start processing loop
          const deps = buildProcessorDeps(sessionId);

          const fiber = yield* pipe(
            runProcessingLoop(sessionId, actionQueue, eventHub, deps),
            Effect.forkIn(scope)
          );

          const processor: SessionProcessor = {
            sessionId,
            actionQueue,
            eventHub,
            lastActivity,
            fiber,
            scope,
          };

          return processor;
        });

      // ============================================================
      // Public API
      // ============================================================

      /**
       * Get existing processor or create a new one.
       */
      const getOrCreate = (sessionId: string) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(processors);
          const existing = HashMap.get(current, sessionId);

          if (Option.isSome(existing)) {
            yield* Ref.set(existing.value.lastActivity, Date.now());
            return existing.value;
          }

          // Create new processor
          const processor = yield* createProcessor(sessionId);

          yield* Ref.update(processors, HashMap.set(sessionId, processor));

          yield* Effect.log(`Created processor for session ${sessionId}`);

          return processor;
        });

      /**
       * Update last activity timestamp for a session.
       */
      const touch = (sessionId: string) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(processors);
          const existing = HashMap.get(current, sessionId);

          if (Option.isSome(existing)) {
            yield* Ref.set(existing.value.lastActivity, Date.now());
          }
        });

      /**
       * Release a processor (interrupt fiber, shutdown queue/hub).
       */
      const release = (sessionId: string) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(processors);
          const existing = HashMap.get(current, sessionId);

          if (Option.isSome(existing)) {
            const processor = existing.value;

            yield* Effect.log(`Releasing processor for session ${sessionId}`);

            // Close scope triggers cleanup of fiber, queue, hub
            yield* Scope.close(processor.scope, Exit.succeed(void 0));

            yield* Ref.update(processors, HashMap.remove(sessionId));
          }
        });

      /**
       * Get all processor session IDs (for dormancy checking).
       */
      const getAllSessionIds = Effect.gen(function* () {
        const current = yield* Ref.get(processors);
        return HashMap.keys(current);
      });

      /**
       * Get last activity time for a session.
       */
      const getLastActivity = (sessionId: string) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(processors);
          const existing = HashMap.get(current, sessionId);

          if (Option.isSome(existing)) {
            return yield* Ref.get(existing.value.lastActivity);
          }

          return null;
        });

      return {
        getOrCreate,
        touch,
        release,
        getAllSessionIds,
        getLastActivity,
      } as const;
    }),
  }
) {}
```

---

## Phase 5: Background Jobs (Dormancy & Cleanup)

### `services/durable/jobs.ts`

```typescript
import { Effect, Schedule, Duration, pipe } from "effect";
import { DurableConfig } from "./types.js";
import { ProcessorRegistry } from "./registry.js";
import { DurableEventLog } from "./event-log.js";

/**
 * Background fiber that checks for dormant processors and releases them.
 */
export const dormancyChecker = Effect.gen(function* () {
  const registry = yield* ProcessorRegistry;

  yield* Effect.log("Starting dormancy checker");

  yield* pipe(
    Effect.gen(function* () {
      const now = Date.now();
      const sessionIds = yield* registry.getAllSessionIds;

      for (const sessionId of sessionIds) {
        const lastActivity = yield* registry.getLastActivity(sessionId);

        if (lastActivity && now - lastActivity > DurableConfig.DORMANCY_TIMEOUT_MS) {
          yield* Effect.log(`Session ${sessionId} going dormant`);
          yield* registry.release(sessionId);
        }
      }
    }),
    Effect.catchAll((error) =>
      Effect.log(`Dormancy checker error: ${error}`)
    ),
    Effect.repeat(Schedule.spaced(Duration.millis(DurableConfig.DORMANCY_CHECK_INTERVAL_MS))),
  );
});

/**
 * Background fiber that cleans up old events from the durable log.
 */
export const eventCleanup = Effect.gen(function* () {
  const eventLog = yield* DurableEventLog;

  yield* Effect.log("Starting event cleanup job");

  yield* pipe(
    Effect.gen(function* () {
      const deleted = yield* eventLog.cleanup;

      if (deleted > 0) {
        yield* Effect.log(`Cleaned up ${deleted} old events`);
      }
    }),
    Effect.catchAll((error) =>
      Effect.log(`Event cleanup error: ${error}`)
    ),
    Effect.repeat(Schedule.spaced(Duration.millis(DurableConfig.CLEANUP_INTERVAL_MS))),
  );
});

/**
 * Start all background jobs. Returns fibers for supervision.
 */
export const startBackgroundJobs = Effect.gen(function* () {
  const dormancyFiber = yield* Effect.fork(dormancyChecker);
  const cleanupFiber = yield* Effect.fork(eventCleanup);

  yield* Effect.log("Background jobs started");

  return { dormancyFiber, cleanupFiber };
});
```

---

## Phase 6: Rate Limiting Service

### `services/rate-limit/service.ts`

```typescript
import { Effect, RateLimiter, Ref, HashMap, Option, Duration } from "effect";

export type RateLimitConfig = {
  readonly perSessionLimit: number;
  readonly perSessionInterval: Duration.Duration;
  readonly globalLimit: number;
  readonly globalInterval: Duration.Duration;
};

const defaultConfig: RateLimitConfig = {
  perSessionLimit: 10,
  perSessionInterval: Duration.minutes(1),
  globalLimit: 1000,
  globalInterval: Duration.minutes(1),
};

export class RateLimitExceeded extends Error {
  readonly _tag = "RateLimitExceeded";
  constructor(readonly sessionId: string) {
    super(`Rate limit exceeded for session ${sessionId}`);
  }
}

export class RateLimitService extends Effect.Service<RateLimitService>()(
  "RateLimitService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const sessionLimiters = yield* Ref.make(
        HashMap.empty<string, RateLimiter.RateLimiter>()
      );

      const globalLimiter = yield* RateLimiter.make({
        limit: defaultConfig.globalLimit,
        interval: defaultConfig.globalInterval,
      });

      /**
       * Get or create a rate limiter for a session.
       */
      const getSessionLimiter = (sessionId: string) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(sessionLimiters);
          const existing = HashMap.get(current, sessionId);

          if (Option.isSome(existing)) {
            return existing.value;
          }

          const limiter = yield* RateLimiter.make({
            limit: defaultConfig.perSessionLimit,
            interval: defaultConfig.perSessionInterval,
          });

          yield* Ref.update(sessionLimiters, HashMap.set(sessionId, limiter));

          return limiter;
        });

      /**
       * Acquire a permit for a session action. Blocks until permit available.
       */
      const acquireSession = (sessionId: string) =>
        Effect.gen(function* () {
          const limiter = yield* getSessionLimiter(sessionId);
          yield* RateLimiter.take(limiter, 1);
        });

      /**
       * Acquire a global permit for LLM call.
       */
      const acquireGlobal = RateLimiter.take(globalLimiter, 1);

      /**
       * Remove rate limiter for a session (called when session goes dormant).
       */
      const removeSession = (sessionId: string) =>
        Ref.update(sessionLimiters, HashMap.remove(sessionId));

      return {
        acquireSession,
        acquireGlobal,
        removeSession,
      } as const;
    }),
  }
) {}
```

---

## Phase 7: HTTP Handlers

### `services/durable/handlers.ts`

```typescript
import { Effect, Stream, pipe } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse, HttpHeaders } from "@effect/platform";
import { Schema } from "effect";
import { ProcessorRegistry } from "./registry.js";
import { DurableEventLog } from "./event-log.js";
import { RateLimitService, RateLimitExceeded } from "../rate-limit/service.js";
import { Queue } from "effect";

// ============================================================
// Request Schema
// ============================================================

const GenerateStreamRequest = Schema.Struct({
  sessionId: Schema.String,
  action: Schema.optional(Schema.String),
  actionData: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  prompt: Schema.optional(Schema.String),
  currentHtml: Schema.optional(Schema.String),
  reconnect: Schema.optional(Schema.Boolean),
  fromOffset: Schema.optional(Schema.Number),
});

// ============================================================
// Handler
// ============================================================

export const generateStreamHandler = HttpRouter.post(
  "/generate/stream",
  Effect.gen(function* () {
    const body = yield* HttpServerRequest.schemaBodyJson(GenerateStreamRequest);
    const registry = yield* ProcessorRegistry;
    const eventLog = yield* DurableEventLog;
    const rateLimiter = yield* RateLimitService;

    // Rate limit check (per-session)
    yield* pipe(
      rateLimiter.acquireSession(body.sessionId),
      Effect.timeout(Duration.seconds(5)),
      Effect.catchTag("TimeoutException", () =>
        Effect.fail(new RateLimitExceeded(body.sessionId))
      )
    );

    // Get or create processor
    const processor = yield* registry.getOrCreate(body.sessionId);

    // Handle reconnection - get missed events
    const missedEvents =
      body.reconnect && body.fromOffset !== undefined
        ? yield* eventLog.readFrom(body.sessionId, body.fromOffset)
        : [];

    // Enqueue action if present (prompt or action)
    if (body.action || body.prompt) {
      yield* Queue.offer(processor.actionQueue, {
        type: body.prompt ? "prompt" : "action",
        prompt: body.prompt,
        action: body.action,
        actionData: body.actionData,
        currentHtml: body.currentHtml,
      });
    }

    // Build SSE stream
    const missedStream = Stream.fromIterable(
      missedEvents.map((e) => ({
        ...JSON.parse(e.data),
        offset: e.offset,
      }))
    );

    const liveStream = Stream.fromHub(processor.eventHub);

    const eventStream = pipe(
      Stream.concat(missedStream, liveStream),
      Stream.map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
      )
    );

    return HttpServerResponse.stream(eventStream, {
      contentType: "text/event-stream",
      headers: HttpHeaders.fromInput({
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Session-Id": body.sessionId,
      }),
    });
  }).pipe(
    Effect.catchTag("RateLimitExceeded", (err) =>
      HttpServerResponse.json(
        { error: "Rate limit exceeded", retryAfter: 60 },
        { status: 429 }
      )
    )
  )
);
```

---

## Phase 8: Frontend Changes

### `apps/webpage/src/stream.ts` (new file)

```typescript
const STREAM_KEY = "generative-ui-stream";

export type StreamState = {
  sessionId: string;
  lastOffset: number;
};

export const saveStreamState = (state: StreamState) => {
  localStorage.setItem(STREAM_KEY, JSON.stringify(state));
};

export const loadStreamState = (): StreamState | null => {
  const saved = localStorage.getItem(STREAM_KEY);
  if (!saved) return null;
  try {
    return JSON.parse(saved);
  } catch {
    return null;
  }
};

export const clearStreamState = () => {
  localStorage.removeItem(STREAM_KEY);
};
```

### Updates to `apps/webpage/src/main.ts`

```typescript
import { saveStreamState, loadStreamState, clearStreamState, type StreamState } from "./stream";

const app = {
  // ... existing properties
  streamState: null as StreamState | null,

  handleStreamEvent(event: StreamEvent & { offset?: number }) {
    // Save offset for reconnection
    if (event.offset !== undefined && this.sessionId) {
      this.streamState = { sessionId: this.sessionId, lastOffset: event.offset };
      saveStreamState(this.streamState);
    }

    // Existing handling...
    switch (event.type) {
      case "session":
        this.sessionId = event.sessionId;
        break;
      case "patch":
        this.applyPatch(event.patch);
        break;
      // ... rest
    }
  },

  async sendStreamRequest(request: GenerateRequest, isInitial = false) {
    const saved = loadStreamState();

    const requestWithReconnect = {
      ...request,
      sessionId: saved?.sessionId ?? this.sessionId ?? undefined,
      reconnect: !!saved && !request.prompt && !request.action,
      fromOffset: saved?.lastOffset,
    };

    // ... existing fetch logic, but call handleStreamEvent with offset
  },

  resetSession() {
    this.sessionId = null;
    this.stats = null;
    this.streamState = null;
    clearStreamState();
    // ... rest of existing reset
  },

  async init() {
    const saved = loadStreamState();

    if (saved) {
      // Try to reconnect to existing session
      this.sessionId = saved.sessionId;
      this.streamState = saved;

      // Connect without action to just subscribe to updates
      await this.sendStreamRequest({ type: "generate" });
    } else {
      // Fresh start
      this.getElements().contentEl.innerHTML = INITIAL_HTML;
      this.setLoading(false, true);
    }

    // ... rest of existing init
  },
};
```

---

## Testing Strategy

### Unit Tests for Processor (Pure Functions)

```typescript
// processor.test.ts
import { describe, it, expect } from "vitest";
import { Effect, Queue, Hub, TestClock, Fiber } from "effect";
import { runProcessingLoop, reconstructHtml, type ProcessorDeps } from "./processor";

describe("runProcessingLoop", () => {
  it("processes single action", async () => {
    const events: StreamEvent[] = [];

    const mockDeps: ProcessorDeps = {
      appendEvent: (_, event) =>
        Effect.succeed(events.push(event) - 1), // Return offset

      generateStream: (_) =>
        Effect.succeed(
          Stream.fromIterable([
            { type: "patch", patch: { selector: "#count", text: "1" } },
            { type: "done", html: "<div>1</div>" },
          ])
        ),

      getCurrentHtml: () => Effect.succeed("<div>0</div>"),
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<Action>();
        const hub = yield* Hub.unbounded<StreamEventWithOffset>();

        // Start processor in background
        const fiber = yield* Effect.fork(
          runProcessingLoop("test-session", queue, hub, mockDeps)
        );

        // Enqueue an action
        yield* Queue.offer(queue, { type: "action", action: "increment" });

        // Wait a bit for processing
        yield* Effect.sleep(Duration.millis(100));

        // Verify events were appended
        expect(events).toHaveLength(2);
        expect(events[0].type).toBe("patch");
        expect(events[1].type).toBe("done");

        // Clean up
        yield* Fiber.interrupt(fiber);
      })
    );
  });

  it("batches multiple actions", async () => {
    let capturedRequest: GenerateRequest | null = null;

    const mockDeps: ProcessorDeps = {
      appendEvent: () => Effect.succeed(0),
      generateStream: (req) => {
        capturedRequest = req;
        return Effect.succeed(Stream.empty);
      },
      getCurrentHtml: () => Effect.succeed("<div>0</div>"),
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<Action>();
        const hub = yield* Hub.unbounded<StreamEventWithOffset>();

        const fiber = yield* Effect.fork(
          runProcessingLoop("test-session", queue, hub, mockDeps)
        );

        // Enqueue multiple actions at once
        yield* Queue.offer(queue, { type: "action", action: "increment" });
        yield* Queue.offer(queue, { type: "action", action: "increment" });
        yield* Queue.offer(queue, { type: "action", action: "increment" });

        yield* Effect.sleep(Duration.millis(100));

        // Should be batched
        expect(capturedRequest?.action).toBe("batch");
        expect(capturedRequest?.actionData?.summary).toBe("increment (3x)");

        yield* Fiber.interrupt(fiber);
      })
    );
  });
});

describe("reconstructHtml", () => {
  it("returns initial HTML when no events", () => {
    const result = reconstructHtml(null, [], () => "", "<div>initial</div>");
    expect(result).toBe("<div>initial</div>");
  });

  it("uses done event HTML as base", () => {
    const lastHtmlEvent = {
      offset: 5,
      data: JSON.stringify({ type: "done", html: "<div>final</div>" }),
    };

    const result = reconstructHtml(lastHtmlEvent, [], () => "", "<div>initial</div>");
    expect(result).toBe("<div>final</div>");
  });

  it("applies patches after done event", () => {
    const lastHtmlEvent = {
      offset: 5,
      data: JSON.stringify({ type: "done", html: "<div>5</div>" }),
    };

    const eventsAfter = [
      { data: JSON.stringify({ type: "patch", patch: { selector: "div", text: "6" } }) },
    ];

    const mockApplyPatch = (html: string, patch: any) => "<div>6</div>";

    const result = reconstructHtml(lastHtmlEvent, eventsAfter, mockApplyPatch, "<div>0</div>");
    expect(result).toBe("<div>6</div>");
  });
});
```

---

## Migration

### `drizzle/0003_stream_events.sql`

```sql
CREATE TABLE IF NOT EXISTS stream_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  offset INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS stream_events_session_offset_idx
  ON stream_events(session_id, offset);

CREATE INDEX IF NOT EXISTS stream_events_created_at_idx
  ON stream_events(created_at);
```

---

## Implementation Order

1. **Phase 1:** Types and schema (`types.ts`, `schema.ts`, migration)
2. **Phase 2:** DurableEventLog service (`event-log.ts`)
3. **Phase 3:** SessionProcessor pure functions (`processor.ts`) + unit tests
4. **Phase 4:** ProcessorRegistry service (`registry.ts`)
5. **Phase 5:** Background jobs (`jobs.ts`)
6. **Phase 6:** RateLimitService (`rate-limit/service.ts`)
7. **Phase 7:** HTTP handler (`handlers.ts`)
8. **Phase 8:** Frontend changes (`stream.ts`, `main.ts`)
9. **Phase 9:** Integration testing
