# Sandbox Integration

## Goal

Give the LLM access to a secure code sandbox so it can execute TypeScript against real APIs (Linear, Slack, etc.) and use the results to generate/update UI. Replace the need for MCP tools — which are token-heavy and slow — with a direct code execution model where the LLM writes code against well-documented SDKs.

---

## Architecture Overview

### Structural Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              config.toml                                      │
│  [providers.groq]  [providers.google]  [sandbox]                              │
│                                         ├── enabled, provider, mode           │
│                                         └── [[dependencies]] + docs + secrets │
└──────┬──────────────┬──────────────────────────┬─────────────────────────────┘
       │              │                          │
       ▼              ▼                          ▼
┌────────────┐               ┌──────────────────────────────────────────────┐
│ModelRegistry│               │        AppConfig.sandbox: Option<Config>     │
│ (unchanged) │               └──────┬──────────────┬──────────────────────┘
└──────┬─────┘                       │              │
       │                   ┌─────────▼────┐  ┌──────▼───────┐
       │                   │ SandboxManager│  │DocSearchSvc  │
       │                   │ (per-session) │  │(global/shared)│
       │                   │ snapshot ────►│  └──────┬───────┘
       │                   │ volume ──────►│         │
       │                   └──────┬───────┘         │
       │                          │                 │
       ▼                          ▼                 ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          GenerateService                                      │
│  streamText({ model, messages, tools, stopWhen })                            │
│                                                                               │
│  tools (conditional — only when sandbox.enabled):                            │
│    search_docs ──► DocSearchSvc.search()                                     │
│    run_code ─────► SandboxManager.getOrCreate() → handle.eval()              │
│                                                                               │
│  output: JSONL patches / full HTML  (unchanged pipeline)                      │
│          + {"type":"code_modules",...}  (finalizer, saved to index)            │
└──────────────────────────────────────────────────────────────────────────────┘

Deno Infrastructure:

┌─────────────────────────────────────────┐
│            Snapshot (immutable)           │
│  Created at app startup (always)         │
│  Contains: all configured deps installed │
│  Slug: "genui-deps-{configHash}"         │
│  Shared across ALL session sandboxes     │
└──────────────────┬──────────────────────┘
                   │ root: snapshotSlug
                   ▼
┌─────────────────────────────────────────┐
│         Session Sandbox (ephemeral)      │
│  Boots from snapshot (<1s, no install)   │
│  Lives for session processor lifetime    │
├─────────────────────────────────────────┤
│         Volume (durable, per-session)    │
│  Mounted at /workspace                   │
│  Contains: AI-written modules, data      │
│  TTL: configurable (e.g. 30 min idle)    │
│  Survives sandbox teardown               │
└─────────────────────────────────────────┘

Turso DB:

