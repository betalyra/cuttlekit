# Patch Optimization — Component Registry

## Problem

Patches are the dominant cost in both tokens and latency. A single ticket patch uses ~434 tokens. For 7 tickets that's ~3,000 output tokens just for UI — roughly 50% of total generation. Output tokens are the most expensive and slowest to produce.

### Why patches are bloated

1. **Redundant Tailwind classes** — Every ticket repeats the same long class strings (`group flex items-center justify-between p-4 border-4 border-[#0a0a0a] bg-white shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]...`). Identical across sibling elements.

2. **Redundant structure** — Every ticket has the same HTML skeleton. Only the data (title, id, status, color) changes.

3. **Full innerHTML replacement** — Even when updating one ticket, the LLM emits the entire inner HTML including all unchanged elements.

4. **Inline styles repeat** — `style="font-family: \"Space Grotesk\""` appears 3-4 times per ticket.

The root cause is that the LLM has no way to say "this thing looks like that other thing but with different data." Every element is a standalone blob of HTML, emitted from scratch every time.

---

## Approach: Component Registry with Light DOM Custom Elements

The LLM defines reusable components as declarative specs — a tag name, an HTML template with `{prop}` placeholders, and a props list. Components are registered as Custom Elements in both happy-dom (server) and the browser (client). The existing patch pipeline (`append`, `attr`, `remove`, `prepend`, `text`, `html`) stays unchanged — the only new operation is `define`.

A component is not code. It's a declarative JSON spec. The LLM never writes class definitions or JavaScript logic.

**Validated in experiment:** 31 scenarios covering board CRUD, page transitions, restyle, edge cases — server (happy-dom) and browser DOM produce identical output for every step. See `apps/experiments/src/component.ts`.

### Operations

One new op (`define`) layered on top of the existing patch set:

**`define`** — register or redefine a component (emitted once per component type, re-emitted to restyle):
```jsonl
{"op":"define","tag":"project-card","props":["name","status"],"template":"<div class='border-4 border-black p-4 mb-4'><div class='flex justify-between'><h3 class='font-bold'>{name}</h3><span>{status}</span></div><div data-children></div></div>"}
```

All other operations use the existing `Patch` type — no new op types needed:

```jsonl
{"selector":"#root","append":"<project-card id='p1' name='Alpha' status='Active'><task-item id='t1' title='Design' done='false'></task-item></project-card>"}
{"selector":"#t1","attr":{"done":"true"}}
{"selector":"#t1","remove":true}
{"selector":"#root","html":"<h1>Full reset</h1>"}
```

The `html` patch exists as a fallback for when things are completely broken and a full reset is needed. The default should always be granular patches.

### Token math

- `define` (once per component type): ~120 tokens
- Custom tag instance: ~30 tokens (just tag + attributes)
- 7 tickets: 120 + (7 × 30) = **~330 tokens** vs. ~3,000 today → **~10x reduction**
- `attr` update (single prop): ~15 tokens vs. ~434 for full re-emit
- `define` restyle (all instances): ~120 tokens regardless of instance count — **O(1) in LLM output**

### Light DOM with `[data-children]`

Components render into light DOM — no shadow roots, no `<slot>`, no Declarative Shadow DOM serialization. Child projection uses a `[data-children]` marker element in the template.

**Why light DOM:**
- happy-dom's shadow DOM support has gaps (cannot parse DSD, `connectedCallback` fires before children are parsed)
- Light DOM means the rendered HTML is directly inspectable and styleable
- No serialization/deserialization boundary between server and client
- Simpler mental model — everything is in one DOM tree

**How `[data-children]` works:**
1. Template includes `<div data-children></div>` where children should appear
2. On render: save existing children → set innerHTML from template → find `[data-children]` → re-append saved children
3. Children survive re-renders (restyle, attr change) because they're explicitly preserved

```
Template: <div class="card"><h3>{name}</h3><div data-children></div></div>

LLM writes: <project-card name="Alpha">
              <task-item title="Design"></task-item>
            </project-card>

Renders to: <project-card name="Alpha">
              <div class="card">
                <h3>Alpha</h3>
                <div data-children>
                  <task-item title="Design">...</task-item>
                </div>
              </div>
            </project-card>
```

### CE thin shell

Each component is registered once per tag via `customElements.define()`. The class is a thin shell that delegates rendering to the current spec from the registry:

