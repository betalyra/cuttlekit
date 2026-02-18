# Sandbox Integration Plan

## Goal

Give the LLM access to a secure code sandbox so it can execute TypeScript against real APIs (Linear, Slack, etc.) and use the results to generate/update UI. Replace the need for MCP tools — which are token-heavy and slow — with a direct code execution model where the LLM writes code against well-documented SDKs.

---

## Architecture Overview

### Structural Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              config.toml                                      │
│  [providers.groq]  [providers.google]  [sandbox]                              │
│                                         ├── provider, mode, volume_ttl        │
│                                         └── [[dependencies]] + docs + secrets │
└──────┬──────────────┬──────────────────────────┬─────────────────────────────┘
       │              │                          │
       ▼              ▼                          ▼
┌────────────┐               ┌──────────────────────────────────────────────┐
│ModelRegistry│               │            AppConfig.sandbox                 │
│ (unchanged) │               └──────┬──────────────┬──────────────┬───────┘
└──────┬─────┘                       │              │              │
       │                   ┌─────────▼────┐  ┌──────▼───────┐ ┌───▼────────────┐
       │                   │ SandboxManager│  │DocSearchSvc  │ │CodeModuleIndex │
       │                   │ (per-session) │  │(global/shared)│ │(per-session)   │
       │                   │              │  └──────┬───────┘ └───┬────────────┘
       │                   │ snapshot ────►│        │              │
       │                   │ volume ──────►│        │              │
       │                   └──────┬───────┘        │              │
       │                          │                │              │
       ▼                          ▼                ▼              ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          GenerateService                                      │
│                                                                               │
│  streamText({ model, messages, tools, maxSteps })                             │
│                                                                               │
│  tools:                                                                       │
│    search_docs ──► DocSearchSvc.search() + CodeModuleIndex.search()           │
│    run_code ─────► SandboxManager.getOrCreate() → handle.eval()               │
│                                                                               │
│  output: JSONL patches / full HTML  (unchanged pipeline)                      │
│          + {"type":"code_modules",...}  (finalizer, saved to index)            │
└──────────────────────────────────────────────────────────────────────────────┘

Deno Infrastructure:

┌─────────────────────────────────────────┐
│            Snapshot (immutable)           │
│  Created at app startup                  │
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

## 1. Config Extension

Generalize `config.toml` and the loader (`model-config.ts` → `app-config.ts`) to cover both model providers and sandbox configuration.

```toml
# config.toml (extended)

default_model = "moonshotai/kimi-k2-instruct-0905"

# --- Model providers (unchanged) ---
[providers.groq]
# ...

# --- Sandbox ---
[sandbox]
provider = "deno"             # future: "e2b", "modal", etc.
mode = "lazy"                 # "lazy" = create on first run_code | "warm" = create with session
region = "ord"                # Deno region for sandbox + volumes
volume_ttl_minutes = 30       # volume deleted after this many minutes of inactivity

# Provider-specific options (passed through to sandbox provider)
[sandbox.options]
# e.g. timeout, memory limits

# Dependencies installed in every sandbox instance
[[sandbox.dependencies]]
package = "@linear/sdk"
docs = ["https://linear.app/developers/sdk.md"]
secret_env = "LINEAR_API_KEY"          # convention: read from env
hosts = ["api.linear.app"]             # network allowlist for this secret

[[sandbox.dependencies]]
package = "@slack/web-api"
docs = ["https://api.slack.com/methods"]
secret_env = "SLACK_TOKEN"
hosts = ["slack.com"]
```

**Loader changes:**
- Rename `model-config.ts` → `app-config.ts` (or add a `sandbox-config.ts` alongside)
- New `SandboxConfig` type alongside existing `ModelsConfig`
- Secrets resolved from env vars using existing `UPPER_CASE` convention
- `sandbox` section is optional — if absent, no sandbox tools are available to the LLM
- The loader returns a unified `AppConfig = { models: ModelsConfig, sandbox?: SandboxConfig }`