┌──────────────┐  ┌──────────────┐  ┌──────────────────┐
│  doc_chunks   │  │ code_modules  │  │ session_volumes   │
│  (global)     │  │ (per-session) │  │ (registry)        │
│  SDK docs     │  │ AI-saved code │  │ session → volume  │
│  + embeddings │  │ + embeddings  │  │ + last_accessed   │
└──────────────┘  └──────────────┘  └──────────────────┘
```

### Sequence Diagram — Full Lifecycle

```
 App Startup                              Deno
   │                                        │
   │  sandbox.enabled == true?              │
   │  Hash sandbox config (deps+versions)   │
   │  Snapshot "genui-deps-{hash}" exists?  │
   │──── check ────────────────────────────►│
   │◄──── no ───────────────────────────────│
   │                                        │
   │  Create temp sandbox                   │
   │──── Sandbox.create() ────────────────►│
   │  Write package.json + deno install     │
   │──── sh`deno install` ────────────────►│
   │  Create volume from sandbox FS         │
   │──── volume.create() ─────────────────►│
   │  Snapshot the volume                   │
   │──── volume.snapshot() ───────────────►│
   │◄──── snapshot slug ───────────────────│
   │  Destroy temp sandbox + volume         │
   │──── close() ─────────────────────────►│
   │                                        │
   │  Snapshot ready (reused for all sessions)
   ▼


 Client        Processor     SandboxManager     Deno            Turso
   │               │               │               │               │
   │ POST /stream  │               │               │               │
   │──────────────►│               │               │               │
   │               │ dequeue       │               │               │
   │               │──► UIService ──► GenerateService               │
   │               │               │               │               │
   │               │  LLM calls search_docs("linear issues")       │
   │               │               │               │               │
   │               │               │  1. vector search: doc_chunks │
   │               │               │──────────────────────────────►│
   │               │               │◄── SDK doc results ──────────│
   │               │               │               │               │
   │               │               │  2. Volume.get(slug)          │
   │               │               │──────────────►│               │
   │               │               │◄── exists? ───│               │
   │               │               │               │               │
   │               │               │  3. if volume alive: search code_modules
   │               │               │──────────────────────────────►│
   │               │               │◄── saved module results ─────│
   │               │               │               │               │
   │               │  top-k merged results (SDK docs + code modules if volume alive)
   │               │               │               │               │
   │               │  LLM calls run_code(...)      │               │
   │               │               │               │               │
   │               │  sandboxRef == None            │               │
   │               │──────────────►│               │               │
   │               │               │  Lookup volume │               │
   │               │               │──────────────────────────────►│
   │               │               │◄─ volume_slug (or null) ─────│
   │               │               │               │               │
   │               │               │  Sandbox.create(root: snapshot, volumes: {/workspace: slug})
   │               │               │──────────────►│               │
   │               │               │◄── handle ────│               │
   │               │               │               │               │
   │               │               │  handle.eval(code)            │
   │               │               │──────────────►│               │
   │               │               │◄── result ────│               │
   │               │               │               │               │
   │               │  LLM emits patches (JSONL)    │               │
   │  SSE: patch   │◄─────────────│               │               │
   │◄──────────────│               │               │               │
   │               │               │               │               │
   │               │  LLM emits code_modules       │               │
   │               │  (stream finalizer)           │               │
   │               │               │               │  embed + upsert
   │               │──────────────────────────────────────────────►│
   │               │               │               │               │
   │  SSE: done    │               │               │               │
   │◄──────────────│               │               │               │
   │               │               │               │               │
   ─ ─ ─ ─ ─ ─ ─ 5 min inactivity (processor dormancy) ─ ─ ─ ─ ─
   │               │               │               │               │
   │          dormancy checker     │               │               │
   │               │──────────────►│  Scope.close()│               │
   │               │               │──── close ───►│               │
   │               │               │  sandbox gone  │               │
   │               │               │  volume alive   │               │
   │               │               │               │               │
   ─ ─ ─ ─ ─ ─ ─ 30 min volume TTL ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
   │               │               │               │               │
   │          volume cleanup job   │               │               │
   │               │               │  delete volume │               │
   │               │               │──────────────►│               │
   │               │               │               │  delete code_  │
   │               │               │               │  modules + vol │
   │               │──────────────────────────────────────────────►│
```

---

## 1. Config

`config.toml` sandbox section. The entire section is optional — if absent, sandbox features are disabled.

```toml
[sandbox]
enabled = true               # explicit toggle — false disables all sandbox features
provider = "deno"            # future: "e2b", "modal", etc.
mode = "lazy"                # "lazy" = sandbox on first run_code | "warm" = sandbox with session
region = "ord"               # Deno region for sandbox + volumes
volume_ttl_minutes = 30      # volume deleted after this many minutes of inactivity
volume_capacity_mb = 300     # volume capacity
timeout_seconds = 300        # code execution timeout
memory_mb = 1280             # sandbox memory limit