```typescript
class extends HTMLElement {
  static observedAttributes = [...props]
  connectedCallback() {}  // empty — happy-dom fires before children are parsed
  attributeChangedCallback() { if (this.isConnected) this.render() }
  render() {
    const spec = registry.get(tagName)
    if (!spec) return
    const existing = this.querySelector("[data-children]")
    const children = [...(existing ?? this).children]
    this.innerHTML = interpolate(spec.template, spec.props, this)
    const container = this.querySelector("[data-children]")
    if (container) children.forEach(c => container.appendChild(c))
  }
}
```

**Key constraints:**
- `connectedCallback` is empty because happy-dom fires it before children are parsed. Rendering is triggered explicitly via `renderTree` after structural mutations.
- `attributeChangedCallback` handles prop updates (e.g. `attr` patch on a CE) — triggers re-render only when connected.
- `customElements.define()` throws if the tag is already registered. The shell is registered once; on redefine, only the registry entry updates. Existing instances re-render by reading the new spec.

### Template interpolation

Simple `{prop}` string replacement — no template engine needed:

```typescript
const interpolate = (template, props, el) =>
  props.reduce((acc, prop) => acc.replaceAll(`{${prop}}`, el.getAttribute(prop) ?? ""), template)
```

Works identically in happy-dom and browser. Zero dependencies.

### Render pipeline

**After structural mutations** (`append`, `prepend`, `html`): top-down `renderTree` traversal renders all CEs in document order.

```typescript
const renderTree = (doc, registry) =>
  [...doc.querySelectorAll("*")]
    .filter(el => registry.has(el.tagName.toLowerCase()))
    .forEach(el => el.render())
```

Top-down order is critical — parent CEs must render first (establishing `[data-children]`) before children can be placed.

**After attribute mutations** (`attr`): the CE lifecycle handles it — `attributeChangedCallback` fires and calls `render()` on the affected element only. No tree traversal needed.

**After `define` (restyle)**: `querySelectorAll(tag)` → call `render()` on each instance. All instances pick up the new template.

### Server-side flow

The server validates all LLM output in happy-dom before forwarding to the client.

**On `define`:**
1. Validate statically — tag name has a hyphen, template sanitized (no script/iframe/onclick), all `{placeholders}` match declared props
2. Store in session-scoped registry (version increments on redefine)
3. Register CE thin shell in happy-dom (skip if already registered)
4. Re-render all existing instances of that tag
5. Forward the define op to the client via durable stream

**On patch:**
1. Apply the patch to happy-dom VDOM (same `applyPatch` as today)
2. If structural mutation: `renderTree` to upgrade any new CEs
3. Validate the result
4. Forward the patch to the client

### Client-side flow

The client registers identical CE classes and applies the same patches.

- `define` op → update local registry, register CE if new, re-render existing instances
- Structural patches (`append`, `html`) → apply to DOM, `renderTree` for new CEs
- `attr` patch on a CE → `setAttribute()` triggers `attributeChangedCallback` → local re-render, no server roundtrip
- `remove` → `el.remove()`, children go with it

Both server and client run the same rendering logic. The experiment verified that happy-dom and browser DOM produce identical innerHTML at every step.

### Component registry

Session-scoped `Map<string, ComponentSpec>`:

```typescript
type ComponentSpec = {
  tag: string
  props: string[]
  template: string
  version: number
}
```

- **Persistence** — specs are JSON-serializable. Stored as part of session state. On session restore, replay `define` ops to re-register CEs in happy-dom and forward to the client. Matches the existing durable stream replay pattern.
- **System components** — shared registry with pre-baked components (loading-spinner, error-banner) inherited by all sessions. Session specs override system specs.
- **Versioning** — version bumps on redefine. The thin shell always reads the current spec at render time.
- **Sync** — durable streams replay define ops on reconnect, bootstrapping the full registry for new browser tabs.

### Prompt caching alignment

The prompt structure layers by volatility:

```
Layer 1: System instructions, rendering rules        → always cached
Layer 2: Component registry (defined specs so far)   → rarely changes, cached
Layer 3: Current page state as flat element refs      → compact (~30 tok/element vs hundreds)
Layer 4: User message                                 → never cached
```

Layer 3 is a flat map with element IDs and prop values — not raw HTML. A counter incrementing from 41→42 changes one value in one element's props. Everything above stays prefix-identical → cache hit.

The registry is projected into the prompt as a compact catalog:
```
Available components:
<project-card name:string status:string>
<task-item title:string done:string>
<metric-card label:string value:string trend:string>
```

### Validation

Two phases:

**Static** — pure JSON/string checks before touching the DOM:
- Tag name rules (hyphen, lowercase, not reserved)
- Template sanitization via element allowlist (reject script, iframe, onclick, javascript: URLs)
- Placeholder validation (all `{x}` match declared props)
- Style validation (reject @import, url() with external refs)