---

## 2. Sandbox Provider Abstraction

A provider-agnostic interface so we can swap Deno for E2B, Modal, or a local Docker container later.

```
SandboxProvider (Effect.Service)
├── createSnapshot(deps) → Effect<SnapshotRef, SandboxError>
├── createSandbox(options) → Effect<SandboxHandle, SandboxError, Scope>
│   ├── options: { snapshot, volume?, secrets }
│   ├── SandboxHandle.eval(code: string) → Effect<SandboxResult, SandboxExecError>
│   └── Cleanup handled by Effect.acquireRelease via Scope
├── createVolume(sessionId) → Effect<VolumeRef, SandboxError>
├── deleteVolume(slug) → Effect<void, SandboxError>
└── Provider implementations:
    ├── DenoSandboxProvider (wraps @deno/sandbox — existing experiment code)
    └── (future) E2BSandboxProvider, etc.
```

**Key design points:**
- `SandboxHandle` is the only type the rest of the system touches — never the underlying provider
- `eval` returns structured results: `{ success: true, result: unknown, stdout: string }` or `{ success: false, error: string, stdout: string }`
- Secrets are injected at sandbox creation time as env vars with host-scoped network access
- Dependencies are pre-installed in the snapshot — no `deno install` at session time
- Resource lifecycle uses `Effect.acquireRelease` — sandbox creation is the acquire, `sandbox.close()` is the release. The enclosing `Scope` (from the `SessionProcessor`) guarantees cleanup even on crash/interrupt.

**Provider selection** is driven by `sandbox.provider` in config.toml. A simple factory picks the right implementation at startup.

---

## 3. Snapshot Strategy

Snapshots eliminate dependency installation time from session sandbox creation. A base snapshot is built once at app startup and reused by all sessions.

### Startup flow

```
App startup:
  1. Hash sandbox config: sha256(sorted deps + versions) → configHash
  2. Check if snapshot "genui-deps-{configHash}" exists (Deno API)
  3. If exists → use it, done
  4. If not:
     a. Create temporary sandbox
     b. Write package.json with all configured dependencies
     c. Run `deno install`
     d. Create volume from sandbox filesystem
     e. Snapshot the volume → "genui-deps-{configHash}"
     f. Destroy temporary sandbox + temporary volume
  5. Store snapshotSlug in AppConfig for session sandbox creation
```

### Why this works

- Snapshot creation is a one-time cost (~10-30s depending on deps)
- Subsequent app startups skip creation if config hasn't changed (hash matches)
- Session sandbox creation becomes `Sandbox.create({ root: snapshotSlug })` → boots in <1s
- When config.toml dependencies change → new hash → new snapshot on next startup
- Old snapshots can be cleaned up manually or via a retention policy

### Session sandbox creation (with snapshot)

```
SandboxManager.getOrCreate(sessionId):
  1. Sandbox.create({ root: snapshotSlug, volumes: { "/workspace": volumeSlug } })
  2. Ready — deps pre-installed, volume mounted, <1s
```

No `deno install` needed. The snapshot already contains `node_modules` and the Deno cache.

---

## 4. Volume & Code Module Persistence

### Volume Registry

Tracks which session owns which volume. Stored in Turso.

```
session_volumes
├── session_id: text (FK to sessions)
├── volume_slug: text (unique)
├── region: text
├── created_at: integer
└── last_accessed_at: integer
```

**Lifecycle:**
- Volume created on first `run_code` call (alongside sandbox creation)
- `last_accessed_at` bumped every time sandbox mounts the volume
- Background job deletes volumes where `last_accessed_at < now - volume_ttl`
- On volume deletion: also delete associated `code_modules` entries (they reference files that no longer exist)

### Code Module Index

The AI saves descriptions of reusable code it writes to the sandbox. Stored in Turso with embeddings for vector search.