[[sandbox.dependencies]]
package = "@linear/sdk"
docs = ["https://linear.app/developers/sdk.md"]
secret_env = "LINEAR_API_KEY"
hosts = ["api.linear.app"]
```

**Config types** (`app-config.ts`):
- `AppConfig.sandbox: Option<SandboxConfig>` — `None` when `[sandbox]` section absent
- `SandboxConfig.enabled: boolean` — explicit toggle, defaults to `true`
- `SandboxDependencyConfig` — per-package: `package`, `docs`, `secretEnv`, `secretValue` (resolved from env), `hosts`
- Secrets resolved from env vars at config load time via `Config.redacted()`

**Disabled paths:**
- No `[sandbox]` section → `Option.none()` → no sandbox service, no tools, no doc indexing
- `enabled = false` → section parsed but treated as disabled — same effect

---

## 2. Sandbox Provider Abstraction

Provider-agnostic interface (`sandbox/types.ts`). Currently only Deno is implemented.

```
SandboxProvider
├── createSnapshot(deps) → Effect<SnapshotRef, SandboxError>
├── snapshotExists(slug) → Effect<boolean, SandboxError>
├── createSandbox(options) → Effect<SandboxHandle, SandboxError, Scope>
│   ├── options: { snapshot, volume?, secrets, region }
│   ├── SandboxHandle.eval(code) → Effect<SandboxResult, SandboxExecError>
│   └── Cleanup via Effect.acquireRelease (Scope)
├── createVolume(slug, region) → Effect<void, SandboxError>
├── volumeExists(slug) → Effect<boolean, SandboxError>
├── deleteVolume(slug) → Effect<void, SandboxError>
└── Implementations:
    ├── DenoSandboxProvider (sandbox/providers/deno.ts)
    └── (future) E2BSandboxProvider, etc.
```

**Key points:**
- `SandboxHandle` is the only type the rest of the system touches
- `eval` returns structured `SandboxResult`: `{ success, result?, error?, stdout }`
- Secrets injected at sandbox creation as env vars with host-scoped network access
- Resource lifecycle via `Effect.acquireRelease` — `Scope.close()` cleans up sandbox

---

## 3. Snapshot Strategy

Snapshots eliminate dependency installation time. Built **once at startup** regardless of mode.

**Startup flow** (`SandboxService`):
1. Hash sandbox config: `sha256(sorted dep names)` → `configHash`
2. Check if snapshot `genui-deps-{configHash}` exists (Deno API)
3. If exists → reuse, done
4. If not → create temp sandbox, install deps, snapshot filesystem, destroy temp
5. Store `snapshotRef` in manager for session sandbox creation

The snapshot is **always** built at startup when sandbox is enabled. The `mode` setting only controls when _session sandboxes_ are created (lazy vs warm), not when the snapshot is built.

**Why:** Snapshot creation is a one-time cost (~10-30s). Subsequent startups skip it if config hash matches. Session sandbox boots from snapshot in <1s.

---

## 4. Volume & Code Module Persistence

### Volume Registry (Turso)

```
session_volumes
├── session_id: text (FK)
├── volume_slug: text (unique)
├── region: text
├── created_at: integer
└── last_accessed_at: integer
```

- Created on first `run_code` call (lazy)
- `last_accessed_at` bumped on each sandbox mount
- Background job deletes expired volumes (TTL-based)

### Code Module Index (Turso)

```
code_modules
├── id: text (primary key)
├── session_id: text (FK)
├── volume_slug: text (FK)
├── path: text
├── description: text
├── exports: text (JSON array)
├── usage: text
├── embedding: F32_BLOB(N)
└── created_at: integer
```

No source code stored — the volume is the source of truth.

### Volume-aware search

`search_docs` always searches SDK documentation. Code modules are only returned when the session's volume still exists:

1. Always: vector search `doc_chunks` → SDK docs
2. Look up `session_volumes` → `volume_slug`
3. If volume alive → also search `code_modules`, merge results
4. If volume gone → skip, eagerly clean up stale registry entries

---

## 5. Documentation System

### Indexing (startup)

`DocSearchService` fetches and indexes SDK docs at startup:
1. For each dependency with `docs[]` URLs, fetch markdown
2. Chunk by `## ` headers via `ChunkingService`
3. Embed each chunk, store in Turso `doc_chunks` table
4. Skip unchanged chunks (content hash check)