**Live render** — instantiate with synthetic data in happy-dom:
- Element renders non-empty content
- No raw `{...}` text in output (failed interpolation)
- Reasonable DOM depth and node count
- All errors are LLM-actionable: `"Template references {titel} but prop not declared. Available: title, status, assignee."`

### Interactivity

`data-action` attributes work the same as today, just inside component templates:
```
"template": "<div><span>{title}</span><button data-action='delete' data-action-data='{\"id\":\"{id\"}'}'>Delete</button></div>"
```

The rendered output contains the same `data-action` elements the client already handles — no changes to the event delegation system.

---

## Validated Scenarios

All scenarios below were tested in the experiment with server/browser sync verified.

### Board CRUD

| Step | Op | Tokens | Description |
|------|-----|--------|-------------|
| Define `<project-card>` | `define` | ~120 | Container with `[data-children]` |
| Define `<task-item>` | `define` | ~80 | Leaf element |
| Render board | `append` | ~200 | Two projects with nested tasks |
| Add task | `append` | ~25 | Append to `#p1 [data-children]` |
| Mark done | `attr` | ~15 | `{done: "☑"}` on single element |
| Update container | `attr` | ~15 | Change project status, children survive |
| Late component | `define` | ~80 | `<status-badge>` introduced mid-session |
| Append badge | `append` | ~25 | New component type in existing container |
| Remove task | `remove` | ~10 | Single element |
| Remove project | `remove` | ~10 | Container + all children |
| Empty container | `append` | ~30 | Create project with no children |
| Populate | `append` | ~25 | Add children to previously empty container |

### Restyle (bulk update via redefine)

| Step | Op | Tokens | Description |
|------|-----|--------|-------------|
| Restyle `<task-item>` | `define` | ~120 | All task instances re-render with new template |
| Restyle `<project-card>` | `define` | ~120 | All project instances re-render, children preserved |

**O(1) in LLM output** — one `define` regardless of instance count. This is the biggest win beyond token savings.

### Page transition (board → dashboard)

No `html` nuke needed. Remove elements individually, then build the new page:

| Step | Op | Tokens |
|------|-----|--------|
| Remove header | `remove` | ~10 |
| Remove each project | `remove` × N | ~10 each |
| Define `<metric-card>` | `define` | ~100 |
| Define `<dash-section>` | `define` | ~100 |
| Render dashboard | `append` | ~200 |

### Edge cases (verified)

- **No-props component** — `<section-divider>` with empty props array, template is just `<hr>`
- **Mixed HTML + component** — plain `<div>` alongside `<metric-card>` in same `append`
- **Restyle after page transition** — redefine `<metric-card>` after navigating away from board
- **`html` patch as fallback** — full `innerHTML` replacement when recovery is needed
- **`prepend`** — insert content at the beginning of a container

### More scenarios (not yet tested)

**Table** — define `table-row` CE. Wrapper (`<table>`, `<thead>`) via `append`. Rows as custom tags inside `<tbody>`. Sort/filter = remove rows + re-render sorted batch.

**Form** — mostly one-off HTML via `append`. Repeating field groups (multi-address, dynamic filters) benefit from a CE.

**Tabs / accordion** — define `tab-panel` CE with `active` prop. Switching tabs = `attr` update on two elements.

---

## Composition

Nesting works via the `[data-children]` marker:

1. Parent template includes `<div data-children></div>`
2. The LLM writes child CEs as children of the parent CE tag
3. On render, children are preserved and placed into the `[data-children]` container
4. Composes to arbitrary depth

**Rule: no CE tags inside templates.** A CE template must not reference other CE tags. Composition happens in the LLM's HTML output, not in template definitions. This prevents circular references and keeps templates independently validatable.

CEs can contain both plain HTML children and other CEs — the `[data-children]` container accepts whatever is provided.

---

## Op summary

| Operation | Type | New? |
|-----------|------|------|
| Register / restyle component | `define` | New |
| Initial render | `append` | Existing patch |
| Add item | `append` | Existing patch |
| Insert at top | `prepend` | Existing patch |
| Change property | `attr` | Existing patch |
| Change text | `text` | Existing patch |
| Remove element | `remove` | Existing patch |
| Full reset (fallback) | `html` | Existing patch |

The existing patch pipeline stays unchanged. CEs are layered on top.

---

## Integration: Persistence & Prompt Caching

### Architecture: backend is source of truth

The backend owns all session state. The client never sends HTML to the server — it always restores from the backend.

