# Session ID Fix: Options

## The Problem

The client generates a UUID via `crypto.randomUUID()` and uses it as the session ID in `/stream/:sessionId`. The backend's `SessionService` creates sessions with cuid2 IDs via `getOrCreateSession()`. These two IDs never match:

1. Client sends `POST /stream/2ee9b9b3-...` (UUID)
2. `getOrCreateSession("2ee9b9b3-...")` → not found → creates session with `id = "clxyz..."` (cuid2)
3. `resolveSession` uses UUID for VDOM and memory: `sessionId = request.sessionId ?? session.id`
4. Memory entry inserted with `session_id = "2ee9b9b3-..."` → FK violation (sessions table has `"clxyz..."`)
5. Every request creates a NEW session because the UUID is never found

Additionally, `prompts` and `actions` columns use Drizzle's `mode: "json"` (auto-serializes), but the code manually calls `JSON.stringify` → double-encoding. **This is fixed separately.**

---

## Option A: Accept Client ID as Session ID (Simplest)

**Idea:** When `getOrCreateSession` receives an ID that doesn't exist, create the session WITH that ID instead of generating a new cuid2.

**Changes:**
- `StoreService.insertSession`: Accept optional `id` field
- `SessionService.getOrCreateSession`: Pass provided ID when creating
- `UIService.resolveSession`: Use `session.id` (now equals the client UUID)

**Pros:**
- Minimal change (~10 lines across 3 files)
- No client changes, no API changes, no new endpoints
- Backwards compatible with existing saved sessions in localStorage

**Cons:**
- Server doesn't control ID format (UUIDs from client, cuid2 from server-only flows)
- Client can theoretically send any string as session ID

---

## Option B: `POST /sessions` Endpoint (REST-style)

**Idea:** Add a dedicated endpoint for session creation. Client calls it first, gets back a cuid2, uses it everywhere.

**Changes:**
- Backend: New `POST /sessions` → returns `{ sessionId: "clxyz..." }`
- Backend: Wire `SessionService` into API layer
- Frontend `init()`: `await fetch("POST /sessions")` instead of `crypto.randomUUID()`
- Frontend `resetSession()`: Same
- Frontend: `init()` and `resetSession()` become async
- `UIService.resolveSession`: Use `session.id`

**Pros:**
- Server fully owns session lifecycle and ID generation
- Clean REST semantics — explicit resource creation
- Session exists in DB before any actions are submitted

**Cons:**
- Extra round trip before first action/SSE connection
- Client must handle async session creation before connecting SSE
- Breaks existing saved sessions in localStorage (old UUIDs won't exist in DB)
- More moving parts (new endpoint, new layer wiring, async frontend init)

---

## Option C: Server Assigns ID on First POST Response

**Idea:** Client sends first POST with a temporary/arbitrary ID. Server creates a real session and returns the cuid2 in the response. Client switches to the server-assigned ID.

**Changes:**
- Backend: `POST /stream/:sessionId` response changes to `{ queued: true, sessionId: "clxyz..." }`
- Backend: ProcessorRegistry maps client ID → internal cuid2
- Frontend: After first POST, check if `sessionId` differs, reconnect SSE if so
- `UIService.resolveSession`: Use `session.id`

**Pros:**
- No new endpoint
- Server owns ID generation

**Cons:**
- Client must handle mid-flow ID switch (reconnect SSE with new ID, update localStorage)
- Race condition window: events emitted between first POST and SSE reconnect could be lost
- More complex client logic than Option B
- The temporary ID still exists in event log / ProcessorRegistry

---

## Option D: SSE Connection Handshake (Phoenix LiveView Pattern)

**Idea:** Client connects SSE first without a session ID (e.g. `GET /stream/new`). Server creates a session, sends back the cuid2 via a `session` event. Client uses it for POSTs and SSE reconnection.

This is how Phoenix LiveView and Socket.io work — the server assigns the session on the initial connection.

**Changes:**
- Backend: `GET /stream/new` creates session, sends `session` event with cuid2, keeps SSE open
- Backend: ProcessorRegistry creates processor for the cuid2 (not a client UUID)
- Frontend: Connect to `/stream/new`, wait for `session` event, store cuid2
- Frontend: Use cuid2 for all POSTs and SSE reconnections
- `UIService.resolveSession`: Use `session.id`

**Pros:**
- Industry standard pattern for real-time session establishment
- Server fully owns IDs
- No extra endpoint (reuses SSE connection)
- Single connection for both handshake and events

**Cons:**
- Client must wait for `session` event before sending first POST
- `GET /stream/new` vs `GET /stream/:sessionId` adds routing complexity
- Reconnection after page refresh uses stored cuid2 via `GET /stream/:cuid2` (different path)
- SSE (`EventSource`) doesn't support custom headers, so auth would need query params

---

## Industry Patterns

| System | Session ID Ownership | Mechanism |
|--------|---------------------|-----------|
| Phoenix LiveView | Server | Assigns on WebSocket mount |
| Socket.io | Server | Assigns on connection, client stores for reconnect |
| Pusher / Ably | Server | Server manages channels, client subscribes by name |
| Supabase Realtime | Server | Server manages subscriptions |
| Stripe API | Server | `POST /resources` returns server-generated ID |
| Firebase | Server | Server manages sessions internally |

**Common pattern:** Server assigns the session ID. Client receives it on first connection/handshake and uses it for subsequent requests and reconnections.

---

## Recommendation

**Option A** if you want to fix the bug with minimal risk and no client changes — it works today, and the ID format doesn't affect correctness.

**Option D** if you want the "correct" long-term architecture — it matches how LiveView/Socket.io handle sessions and naturally separates "new session" from "reconnect to existing session". But it's the biggest change.

**Option B** is the middle ground — clean REST semantics, server-owned IDs, but adds an extra round trip and async client init.

Option C is the weakest because the mid-flow ID switch creates a race condition window where SSE events can be lost.