### Search (tool call time)

Vector similarity search using Turso `vector_distance_cos`:
1. Embed query
2. Search `doc_chunks` with optional package filter
3. If session volume alive, also search `code_modules`
4. Merge, return top-k

### Service shape (`DocSearchService`)

```
DocSearchService
├── search(query, options?) → Effect<SearchResult[]>
├── listPackages() → string[]     (empty when sandbox disabled)
├── upsertCodeModule(module) → Effect<void>
└── Depends on: AppConfig, EmbeddingModel, StoreService, ChunkingService
```

---

## 6. LLM Tools

Two tools, defined in `generate/tools.ts` via `ToolService`. Only injected into `streamText` when sandbox is enabled and packages are configured.

### `search_docs`

```
search_docs({ query: string, package?: string })
→ SearchResult[]
```

Searches SDK docs + saved code modules. LLM calls this **before** writing code.

### `run_code`

```
run_code({ code: string, description: string })
→ { success: boolean, result?: unknown, error?: string, stdout?: string }
```

Executes TypeScript in the session's sandbox. Creates volume + sandbox on first call (lazy mode).

### Tool lifecycle

- `ToolService` captures `DocSearchService`, `StoreService`, `SandboxService` at construction
- `makeTools(ctx)` creates per-request tools with a session-scoped `sandboxRef: Ref<Option<ManagedSandbox>>`
- Tool `execute` callbacks run Effect programs via `Runtime.runPromise`
- `stopWhen: stepCountIs(10)` limits tool call loops

### Conditional injection

In `GenerateService.streamUnified`:
```
packages = toolService.listPackages()
tools = packages.length > 0
  ? toolService.makeTools({ sessionId, sandboxRef, runtime })
  : undefined
```

When `undefined`, `streamText` runs without tools — zero overhead for non-sandbox sessions.

---

## 7. Prompt Integration

The sandbox prompt is **compact** — just a short addendum to the system prompt listing available packages and tool usage rules. No module listings, no API docs in the prompt. The LLM uses `search_docs` for detailed API information.

### System prompt (`prompts.ts`)

```
buildSystemPrompt(packages?) =
  STREAMING_PATCH_PROMPT + (packages ? buildSandboxPrompt(packages) : "")
```

`buildSandboxPrompt` adds ~5 lines:
- Lists available packages
- Instructs: call `search_docs` before writing code
- Instructs: call `run_code` to execute code
- Instructs: emit `code_modules` JSONL for reusable modules

When sandbox is disabled, the system prompt contains zero sandbox information.

### Message structure

```
[SYSTEM] Static prompt (+ sandbox addendum if enabled)  ← always cached
[USER]
  HTML:\n{currentHtml}                                    ← changes per action
  [RECENT CHANGES] ...                                    ← changes sometimes
  [RELEVANT PAST CONTEXT] ...                             ← changes sometimes
  [NOW] 1. Action: increment Data: {}                     ← changes every request
```

Design principle: keep the prompt lean. Speed matters — minimize prompt size and tool roundtrips.

---

## 8. Stream Finalizer — Code Module Storage

When the LLM saves reusable code to the sandbox, it emits a `code_modules` JSONL line at the end of its response:

```json
{"type":"code_modules","modules":[{"path":"lib/linear.ts","description":"...","exports":["fn1"],"usage":"import { fn1 } from './lib/linear.ts'"}]}
```

### Response types (`generate/types.ts`)

```
LLMResponseSchema = patches | full | code_modules
UnifiedResponse = patches | full | stats | code_modules
```

### Processing in UIService

