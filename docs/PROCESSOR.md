# Session Processor Architecture

## Problem

Currently, each user action (button click, prompt submission) triggers a separate HTTP request to the backend, which then calls the LLM. This has several issues:

1. **Race Conditions**: Rapid user actions can cause out-of-order processing
2. **Wasted Tokens**: Each request starts fresh context, missing batching opportunities
3. **No Resumability**: Page refresh loses connection and state
4. **Inefficient**: Many small requests vs. batched processing

## Goal

Create a **durable, resumable connection** between frontend and backend with a **message queue per session**. A processor continuously handles messages, batching rapid actions together for efficient LLM calls.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Frontend                                    │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐            │
│  │ Button Click │     │ Prompt Submit│     │ Input Change │            │
│  └──────┬───────┘     └──────┬───────┘     └──────┬───────┘            │
│         │                    │                    │                     │
│         └────────────────────┼────────────────────┘                     │
│                              ▼                                          │
│                    ┌─────────────────┐                                  │
│                    │ Durable Stream  │◄──── Resumable after refresh     │
│                    │ Connection      │                                  │
│                    └────────┬────────┘                                  │
└─────────────────────────────┼───────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                              Backend                                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                     Session (per sessionId)                      │   │
│  │  ┌─────────────┐    ┌───────────────┐    ┌─────────────────┐   │   │
│  │  │ Message     │───▶│ Processor     │───▶│ Patch Stream    │   │   │
│  │  │ Queue       │    │ (Effect Fiber)│    │ to Frontend     │   │   │
│  │  │ (Effect Q)  │    │               │    │                 │   │   │
│  │  └─────────────┘    └───────┬───────┘    └─────────────────┘   │   │
│  │                             │                                   │   │
│  │                     ┌───────▼───────┐                          │   │
│  │                     │ Session VDOM  │                          │   │
│  │                     │ (happy-dom)   │                          │   │
│  │                     └───────────────┘                          │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Message Types

```typescript
type SessionMessage =
  | { type: "prompt"; content: string }
  | { type: "action"; action: string; data?: Record<string, unknown> }
  | { type: "disconnect" }
  | { type: "reconnect"; lastSeenPatchId?: string };
```

## Processor Loop

The processor is an Effect fiber that runs per session:

```typescript
type ProcessorState = {
  readonly sessionId: string;
  readonly vdom: Document;
  readonly lastActivity: DateTime;
  readonly patchSequence: number;
};

const runProcessor = (sessionId: string) =>
  Effect.gen(function* () {
    const queue = yield* Queue.bounded<SessionMessage>(100);
    const initialState = yield* initializeSession(sessionId);

    // Main processing loop using Effect.iterate
    yield* Effect.iterate(initialState, {
      while: (state) => !isInactive(state, INACTIVITY_TIMEOUT),
      body: (state) =>
        Effect.gen(function* () {
          // 1. Drain queue - collect all pending messages
          const messages = yield* drainQueue(queue);

          if (messages.length === 0) {
            // No messages - wait a bit then check again
            yield* Effect.sleep(Duration.millis(100));
            return state;
          }

          // 2. Batch messages by type
          const batched = batchMessages(messages);

          // 3. Generate patches with batched context
          const patchResult = yield* generatePatches(state, batched);

          // 4. Validate and apply patches (fail-fast with retry)
          const applied = yield* applyWithRetry(state.vdom, patchResult.patches);

          // 5. Stream patches to connected clients
          yield* streamPatchesToClient(sessionId, applied);

          // 6. Return new state
          return {
            ...state,
            lastActivity: yield* DateTime.now,
            patchSequence: state.patchSequence + applied.length,
          };
        }),
    });
  });
```

## Message Batching

When users click rapidly or submit multiple actions, the processor batches them:

```typescript
// Pure function: batch messages by type
const batchMessages = (messages: readonly SessionMessage[]): BatchedMessages => ({
  prompts: messages.filter((m) => m.type === "prompt"),
  actions: messages.filter((m) => m.type === "action"),
});

// LLM prompt includes all batched context
const buildBatchedPrompt = (batched: BatchedMessages): string => {
  const parts: string[] = [];

  if (batched.prompts.length > 0) {
    parts.push(`User prompts: ${batched.prompts.map((p) => p.content).join("; ")}`);
  }

  if (batched.actions.length > 0) {
    parts.push(
      `User actions: ${batched.actions.map((a) => `${a.action}(${JSON.stringify(a.data)})`).join(", ")}`
    );
  }

  return parts.join("\n");
};
```

## Durable Stream Connection

The frontend maintains a durable connection that can be resumed:

```typescript
// Frontend: connect with resume capability
const connectToSession = (sessionId: string, lastSeenPatchId?: string) => {
  const eventSource = new EventSource(
    `/api/session/${sessionId}/stream?lastSeen=${lastSeenPatchId ?? ""}`
  );

  eventSource.onmessage = (event) => {
    const patch = JSON.parse(event.data);
    applyPatchToDOM(patch);
    localStorage.setItem(`lastPatch:${sessionId}`, patch.id);
  };

  // On page refresh, resume from last seen
  return eventSource;
};
```

```typescript
// Backend: resume stream from lastSeen
const streamPatches = (sessionId: string, lastSeenPatchId?: string) =>
  Effect.gen(function* () {
    const session = yield* getSession(sessionId);

    // If resuming, send missed patches first
    if (lastSeenPatchId) {
      const missed = yield* getPatchesSince(sessionId, lastSeenPatchId);
      yield* Stream.fromIterable(missed);
    }

    // Then stream new patches as they're generated
    yield* session.patchStream;
  });
```

## Inactivity Timeout

Processors shut down after inactivity to free resources:

```typescript
const INACTIVITY_TIMEOUT = Duration.minutes(5);

const isInactive = (state: ProcessorState, timeout: Duration): boolean =>
  DateTime.greaterThan(
    DateTime.now,
    DateTime.add(state.lastActivity, timeout)
  );
```

When a new message arrives for an inactive session, a new processor is spawned.

## Integration with Fail-Fast Validation

The processor uses the fail-fast validation from [fail-fast-patch-validation.md](./fail-fast-patch-validation.md):

```typescript
const applyWithRetry = (vdom: Document, patches: readonly Patch[]) =>
  Effect.gen(function* () {
    const validationDoc = yield* createValidationDocument(vdom.body.innerHTML);

    // Use functional retry loop from validation module
    const result = yield* validateAndApplyWithRetry({
      patches,
      validationDoc,
      maxAttempts: 3,
      onRetry: (state) => generateCorrectivePatches(state),
    });

    // Apply validated patches to real vdom
    yield* applyToVdom(vdom, result.validatedPatches);

    return result.validatedPatches;
  });
```

## Session Lifecycle

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Created    │────▶│   Active     │────▶│   Inactive   │
│              │     │ (processor   │     │ (processor   │
│              │     │  running)    │     │  stopped)    │
└──────────────┘     └──────────────┘     └──────┬───────┘
                            ▲                    │
                            │    new message     │
                            └────────────────────┘
```

## Implementation Steps

1. **Queue Service**: Create Effect Queue per session
2. **Processor Fiber**: Implement the processing loop
3. **Message Batching**: Pure function to batch messages
4. **Durable Stream**: SSE endpoint with resume capability
5. **Patch Persistence**: Store patches for resume
6. **Inactivity Cleanup**: Timeout and cleanup logic

## Benefits

- **Batched Processing**: Rapid actions combined into single LLM call
- **Ordered Processing**: Queue ensures FIFO ordering
- **Resumable**: Page refresh doesn't lose state
- **Efficient**: Long-lived connection vs. many HTTP requests
- **Scalable**: Processor fibers are lightweight

## Trade-offs

- **Complexity**: More moving parts than simple request/response
- **Memory**: Keeping vdom and queue in memory per session
- **Persistence**: Need to persist patches for resume capability