```
code_modules
├── id: text (primary key)
├── session_id: text (FK)
├── volume_slug: text (FK to session_volumes)
├── path: text                    ("lib/linear.ts")
├── description: text             ("Linear API: getAllMyIssues(page) returns ...")
├── exports: text                 (JSON array: ["getAllMyIssues", "getIssueById"])
├── usage: text                   ("import { getAllMyIssues } from './lib/linear.ts'; ...")
├── embedding: F32_BLOB(N)       (vector of description for search)
└── created_at: integer
```

No source code stored — the volume is the source of truth for actual file contents.

### Search with volume-aware code module inclusion

The `search_docs` tool always searches SDK documentation. Whether it also returns saved code modules depends on whether the session's volume still exists.

```
search_docs(query, sessionId):
  1. Always: vector search on doc_chunks → SDK documentation results
  2. Look up session_volumes in Turso → volume_slug (or null)
  3. If slug exists → Volume.get(slug) via Deno API
     ├── Volume found → also search code_modules for this session
     │   Merge SDK docs + code modules, return combined top-k
     └── Volume null/404 → volume gone, skip code_modules
        ├── Delete session_volumes entry (eager cleanup)
        └── Delete associated code_modules entries
  4. If no slug in registry → SDK docs only (session never had a volume)
```

This way:
- SDK documentation is **always** available — the search never fails
- Code modules are only returned when the volume backing them exists
- No stale results, no wasted tool calls — the AI never sees modules it can't import
- Cleanup is eager: a single `Volume.get()` call cleans up the Turso registry on miss

**Edge case:** Volume deleted between search and `run_code` (seconds apart, very unlikely). `run_code` fails with a clear error, AI adapts by searching docs and rewriting.

---

## 5. Documentation System

A documentation index for SDK docs that the LLM can search via a tool. Uses vector embeddings stored in Turso for semantic search, matching the existing pattern from `MemoryService`.

### 5a. Fetch & Index (startup time)

When the app starts (or when sandbox config is loaded):

1. For each dependency, fetch all URLs listed in `docs[]`
2. Parse markdown into sections (split on `## ` headers)
3. Each section becomes a `DocChunk { id, package, heading, content, url, embedding }`
4. Generate embeddings for each chunk (reuse existing embedding model from `MemoryService`)
5. Store chunks + embeddings in Turso (`doc_chunks` table with vector column)
6. On subsequent startups, skip chunks whose source URL + content hash haven't changed

This runs once at startup, not per session. Docs are shared across all sessions.

**Storage schema (Turso):**

```
doc_chunks
├── id: text (primary key, e.g. hash of package+heading)
├── package: text
├── heading: text
├── content: text
├── url: text
├── content_hash: text          (detect changes on restart)
├── embedding: F32_BLOB(N)     (vector column for ANN search)
└── created_at: integer
```

### 5b. Search (tool call time)

Vector similarity search using the same Turso `vector_distance_cos` / `vector_top_k` pattern already used for memory search:

1. Embed the query string
2. Always: search `doc_chunks` via `vector_top_k` with optional `package` filter
3. Check session volume: look up `session_volumes` → `Volume.get(slug)` via Deno API
4. If volume alive: also search `code_modules` via `vector_top_k` with `session_id` filter
5. If volume gone: skip `code_modules`, eagerly clean up stale registry + index entries
6. Merge results, return top-k (k = 3-5)

The `Volume.get()` call is lightweight and doubles as a liveness check — it keeps the search results honest without a separate background reconciliation job. SDK documentation is always returned regardless of volume state.

This reuses the existing embedding infrastructure — same model, same DB, same query pattern.