`UIService.handleResponse` matches on response type:
- `patches` → apply to VDOM, emit SSE patch events
- `full` → replace VDOM, emit SSE html event
- `stats` → emit SSE stats event
- `code_modules` → look up session volume, upsert modules via `DocSearchService.upsertCodeModule` (async, non-blocking — failures don't break the stream)

---

## 9. Sandbox Lifecycle

### Mode: `lazy` (default)

Sandbox created on first `run_code` call. Zero cost if LLM never uses sandbox tools. Snapshot is still built at startup.

```
App startup → ensureSnapshot (always)
Session created → sandboxRef = Ref(None)
LLM calls run_code → getOrCreateSandbox → Sandbox.create(root: snapshot)
Processor dormancy → Scope.close() → sandbox.close()
Volume survives → TTL cleanup later
```

### Mode: `warm`

Same as lazy but sandbox created immediately per session.

### Resource management

```
SandboxManager owns:
├── snapshotRef: Ref<Option<SnapshotRef>>  (resolved once)
├── getOrCreateSandbox(sessionId, sandboxRef, volumeSlug)
│   └── Creates Scope per sandbox, stores in sandboxRef
├── releaseSandbox(sandboxRef)
│   └── Scope.close() → acquireRelease finalizer
└── Volume CRUD (createVolume, volumeExists, deleteVolume)
```

### Volume TTL cleanup

Background job (runs every N minutes):
1. Query `session_volumes WHERE last_accessed_at < now - volume_ttl_minutes`
2. Delete volume via Deno API
3. Delete `session_volumes` + associated `code_modules` entries

---

## 10. Module Structure

```
apps/backend/src/
├── services/
│   ├── app-config.ts              ← AppConfig with Option<SandboxConfig>
│   ├── model-registry.ts          ← reads from AppConfig.models
│   ├── sandbox/
│   │   ├── index.ts               ← re-exports
│   │   ├── types.ts               ← SandboxHandle, SandboxProvider, SandboxError
│   │   ├── manager.ts             ← SandboxManager (snapshot, sandbox, volume lifecycle)
│   │   ├── service.ts             ← SandboxService (Effect.Service, wraps manager)
│   │   ├── schema.ts              ← Drizzle schema: session_volumes, code_modules
│   │   └── providers/
│   │       └── deno.ts            ← DenoSandboxProvider
│   ├── doc-search/
│   │   ├── index.ts               ← re-exports
│   │   ├── service.ts             ← DocSearchService (index, search, upsertCodeModule)
│   │   ├── chunking.ts            ← markdown → sections splitter
│   │   └── schema.ts              ← Drizzle schema for doc_chunks
│   ├── generate/
│   │   ├── service.ts             ← GenerateService (streamUnified, retry, tools)
│   │   ├── tools.ts               ← ToolService (search_docs, run_code)
│   │   ├── prompts.ts             ← STREAMING_PATCH_PROMPT + buildSandboxPrompt
│   │   └── types.ts               ← LLMResponseSchema, CodeModuleSummarySchema
│   └── ui.ts                      ← UIService (handles code_modules finalizer)
```

### Layer composition (`index.ts`)

```
SandboxService.Default → ToolService.Default → GenerateService.Default → UIService.Default
DocSearchService.Default ─┘                                              ─┘
StoreService.Default ─────┘                                              ─┘
```

---

## 11. Future Considerations

**Auth layer:** Per-user OAuth tokens instead of shared env var secrets. Design: secrets resolution as `(name) => Effect<Redacted>`.

**Other runtimes:** Provider abstraction supports adding Python/Go. `eval` interface stays the same.

**Hybrid retrieval:** BM25 keyword search + vector + cross-encoder reranking. `search()` return type unchanged.

**Tool result streaming:** `eval` could return a Stream for long-running sandbox output.

**Cross-session module sharing:** `scope: "session" | "user"` on code_modules for user-level libraries.
