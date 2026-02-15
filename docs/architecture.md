# Generative UI Architecture

## Overview

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

### Flow

1. **Client** opens long-lived SSE connection via `GET /stream/:sessionId`
2. **Client** submits actions/prompts via `POST /stream/:sessionId` (fire-and-forget, returns 202)
3. **Server** queues actions, processing fiber dequeues and batches them
4. **UIService** calls LLM with current VDOM HTML + batched actions
5. **LLM** generates JSONL patches (or full HTML for new UIs)
6. **Server** applies patches to VDOM, dual-writes events to DB + PubSub
7. **Client** receives patches via SSE, applies to DOM in real-time

---

## Key Files

| File | Purpose |
|------|---------|
| [stream.ts](packages/common/src/stream.ts) | Shared Action + StreamEvent types (Effect Schema) |
| [api.ts](apps/backend/src/api.ts) | HTTP endpoints: POST submit + GET SSE subscribe |
| [registry.ts](apps/backend/src/services/durable/registry.ts) | ProcessorRegistry - lazy creation, dormancy management |
| [processor.ts](apps/backend/src/services/durable/processor.ts) | Processing loop - dequeue, batch, generate, dual-write |
| [event-log.ts](apps/backend/src/services/durable/event-log.ts) | DurableEventLog - Turso DB persistence for replay |
| [jobs.ts](apps/backend/src/services/durable/jobs.ts) | Background jobs - dormancy checker, event cleanup |
| [ui.ts](apps/backend/src/services/ui.ts) | UIService - session resolution, VDOM orchestration, memory |
| [service.ts](apps/backend/src/services/generate/service.ts) | GenerateService - LLM streaming with retry loop |
| [vdom/](apps/backend/src/services/vdom/) | VdomService - happy-dom per session, patch application |
| [main.ts](apps/webpage/src/main.ts) | Client - EventSource SSE + fetch POST, event delegation |

---

## Endpoint Design

### `POST /stream/:sessionId` — Submit Action
- Pushes action into the session's `Queue<Action>`
- Returns `202 Accepted` immediately
- Creates SessionProcessor lazily via `getOrCreate`

### `GET /stream/:sessionId?offset=X&live=sse` — Subscribe to Events
- Subscribes to the session's `PubSub<StreamEventWithOffset>`
- Optional `offset` query param for catch-up replay from DB
- Returns long-lived SSE stream with `id:` field set to offset

---

## Action Batching

When the LLM is busy generating, incoming actions queue up. The processing fiber uses `Queue.takeBetween(1, 10)` to dequeue all waiting actions at once and passes them as a numbered chronological list in the LLM prompt:

```
[NOW]
1. Action: increment Data: {}
2. Action: increment Data: {}
3. Action: increment Data: {}
```

One LLM call handles all three instead of triggering three separate generations.

---

## Reconnection (Subscribe-First-Then-Replay)

When a client reconnects with `?offset=5`:

1. Subscribe to PubSub **first** (buffered)
2. Read DB: events after offset 5 → e.g., events 6, 7, 8
3. Stream DB events first (catch-up)
4. Drain PubSub, filter `offset <= 8` (dedup)
5. Continue streaming live events

No gaps, no duplicates.

---

## Patch Format

LLM generates JSONL with CSS selector-based patches (ID selectors only):

```json
{"type":"patches","patches":[{"selector":"#counter-value","text":"42"}]}
{"type":"patches","patches":[{"selector":"#todo-list","append":"<li id='todo-4'>New</li>"}]}
```

### Supported Operations

| Operation | Description |
|-----------|-------------|
| `text` | Set textContent |
| `html` | Set innerHTML |
| `attr` | Set attributes (use `null` to remove) |
| `append` | Insert HTML at end |
| `prepend` | Insert HTML at start |
| `remove` | Remove element |

### Critical Rules

1. **Always use ID selectors** - `#todo-1`, not `[data-action-data='{"id":"1"}']`
2. **HTML entities for JSON** - `data-action-data="{&quot;id&quot;:&quot;1&quot;}"`
3. **Boolean attributes** - Use `"checked"` to set, `null` to remove
4. **Unique IDs required** - All interactive elements need unique IDs

---

## Interactivity

No JavaScript/onclick in generated HTML. All interaction is declarative via `data-action`:

```html
<button id="inc-btn" data-action="increment">+</button>
<input id="filter" data-action="filter">
<select id="sort" data-action="sort"><option value="asc">Asc</option></select>
```

Client intercepts interactions, sends them as POST actions. Server tells LLM what happened, LLM generates patches.

---

## Session Lifecycle

1. **Fresh session**: Client generates `sessionId` via `crypto.randomUUID()`, opens SSE, submits first prompt
2. **Active**: Processing fiber consumes actions, generates patches, dual-writes
3. **Idle**: No actions for 5 minutes → dormancy checker releases processor (fiber interrupted, resources freed)
4. **Reconnect**: New processor created lazily, state replayed from DB

---

## Token Efficiency

| Scenario | Full HTML | Patches |
|----------|-----------|---------|
| Counter increment | ~2000 tokens | ~50 tokens |
| Add todo item | ~2000 tokens | ~100 tokens |
| Toggle checkbox | ~2000 tokens | ~30 tokens |

**Current HTML IS the state** - no conversation history sent to LLM. Action + current HTML is all context needed.

---

## Retry & Fallback

1. Stream patches from LLM, validate each against temporary DOM
2. On error: stop streaming, capture successful patches, retry with corrective prompt
3. Up to 3 retries with error context
4. Full HTML fallback if patches remain broken

---

## Memory System

- **Semantic memory** via SQLite/Turso with vector embeddings
- LLM-generated summaries of prompts, actions, and changes
- Background queue for async processing (non-blocking)
- Vector search for relevant past interactions