**Future enhancements (inform design, don't build yet):**
- **BM25 keyword search** — add a second retrieval path using Turso's FTS5 full-text index. Run both vector + BM25 in parallel, merge results.
- **Reranking** — after retrieving candidates from vector + BM25, run a cross-encoder reranker to produce final top-k. The `search()` return type stays `DocChunk[]` regardless of retrieval strategy.

### 5c. Documentation Sourcing — Current & Future

**v1 (now): Configured markdown URLs**
- Simplest approach — works for SDKs that publish LLM-friendly docs (Linear, Stripe, etc.)
- Markdown fetched at startup, chunked by headers, embedded, stored

**Future sourcing strategies** (design the `DocSource` type to be extensible):

| Strategy | When to use | How it works |
|----------|-------------|--------------|
| **Markdown URL** | SDK publishes clean markdown docs | Fetch URL, chunk by headers |
| **Sitemap crawl** | Docs site has a sitemap but no single markdown file | Crawl sitemap, extract content from HTML pages (readability/turndown), chunk |
| **NPM README + types** | No docs site at all | Fetch README from npm registry, extract TypeScript type declarations from package `.d.ts` files, chunk by export |
| **GitHub repo scrape** | Docs live in a repo's `/docs` folder | Fetch tree via GitHub API, process each markdown file |
| **LLM-generated summaries** | Docs are verbose/scattered | Run a summarization pass over raw docs to produce concise API reference chunks |
| **llms.txt / llms-full.txt** | Site publishes LLM-optimized docs per the llms.txt standard | Fetch from `/.well-known/llms.txt` or `/llms-full.txt`, already chunked for LLM consumption |

For now, the `DocSearchService` just takes a list of URLs. The chunking + embedding pipeline is the same regardless of how the markdown was obtained — so swapping sourcing strategies later doesn't affect the search layer.

### 5d. Service shape

```
DocSearchService (Effect.Service)
├── Depends on: AppConfig (sandbox deps + doc URLs), EmbeddingModel, Database
├── Startup: fetches docs, chunks, embeds, upserts into Turso
├── search(query: string, options?: { package?: string, sessionId?: string, limit?: number })
│   → Effect<SearchResult[]>    (merged doc_chunks + code_modules results)
└── listPackages() → string[]   (so LLM knows what's available)
```

---

## 6. LLM Tools

Two tools added to the `streamText` call in `GenerateService`:

### Tool 1: `search_docs`

```
search_docs({ query: string, package?: string })
→ { results: [{ type: "doc"|"module", heading|path, content|usage, url? }] }
```

LLM uses this BEFORE writing code to understand the SDK API. Returns both SDK documentation and any saved code modules from the session. The system prompt instructs it to always search first.

### Tool 2: `run_code`

```
run_code({ code: string, description: string })
→ { success: boolean, result?: unknown, error?: string, stdout?: string }
```

Executes TypeScript in the session's sandbox. Returns structured output so the LLM can interpret results and update the UI accordingly.

### System prompt addition

Added to the existing `STREAMING_PATCH_PROMPT`:

```
## Code Sandbox

You have access to a secure sandbox where you can run TypeScript code against real APIs.

Available SDKs: {list from config}

### Workflow
1. Use `search_docs` to look up how to use an SDK — also returns saved modules from earlier
2. Write code using `run_code` to call the API
3. Use the results to generate/update the UI with patches
4. When you write reusable functions, save them as modules (see below)

### Saving Reusable Code
When you write a function that could be useful in future requests, save it as a file in
the sandbox and emit a code_modules summary at the END of your response:
{"type":"code_modules","modules":[{"path":"lib/linear.ts","description":"...","exports":["fn1"],"usage":"import { fn1 } from './lib/linear.ts'; ..."}]}

Write modules as focused, importable files:
- One module per SDK/domain (lib/linear.ts, lib/slack.ts)
- Export pure functions with clear parameters
- Keep functions reusable — accept parameters instead of hardcoding values

### Rules
- ALWAYS search docs before writing code — do not assume API shapes
- Code runs in Deno with npm package support
- Secrets are pre-injected as env vars (access via `Deno.env.get("SECRET_NAME")`)
- Return data as the last expression (it becomes the tool result)
- Keep code focused — one API call per run_code invocation
- If a module import fails, the module may have expired — search docs and rewrite it
```

### AI SDK integration

The AI SDK's `streamText` supports tools + multi-step natively via `maxSteps`. The flow:

1. LLM generates text (JSONL patches) or decides to call a tool
2. If tool call → AI SDK pauses text generation, we execute the tool, return result
3. LLM continues generating with tool result in context
4. Repeat until LLM finishes (or `maxSteps` reached)

The existing stream pipeline (accumulate lines → parse JSONL → validate patches) only processes text output. Tool call/result events pass through the AI SDK internally between steps. We filter the `fullStream` to only emit text-deltas as before.

---

## 7. Stream Finalizer — Code Module Storage

Similar to how the memory system saves summaries after generation, the code module index is populated from the LLM's own output at the end of the stream.

### How it works

1. LLM writes reusable code via `run_code` (files saved to sandbox FS → volume)
2. At the end of the response, LLM emits a `code_modules` JSONL line summarizing what it saved
3. The stream pipeline picks up `{"type":"code_modules",...}` alongside patches/full/stats
4. The finalizer (in `UIService`, similar to memory saving):
   - Embeds each module's `description` field
   - Upserts into `code_modules` table in Turso (keyed by session_id + path)
   - Associates with the session's volume slug

### Why the AI writes the summary

- The AI knows exactly what it wrote and why — it produces the best description
- Descriptions are optimized for future LLM consumption (the AI writes for itself)
- No extra LLM call needed for summarization (unlike memory, which requires a separate call)
- The `usage` field gives the next LLM request a ready-to-use import snippet

### Response type addition

```
UnifiedResponse =
  | { type: "patches", patches: Patch[] }
  | { type: "full", html: string }
  | { type: "stats", ... }
  | { type: "code_modules", modules: CodeModuleSummary[] }    ← NEW
```

The `code_modules` response type flows through `parseJsonLine` like patches and full HTML. It's not a patch or UI update — it's metadata that gets stored, not applied to the VDOM.

### Processing in UIService

```
handleResponse(response):
  match response.type:
    "patches"      → apply to VDOM, emit SSE patch events
    "full"         → replace VDOM, emit SSE html event
    "stats"        → emit SSE stats event
    "code_modules" → embed descriptions, upsert to Turso (async, non-blocking)
```

---

## 8. Token-Efficient Prompt Integration

Code module metadata must be available to the LLM without bloating the prompt. The key constraint: preserve prompt caching (prefix-based) by ordering content from most-stable to least-stable.

### Current message structure

```
[SYSTEM] Static prompt (STREAMING_PATCH_PROMPT)     ← always cached
[USER]
  HTML:\n{currentHtml}                               ← changes per action
  [RECENT CHANGES] ...                               ← changes sometimes
  [RELEVANT PAST CONTEXT] ...                        ← changes sometimes
  [NOW] 1. Action: increment Data: {}                ← changes every request
```

### New message structure (with sandbox)

```
[SYSTEM] Static prompt + sandbox rules               ← always cached (longest prefix)

[USER]
  [SANDBOX MODULES]                                   ← changes rarely
  - lib/linear.ts: getAllMyIssues(page), getIssueById(id)
    usage: import { getAllMyIssues } from './lib/linear.ts'
  - lib/slack.ts: sendMessage(channel, text)
    usage: import { sendMessage } from './lib/slack.ts'

  HTML:\n{currentHtml}                                ← changes per action

  [RECENT CHANGES]                                    ← changes sometimes
  1. "show my issues" → fetched 12 Linear issues, rendered as table

  [RELEVANT PAST CONTEXT]                             ← changes sometimes
  - "add slack integration" → added sendMessage module

  [NOW]                                               ← changes every request
  1. Action: refresh Data: {}
```

### Why this order

Prompt caching is prefix-based — the provider caches the longest matching prefix from the previous request.

| Section | Stability | Cache behavior |
|---------|-----------|----------------|
| System prompt | Static | Always cached |
| `[SANDBOX MODULES]` | Changes only when AI saves new modules (rare) | Cached across most requests within a session |
| `HTML` | Changes on every action (patch/full) | Cache breaks here on most requests |
| `[RECENT CHANGES]` | Changes after each generation | Not cached |
| `[NOW]` | Changes every request | Never cached |

By placing `[SANDBOX MODULES]` **before** HTML, the cached prefix extends through the module list on requests where modules haven't changed (which is most requests — modules are only saved occasionally). This is strictly better than the current layout where the cache breaks immediately at the HTML boundary.

### Module section is compact

The module section only contains:
- File path (short)
- Function names (short)
- One-line usage snippet (short)

NOT the full source code. A session with 5 saved modules adds ~10 lines (~200 tokens) to the prompt. This is the minimum needed for the AI to know what's available and how to import it.

If the AI needs more detail about a module, it calls `search_docs` — the full description is in the `code_modules` table and returned via vector search. This keeps the prompt lean while preserving discoverability.

---

## 9. Sandbox Lifecycle

Two modes for sandbox creation, configurable via `sandbox.mode` in `config.toml`. Both use snapshots for instant boot and volumes for persistence.

### Mode: `lazy` (default)

Sandbox is created on first `run_code` call. Zero cost if LLM never uses sandbox tools.

```
Session created → sandboxRef = Ref(None)
        │
LLM calls run_code
        │
  sandboxRef == None?
  ├── yes → Look up volume in session_volumes registry
  │         Volume exists? → mount it
  │         Volume gone?   → create new volume, register in Turso
  │         Sandbox.create({ root: snapshotSlug, volumes: { "/workspace": slug } })
  │         Effect.acquireRelease within processor Scope
  │         Ref.set(sandboxRef, Some(handle))
  └── no  → reuse existing handle
        │
        ▼
  Sandbox active ←──── subsequent run_code calls reuse it
        │
  Processor released (dormancy)
        │
  Scope.close() → acquireRelease finalizer → sandbox.close()
  Volume survives. Volume TTL timer continues.
```

### Mode: `warm`

Sandbox is created immediately when the `SessionProcessor` is created. Eliminates boot lag on first `run_code`.

```
Session processor created (getOrCreate)
        │
  sandbox.mode == "warm"?
  ├── yes → same creation flow as lazy, but immediately
  └── no  → Ref.set(sandboxRef, None)   (lazy mode)
```

### Resource management with Effect

```
SessionProcessor.scope
├── actionQueue (existing)
├── eventPubSub (existing)
├── fiber (existing)
└── sandboxHandle (NEW, via acquireRelease)
    ├── acquire: Sandbox.create({ root: snapshot, volumes: ... })
    └── release: sandbox.close()   (volume NOT deleted — it outlives sandbox)
```

When the dormancy checker calls `processor.release()` → `Scope.close()`, the sandbox is closed but the volume persists. The volume cleanup job handles volume TTL independently.

### Volume TTL cleanup

Background job (runs every N minutes):
1. Query `session_volumes WHERE last_accessed_at < now - volume_ttl_minutes`
2. Delete volume via Deno API
3. Delete from `session_volumes` table
4. Delete associated `code_modules` entries (stale — files no longer exist)

### Scale to zero

- **Lazy mode:** If the LLM never calls `run_code`, no sandbox/volume created. Zero cost.
- **Warm mode:** Sandbox exists for processor lifetime. Volume persists for TTL after.
- **Volume TTL:** After configured inactivity, volume deleted. ~$0.20/month per volume while active.
- **Snapshot:** Shared across all sessions, one-time creation cost. Persists until config changes.

### Where it lives

```
SessionProcessor (extended)
├── actionQueue: Queue<Action>
├── eventPubSub: PubSub<StreamEventWithOffset>
├── sandboxRef: Ref<Option<SandboxHandle>>    ← NEW
├── volumeSlug: Ref<Option<string>>           ← NEW (persists across sandbox recreations)
├── lastActivity: Ref<number>
├── fiber: RuntimeFiber
└── scope: CloseableScope
```

---

## 10. Module Structure

```
apps/backend/src/
├── services/
│   ├── app-config.ts              ← renamed from model-config.ts, adds SandboxConfig
│   ├── model-registry.ts          ← unchanged (reads from AppConfig.models)
│   ├── sandbox/
│   │   ├── index.ts               ← re-exports
│   │   ├── types.ts               ← SandboxHandle, SandboxConfig, SandboxError, VolumeRef
│   │   ├── manager.ts             ← SandboxManager (snapshot, lazy/warm, volume registry)
│   │   ├── code-index.ts          ← CodeModuleIndex (embed, upsert, search code_modules)
│   │   ├── schema.ts              ← Drizzle schema: session_volumes, code_modules tables
│   │   └── providers/
│   │       ├── deno.ts            ← DenoSandboxProvider (from experiment)
│   │       └── (future) e2b.ts
│   ├── doc-search/
│   │   ├── index.ts               ← re-exports
│   │   ├── service.ts             ← DocSearchService (embed, store, vector search)
│   │   ├── chunker.ts             ← markdown → sections splitter
│   │   └── schema.ts              ← Drizzle schema for doc_chunks table
│   ├── generate/
│   │   ├── service.ts             ← adds tools to streamText
│   │   ├── tools.ts               ← NEW: tool definitions (search_docs, run_code)
│   │   └── prompts.ts             ← extended with sandbox instructions
```

---

## 11. Implementation Order

1. **Config** — extend config.toml schema + loader to include sandbox section (with mode, region, volume_ttl)
2. **Snapshot** — build base snapshot at startup from configured dependencies. Hash-based cache invalidation.
3. **Doc search** — DocSearchService (fetch URLs, chunk, embed, store in Turso, vector search). Can be tested standalone.
4. **Sandbox provider** — Port Deno experiment into provider abstraction with `Effect.acquireRelease`, snapshots, volumes.
5. **Volume registry** — `session_volumes` table + background cleanup job.
6. **Code module index** — `code_modules` table, embed + upsert, vector search merged with doc search.
7. **Tools** — Define `search_docs` and `run_code` tools. Wire into GenerateService.
8. **Finalizer** — Parse `code_modules` JSONL from stream, store via CodeModuleIndex.
9. **Prompt structure** — Add `[SANDBOX MODULES]` section before HTML in user message.
10. **System prompt** — Add sandbox instructions + module saving instructions. Test end-to-end.
11. **APPROACH.md** — Document as Step 26.

---

## 12. Future Considerations (inform design, don't build yet)

**Auth layer (better-auth):**
- Currently: secrets from env vars, shared across all users
- Future: per-user OAuth tokens fetched at sandbox creation time
- Design for this: secrets resolution is a function `(secretName: string) => Effect<Redacted<string>>`, not a static map. For now that function reads env vars; later it calls the auth service.

**Other runtimes:**
- Provider abstraction means adding Python/Go/etc. is just a new provider implementation
- `eval` interface stays the same (code in, result out)
- Dependencies and doc URLs are already per-entry in config

**Snapshot versioning:**
- Currently: one snapshot per config hash
- Future: keep N recent snapshots for rollback
- Snapshot naming: `genui-deps-{configHash}-{timestamp}`

**Hybrid retrieval (BM25 + vector + reranking):**
- Currently: vector similarity only
- Next: add FTS5 full-text index on `doc_chunks` + `code_modules` for BM25 keyword search
- Then: run vector + BM25 in parallel, merge candidates, apply cross-encoder reranker for final top-k
- `search()` return type stays the same — retrieval strategy is an internal concern

**Tool result streaming:**
- Currently: tool results are returned as a single blob
- Future: stream long-running sandbox output (e.g., progress updates)
- Design for this: `eval` could return a Stream instead of a single Effect (later)

**Cross-session module sharing:**
- Currently: code_modules scoped to session
- Future: "published" modules visible across sessions (user-level library)
- Design for this: add `scope: "session" | "user"` to code_modules, search with appropriate filter