| Layer | In-memory | DB | Recovery |
|-------|-----------|-----|----------|
| **VDOM** | `Map<sessionId, Window>` in VdomService | `sessions.snapshot_html` | Restore from DB snapshot on server restart |
| **Registry** | `Map<sessionId, Registry>` in ComponentRegistryService | `sessions.snapshot_registry` | Restore from DB snapshot on server restart |
| **Events** | PubSub (live subscribers) | `streamEvents` table (offset-ordered) | Replay from DB on client reconnect |
| **Memory** | — | `sessionMemoryEntries` (summaries + embeddings) | Already persisted |

### In-memory state

Registry is integrated into VdomService (not a separate service):

```
VdomService:
  windowsRef: Map<sessionId, Window>
  registriesRef: Map<sessionId, Map<tag, ComponentSpec>>
```

When a `define` op arrives:
1. Update in-memory registry (version bump if tag exists)
2. Register CE thin shell in happy-dom Window (skip if already registered)
3. Re-render existing instances (`querySelectorAll(tag).forEach(el => el.render())`)
4. Emit `define` event through the durable stream

### Persistence: DB snapshots

After each generation completes (in the `done` event), snapshot the current state to the `sessions` table:
- `snapshot_html` — current `body.innerHTML` from happy-dom
- `snapshot_registry` — JSON array of `ComponentSpec[]`

This is cheap (one UPDATE per generation) and provides instant recovery on server restart without scanning event history.

`define` ops also flow through the existing stream event pipeline as event type `"define"` — this is how the client receives them in real-time and on reconnect replay.

### Recovery scenarios

**Client reconnect (server still running):**
1. Client connects with `?offset=N`
2. Server replays missed events from DB (including `define` ops)
3. Client processes events in order: `define` → register CE, `patch` → apply
4. Result: identical state

**Page refresh (new tab, F5):**
1. Client has `sessionId` in localStorage but no DOM
2. Connects SSE with `offset=-1` (requests full bootstrap)
3. Server sends current registry as `define` events + current HTML as `html` event
4. Client registers CEs, sets innerHTML, renders tree
5. Then receives live events going forward

**Server restart:**
1. Client's EventSource auto-reconnects
2. Server lazily restores session: load `snapshot_html` and `snapshot_registry` from DB
3. Restore registry → register CEs in fresh happy-dom Window
4. Restore VDOM HTML → set `body.innerHTML`
5. Run `renderTree` to upgrade CE tags
6. Ready for next generation

**Cold start (both restart):**
1. Client loads, has no session state
2. Server creates fresh session
3. Clean slate

### Prompt structure with registry

Current prompt (no registry):
```
System: instructions                              → cached (prefix)
User:   HTML:\n{raw HTML}                         → changes every interaction
        [RECENT CHANGES]\n...
        [NOW]\n...actions
```

With registry — component catalog goes early, page state goes late:
```
System: instructions + define op format            → cached (prefix)
User:   [COMPONENTS]                               → rarely changes → cache extends here
        <project-card name:string status:string>
        <task-item title:string done:string>

        [PAGE STATE]                               → changes, but much smaller now
        <div id="root">
          <project-card id="p1" name="Alpha" status="Active">
            <task-item id="t1" title="Design" done="☑"/>
          </project-card>
        </div>

        [RECENT CHANGES]\n...
        [NOW]\n...actions
```

**Why this ordering matters for caching:**
- Anthropic's prompt caching works on prefix matching
- `[COMPONENTS]` is placed right after system instructions
- Registry only changes on `define`/restyle (rare — maybe once per session)
- Everything before `[PAGE STATE]` stays prefix-identical between interactions → cache hit
- The cache boundary naturally extends through the entire component catalog

**How compact is the page state now?**

Before (raw HTML):
```html
<div id="p1" class="group flex items-center justify-between p-4 border-4
  border-[#0a0a0a] bg-white shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]
  hover:shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] transition-shadow"
  style="font-family: 'Space Grotesk'">
  <div class="flex flex-col gap-1">
    <span class="font-bold text-sm">CK-10</span>
    <span class="text-sm">Wash grapes</span>
  </div>
  <span class="text-xs font-bold px-2 py-1 rounded"
    style="background: #bec2c8; color: #fff">Backlog</span>
</div>
```
~150 tokens per item.

After (CE tags):
```html
<project-card id="p1" name="Alpha" status="Active">
  <task-item id="t1" title="Wash grapes" done="false"/>
</project-card>
```
~25 tokens per item. **~6x reduction in page state size.**

The template HTML (Tailwind classes, inline styles) lives in the registry, which is cached and never re-sent. Only the data (IDs + prop values) appears in the volatile page state section.

### Page state serialization

Serialize `document.body.innerHTML` as today. With CEs it's naturally compact — the LLM sees the same tree structure it writes:
```html
<project-card id="p1" name="Alpha" status="Active">
  <task-item id="t1" title="Design" done="☑"></task-item>
</project-card>
```

The LLM needs the actual DOM tree to target selectors accurately. The ~6x token reduction from CE tags is sufficient for now. Further compression (e.g. flat element maps) can be explored later.

### Registry projection in prompt

The component catalog shown to the LLM should be compact — just the interface, not the full template:

```
[COMPONENTS]
<project-card name:string status:string> — container with [data-children]
<task-item title:string done:string> — leaf
<metric-card label:string value:string trend:string> — leaf
```

The LLM doesn't need to see template HTML to use components. It knows the tag name, props, and whether it's a container. This keeps the cached section small and stable.

When the LLM wants to restyle, it emits a new `define` with the full template. But it doesn't need the old template in the prompt to do this — it can see the rendered output in `[PAGE STATE]` and decide what to change.

### Event ordering and replay

Stream events are offset-ordered. The natural generation order guarantees correctness:

```
offset 1: define  project-card  {tag, props, template}
offset 2: define  task-item     {tag, props, template}
offset 3: patch   {selector:"#root", append:"<project-card...>"}
offset 4: patch   {selector:"#t1", attr:{done:"☑"}}
...
offset N: define  task-item     {tag, props, template}  ← restyle
```

On replay, `define` ops re-register CEs before patches apply them. A restyle `define` at offset N overwrites the earlier definition — later replayed patches see the restyled template. This is correct because the HTML in later patch events was generated against the restyled registry.

### Memory integration

The existing memory system stores summaries per generation. No changes needed — `define` ops are just another thing that happened during a generation. The change summary might say "Defined project-card and task-item components, rendered a board with 2 projects."

One potential enhancement: store the component catalog as part of memory context, so when the user returns to a session after a long break, the LLM knows what components were previously defined without scanning events. But this is optimization, not essential.

---

## What changed (implemented)

| Component | Change |
|-----------|--------|
| **`packages/common/src/stream.ts`** | Added `DefineEventSchema` + `DefineStreamEvent`, removed `currentHtml` from `ActionSchema` |
| **`services/generate/types.ts`** | Added `DefineOpSchema`, all discriminants use `op` (not `type`), `Option<string>` for `currentHtml`/`catalog` |
| **`services/vdom/vdom.ts`** | Registry integrated into VdomService (not a separate service). New methods: `define`, `getRegistry`, `getCatalog`, `restoreRegistry`, `renderTree`. CE shell classes, `renderTree` after structural patches |
| **`services/generate/service.ts`** | `LLMResponseSchema` union handles `define` ops. `[COMPONENTS]` + `[PAGE STATE]` in user message with explicit empty state messages |
| **`services/generate/prompts.ts`** | Added `COMPONENTS` section to system prompt with `define` op format |
| **`services/ui.ts`** | `resolveSession` restores from DB snapshot (no client HTML fallback). `handleDefineResponse` routes define ops. Snapshot persisted in `doneEvent` |
| **`services/memory/schema.ts`** | `snapshot` JSON column on `sessions` table |
| **`services/memory/store.ts`** | `SessionSnapshotSchema` (Effect Schema) with `saveSnapshot`/`getSnapshot` returning `Option<SessionSnapshot>` |
| **`api.ts`** | SSE bootstrap: `offset=-1` sends registry as `define` events + current HTML. Removed `currentHtml` from action submission |
| **`apps/webpage/src/main.ts`** | Client-side CE registry, `interpolate`, `renderElement`, `renderTree`. Handles `define` events, renders CEs after structural patches. Removed `currentHtml` from `submitAction` |

### Key implementation decisions

- **No separate ComponentRegistry service** — registry lives inside VdomService since it's tightly coupled to the happy-dom Window lifecycle
- **No ComponentValidator** — static validation deferred; Zod schema validates structure, happy-dom validates rendering
- **Effect Schema for DB snapshots** — validates on read with `Schema.decodeUnknown`, falls back to `Option.none()` on parse failure
- **`op` discriminant everywhere** — all LLM response types use `op` instead of `type` for consistency

### Dependencies

None. Simple `{prop}` interpolation. Direct patch application.

### Open questions

1. **Conditional rendering** — templates may need a way to toggle classes or show/hide content based on prop values (e.g. strikethrough when `done="true"`). Could be solved with CSS attribute selectors (`[done="true"] span { text-decoration: line-through }`) rather than template logic.
2. **Static validation** — tag name rules, template sanitization (no script/iframe/onclick), placeholder validation. Not yet implemented — deferred to first real-world usage to avoid premature constraints.
