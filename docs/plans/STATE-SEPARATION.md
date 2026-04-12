# State Separation from HTML

## Problem

Today, **all state is embedded in the HTML**. Counters, names, prices, statuses — everything lives as text content, attribute values, or form input values inside the DOM. The LLM sees a single `[PAGE STATE]` blob where data and presentation are interleaved.

This causes three problems:

1. **Poor caching** — When the user clicks "increment", the entire prompt changes (HTML contains the new count). The system prompt and HTML structure haven't changed, but because state is inline, the LLM provider can't cache the prefix. If state were a separate section *after* the stable HTML, the HTML portion would be a cache hit.

2. **Hallucinations / data drift** — The LLM sees `<span id="price">€42.99</span>` and must preserve that exact value when restyling. But it's just text in a sea of HTML — easy to accidentally replace with invented data. A clearly separated `[STATE]` section makes data values explicit and harder to accidentally mutate.

3. **Bloated context** — State is duplicated: once in component props (`<stat-badge label="120+ ATTENDEES">`) and again in the rendered template output. Even compact HTML doesn't fix this for non-component elements.

---

## Future Constraints

Any solution must be extensible toward two planned features:

### 1. Framework Agnosticism (React, Vue, etc.)
Today we use vanilla HTML patches with happy-dom VDOM sync. In the future, the gen-UI should be embeddable as React components inside a React app. This means:
- State must exist **independent of the DOM** — React components are functions of state, not of DOM mutations
- Components must map to React components (props → React props, template → JSX-equivalent)
- Server-side React rendering replaces or wraps happy-dom
- Patches may become unnecessary for state-bound components (React re-renders from state)

### 2. Multi-Page Support
The gen-UI should support internal navigation — links to pages that are also generated. This means:
- State must be **scopeable** — global state (cart, user) vs page-local state (form fields, filters)
- Components must be **shareable** across pages (define once, use on any page)
- Navigation is a state change, not a full page rebuild

Both features require state to be a **first-class concept independent of the DOM**.

---

## Current Architecture

```
[COMPONENTS]          ← structure templates (cached across requests)
[PAGE STATE]          ← compact HTML with ALL state inline
[RELEVANT CONTEXT]    ← memory/RAG
[RECENT CHANGES]      ← last N changes
[NOW]                 ← current actions
```

State lives in:
- Element text content: `<span id="count">42</span>`
- Attributes: `<div id="todo-1" data-action-data="{&quot;id&quot;:&quot;1&quot;}">`
- Component props: `<stat-badge label="120+ ATTENDEES" color="white">`
- Form input values: `<input id="filter" value="search term">`

Components already *partially* separate state (props) from presentation (template), but only in the compact HTML view and only for componentised elements.

---

## Hard Constraint: No Code Execution

The template language **must not** contain executable code. No `vm.runInNewContext()`, no `new Function()`, no expression evaluators. Reasons:
- **Security** — prompt injection could craft expressions that escape any sandbox
- **Design principle** — the LLM generates data and declarative structure, never code
- **Library landscape** — safe expression evaluators like `jexl` are unmaintained and use non-JS syntax

This means: **no computed expressions in templates.** Every value shown in the UI must exist as an explicit key in the state store. The LLM maintains all derived values (counts, totals, summaries) manually in state.

---

## Approach A: Render Template + State Store

### Core Idea

The LLM emits a **render template** (HTML with declarative iteration/conditionals) alongside a **state store** (structured JSON). The backend evaluates the template against the state to produce full HTML for the VDOM. The prompt shows both separately — the template is stable across state-only changes (cacheable), while state changes on every action.

This is `UI = f(state)`. The template is `f`, the state store is the data. **The LLM is the runtime** — it reads state, updates it, and the system derives the DOM.

### Template Language: Two Options

Since no code execution is allowed, the template language is limited to: **substitution**, **iteration**, and **conditional visibility**. Two syntax options are viable:

#### Vue-style Directives

```html
<div id='app' class='max-w-md mx-auto p-8'>
  <h1 class='text-2xl font-black mb-4'>{title}</h1>
  <div id='todo-list'>
    <todo-item c-for='t of todos' id='todo-{t.id}' :text='t.text' :done='t.done'/>
  </div>
  <p id='count' class='mt-2 text-sm text-zinc-500'>{summary}</p>
  <p id='empty' c-if='isEmpty' class='text-zinc-400'>No todos yet</p>
  <button id='add-btn' data-action='add' class='mt-4 px-4 py-2 bg-black text-white font-bold'>Add</button>
</div>
```

- `{key}` — substitute from state (dot access: `{user.name}`)
- `c-for='t of arrayKey'` — iterate: clone element per array item, `t` is the loop variable
- `:prop='t.field'` — bind attribute to loop variable (or state key)
- `c-if='boolKey'` — conditional: show only when state key is truthy

#### Minimal Attributes

```html
<div id='app' class='max-w-md mx-auto p-8'>
  <h1 class='text-2xl font-black mb-4'>{title}</h1>
  <div id='todo-list'>
    <todo-item each='todos' id='todo-{$.id}' text='{$.text}' done='{$.done}'/>
  </div>
  <p id='count' class='mt-2 text-sm text-zinc-500'>{summary}</p>
  <p id='empty' if='isEmpty' class='text-zinc-400'>No todos yet</p>
  <button id='add-btn' data-action='add' class='mt-4 px-4 py-2 bg-black text-white font-bold'>Add</button>
</div>
```

- `{key}` — substitute from state
- `each='arrayKey'` — iterate, `{$.field}` references current item
- `if='boolKey'` — conditional visibility

#### Comparison

| | Vue Directives | Minimal Attrs |
|---|---|---|
| **LLM familiarity** | ⭐⭐⭐⭐ Known from Vue training data | ⭐⭐⭐⭐⭐ Plain HTML, trivial |
| **Parsing** | ⭐⭐⭐⭐ HTML parser + extract `c-for`/`c-if`/`:` attrs | ⭐⭐⭐⭐⭐ HTML parser + extract `each`/`if` attrs |
| **Named loop variable** | ✅ `c-for='t of todos'` → `t.text` | ❌ Always `$` → `{$.text}` |
| **Nested iteration** | ✅ Inner loop uses different variable name | ⚠️ `$` always refers to innermost — ambiguous for nested |
| **Bound vs static attrs** | ✅ `:text='t.text'` (bound) vs `class='...'` (static) — explicit | ❌ `text='{$.text}'` — must scan all attrs for `{...}` |
| **React mapping** | ⭐⭐⭐⭐ `c-for` → `.map()`, `c-if` → `&&`, `:prop` → `{expr}` | ⭐⭐⭐ `each` → `.map()`, `if` → `&&`, string scan for bindings |
| **Vue mapping** | ⭐⭐⭐⭐⭐ Rename `c-` → `v-`, done | ⭐⭐⭐ Need structural conversion |
| **Complexity** | ~250 lines | ~150 lines |

**Vue directives are better for the long term** — named loop variables handle nesting, the bound-vs-static distinction is explicit (`:text` vs `text`), and the mapping to Vue/React is cleaner. The extra ~100 lines of implementation is worth it.

**Minimal attrs are better as a stepping stone** — simpler to build, no new syntax concepts. Could ship first and upgrade to Vue directives later if nesting becomes an issue.

### What the LLM Emits

**Initial generation — "create a todo app":**
```jsonl
{"op":"define","tag":"todo-item","props":["id","text","done"],"template":"<li class='flex gap-2 items-center p-2 border-b border-zinc-200'><input type='checkbox' id='cb-{id}' data-action='toggle' data-action-data='{&quot;id&quot;:&quot;{id}&quot;}'><span class='flex-1'>{text}</span><button id='del-{id}' data-action='delete' data-action-data='{&quot;id&quot;:&quot;{id}&quot;}' class='text-red-500'>x</button></li>"}
{"op":"state","set":{"title":"My Todos","todos":[],"summary":"0 items","isEmpty":true}}
{"op":"render","html":"<div id='app' class='max-w-md mx-auto p-8'><h1 class='text-2xl font-black mb-4'>{title}</h1><div id='todo-list'><todo-item c-for='t of todos' id='todo-{t.id}' :text='t.text' :done='t.done'/></div><p id='count' class='mt-2 text-sm text-zinc-500'>{summary}</p><p id='empty' c-if='isEmpty' class='text-zinc-400'>No todos yet</p><button id='add-btn' data-action='add' class='mt-4 px-4 py-2 bg-black text-white font-bold'>Add</button></div>"}
```

Three ops working together:
- `define` — component templates (unchanged from today)
- `state` — structured data (new)
- `render` — template with declarative iteration/conditionals (new)

**User clicks "Add":**
```jsonl
{"op":"state","set":{"todos":[{"id":"1","text":"New task","done":false}],"summary":"1 item","isEmpty":false}}
```

Only state changes. Template unchanged → system re-evaluates → diffs → sends patches to frontend.

**User toggles todo:**
```jsonl
{"op":"state","set":{"todos":[{"id":"1","text":"New task","done":true}],"summary":"1 item, 1 done","isEmpty":false}}
```

**User says "make it dark mode":**
```jsonl
{"op":"render","html":"<div id='app' class='max-w-md mx-auto p-8 bg-zinc-900 text-white'>...same structure, dark classes...</div>"}
{"op":"define","tag":"todo-item","props":["id","text","done"],"template":"<li class='... border-zinc-700'>...dark styles...</li>"}
```

Template and component defs change, state stays the same. Data preserved by construction.

### Prompt Structure

```
[COMPONENTS]                         ← cached (stable across state-only actions)
<todo-item id:string text:string done:string> — leaf
  template: <li class='flex gap-2 items-center p-2 border-b border-zinc-200'>...</li>

[RENDER]                             ← cached (stable across state-only actions)
<div id='app' class='max-w-md mx-auto p-8'>
  <h1 class='text-2xl font-black mb-4'>{title}</h1>
  <div id='todo-list'>
    <todo-item c-for='t of todos' id='todo-{t.id}' :text='t.text' :done='t.done'/>
  </div>
  <p id='count' class='mt-2 text-sm text-zinc-500'>{summary}</p>
  <p id='empty' c-if='isEmpty' class='text-zinc-400'>No todos yet</p>
  <button id='add-btn' data-action='add'>Add</button>
</div>

[STATE]                              ← volatile (changes on every action)
title: "My Todos"
todos: [{"id":"1","text":"Buy milk","done":false}, {"id":"2","text":"Walk dog","done":true}]
summary: "1 of 2 remaining"
isEmpty: false

[NOW]
1. toggle [checkbox#cb-1 → todo-item#todo-1] {"id":"1"}
```

**Cache ordering**: `[COMPONENTS]` + `[RENDER]` form the prefix. For state-only actions (the most common case: toggle, add, delete, filter), the prefix is unchanged → cache hit. Only `[STATE]` + `[NOW]` are fresh.

### Derived Values

The LLM maintains all derived values manually in state. The template only substitutes — no computation.

```jsonl
{"op":"state","set":{
  "todos": [{"id":"1","text":"Buy milk","done":true}, {"id":"2","text":"Walk dog","done":false}],
  "summary": "1 of 2 remaining",
  "isEmpty": false,
  "progress": 50
}}
```

Template:
```html
<p>{summary}</p>
<div class='bg-zinc-200 h-2'><div class='bg-green-500 h-2' style='width:{progress}%'></div></div>
```

If the LLM forgets to update `summary` when toggling a todo, the UI shows stale data. This is a trade-off we accept — the LLM is the runtime. The corrective prompt for the next action will show the stale `[STATE]`, giving the LLM a chance to fix it.

---

## How It Works: Concrete Pipeline

### 1. Template Evaluation (render template + state → full HTML)

The backend stores three things per session:
- **Component registry**: `Map<string, ComponentSpec>` (existing)
- **Render template**: `string` (the template HTML with directives)
- **State store**: `Record<string, unknown>` (structured JSON)

**Evaluation algorithm:**

```
Input: template string + state object
Output: plain HTML string (no directives, no {key} placeholders)

1. Parse template as HTML DOM (happy-dom)
2. Process c-if / if:
   - Find all elements with c-if attribute
   - Read the attribute value (a state key name, e.g. "isEmpty")
   - Look up state[key] — if falsy, remove the element from DOM
3. Process c-for / each:
   - Find all elements with c-for attribute
   - Parse "t of todos" → variable name "t", array key "todos"
   - Look up state["todos"] → array of objects
   - For each item in array:
     - Clone the element
     - Remove the c-for attribute from clone
     - Substitute :attr='t.field' → attr='value' (resolve t.field from item)
     - Substitute {t.field} in text content and static attributes
     - Generate unique id: 'todo-{t.id}' → 'todo-1'
   - Replace original element with the N clones
4. Process remaining {key} substitutions:
   - Walk all text nodes and attribute values
   - Replace {key} with state[key] (supports dot access: {user.name})
5. Render component instances (existing pipeline):
   - Find custom elements, interpolate templates with props
6. Serialize DOM to HTML string
```

**Result:** A plain HTML string, identical to what today's patch pipeline produces. No directives remain. This HTML is applied to the session's happy-dom VDOM.

### 2. Patch Validation (how to verify patches against the template)

Today, the patch validator clones the VDOM, applies patches, and checks that target elements exist. With the template approach, the VDOM always contains **fully expanded HTML** (the result of template evaluation). Patches target this expanded HTML, same as today.

**Flow on state-only change:**

```
1. LLM emits: {"op":"state","set":{...}}
2. Backend updates state store
3. Backend re-evaluates template with new state → new full HTML
4. Backend diffs new HTML against current VDOM → generates patches
5. Backend validates generated patches (same validator as today)
6. Backend sends patches to frontend via SSE
```

The LLM doesn't emit patches for state changes — the system generates them by diffing. Patch validation is the same as today because the VDOM always contains concrete HTML.

**Flow on render template change:**

```
1. LLM emits: {"op":"render","html":"...new template..."}
2. Backend stores new template
3. Backend evaluates new template with current state → new full HTML
4. Backend diffs new HTML against current VDOM → generates patches
5. Backend validates + sends patches to frontend
```

Again, the LLM doesn't emit patches. The system diffs.

**Flow when LLM emits patches directly (escape hatch):**

The LLM can still emit `{"op":"patches",...}` for targeted micro-updates. These patches target the expanded VDOM, validated the same way as today. The backend then updates the VDOM but also needs to keep the template + state in sync — this is the tricky case. Options:
- a) Disallow direct patches when a template is active (simplest)
- b) Apply patches to VDOM but mark the template as "dirty" — next state change re-evaluates from template, overwriting manual patches
- c) Reverse-engineer state changes from patches (complex, fragile)

**Recommendation: option (a) for now.** When a render template exists, all UI changes go through state or render ops. Patches are only allowed when no template is active (backward compatible with existing sessions).

### 3. VDOM Diffing with diff-dom

Given two HTML states (before and after), produce the minimal diff to transform one into the other. We use [`diff-dom`](https://github.com/fiduswriter/diffDOM) (npm: `diff-dom`, LGPL-3.0, actively maintained) on **both backend and frontend** — no format conversion needed.

**Why diff-dom:**
- Works with HTML strings via `stringToObj()` — no browser DOM required, works in Node.js
- Can apply diffs to both virtual objects (backend) and real DOM (frontend)
- Non-destructive: prefers relocations over remove-then-insert (better for animated UIs)
- Diffs are JSON-serializable — send directly over SSE
- Route-based patching (index arrays) is faster than selector-based (`querySelector`)

**diff-dom uses route arrays, not CSS selectors.** A route like `[0, 1, 3]` means "root → first child → second child → fourth child". This is direct traversal — O(depth), no DOM search. Converting routes to our `#id`-based selectors would be wasteful computation. Instead, we **use diff-dom's native format directly**.

**Two patch formats, two modes:**

| Mode | Who generates patches | Format | Frontend applies with |
|---|---|---|---|
| **Template active** (Approach A) | System via diff-dom | diff-dom route-based diffs | `dd.apply(rootEl, diffs)` |
| **No template** (legacy/backward compat) | LLM | Our selector-based patches | Existing `applyPatch()` |

A session is either template-based or legacy — the formats never mix within a session. The frontend checks the SSE event type and routes to the right applicator.

**Backend flow (state change):**

```typescript
import { DiffDOM, stringToObj } from "diff-dom";

const dd = new DiffDOM({ valueDiffing: true });

// 1. Re-evaluate template with new state → new HTML string
const newHtml = evaluateTemplate(template, newState);

// 2. Diff against current VDOM HTML
const oldObj = stringToObj(currentHtml);
const newObj = stringToObj(newHtml);
const diffs = dd.diff(oldObj, newObj);

// 3. Apply to backend VDOM (happy-dom) — keeps VDOM in sync
dd.apply(vdomRoot, diffs);

// 4. Send raw diffs to frontend via SSE (JSON-serializable, no conversion)
stream.emit({ type: "diff", diffs });
```

**Frontend flow:**

```typescript
import { DiffDOM } from "diff-dom";

const dd = new DiffDOM();

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);

  if (data.type === "diff") {
    // Template-based session: apply diff-dom diffs directly
    dd.apply(document.getElementById("root"), data.diffs);
  } else if (data.type === "patch") {
    // Legacy session: apply selector-based patches (existing code)
    applyPatch(data.patch);
  }
};
```

**No translation layer, no route-to-selector conversion, no coalescing.** diff-dom produces the diffs, diff-dom applies them. We're just a transport layer in between.

**diff-dom operation types (for reference):**

| Action | What it does |
|---|---|
| `addAttribute`, `modifyAttribute`, `removeAttribute` | Attribute changes |
| `modifyTextElement`, `addTextElement`, `removeTextElement` | Text node changes |
| `addElement`, `removeElement`, `replaceElement` | Element add/remove/replace |
| `modifyValue`, `modifyChecked`, `modifySelected` | Form state changes |
| `relocateGroup` | Move a group of nodes (drag & drop, reorder) |

### 4. Prompt Construction (VDOM + state store → prompt)

Today, `getCompactHtmlFromCtx()` strips component template interiors from the VDOM to produce compact HTML for the prompt. With the template approach, we don't need to derive compact HTML from the VDOM at all — **the template IS the compact representation**.

**Current flow:**
```
VDOM (full HTML) → getCompactHtmlFromCtx() → [PAGE STATE] in prompt
```

**New flow:**
```
Stored template → [RENDER] in prompt (verbatim)
Stored state → [STATE] in prompt (JSON.stringify)
```

No VDOM-to-compact conversion needed. The template is already compact (it has directives like `c-for` instead of expanded elements). The state is already structured JSON. Both are stored directly and inserted into the prompt.

**Building the [RENDER] section:**
```typescript
const renderSection = template
  ? `[RENDER]\n${template}`
  : `[RENDER]\nEmpty — no template defined yet.`;
```

**Building the [STATE] section:**
```typescript
const stateSection = Object.keys(state).length > 0
  ? `[STATE]\n${Object.entries(state).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}`
  : `[STATE]\nEmpty`;
```

**Full prompt assembly:**
```
System prompt (static)
[COMPONENTS] — component catalog (from registry, same as today)
[RENDER] — stored template (verbatim)
[STATE] — stored state (serialised JSON)
[RELEVANT CONTEXT] — memory/RAG (same as today)
[RECENT CHANGES] — same as today
[NOW] — current actions (same as today)
```

### 5. State Storage & Persistence

- **Backend**: State store per session — `Record<string, unknown>` in a `Ref`, alongside component registry
- **Template**: Stored per session as a `string` in a `Ref`
- **DB snapshots**: State + template persisted alongside component registry and HTML
- **Session recovery**: Restore state, template, and registry. Re-evaluate template with state to reconstruct VDOM.
- **Frontend**: Receives patches via SSE (same as today). Optionally receives state ops for devtools / future React integration.

### 6. Frontend Handling

**Today (vanilla HTML):**
- Frontend receives **patches** via SSE (system-generated from diff, not LLM-generated)
- Frontend applies patches to DOM (same as today)
- Frontend optionally stores state ops for devtools
- Frontend does NOT evaluate templates — it only applies patches

**Future (React):**
- Frontend receives **state ops** via SSE
- Maps state to React component props
- Component definitions → React components
- State change → React re-render (no patches needed)
- Template becomes the React component tree definition

---

## How It Maps to React / Vue / Solid

### The Template IS a Component Tree

The render template describes the same thing as a React component's render function — just in a different syntax:

**Cuttlekit template:**
```html
<div id='app' class='p-8'>
  <h1>{title}</h1>
  <div id='todo-list'>
    <todo-item c-for='t of todos' id='todo-{t.id}' :text='t.text' :done='t.done'/>
  </div>
  <p c-if='isEmpty'>No todos yet</p>
  <p>{summary}</p>
</div>
```

**React equivalent:**
```jsx
function App({ title, todos, isEmpty, summary }) {
  return (
    <div id="app" className="p-8">
      <h1>{title}</h1>
      <div id="todo-list">
        {todos.map(t => <TodoItem key={t.id} id={`todo-${t.id}`} text={t.text} done={t.done} />)}
      </div>
      {isEmpty && <p>No todos yet</p>}
      <p>{summary}</p>
    </div>
  );
}
```

**Vue equivalent:**
```html
<div id="app" class="p-8">
  <h1>{{ title }}</h1>
  <div id="todo-list">
    <todo-item v-for="t of todos" :key="t.id" :id="'todo-' + t.id" :text="t.text" :done="t.done"/>
  </div>
  <p v-if="isEmpty">No todos yet</p>
  <p>{{ summary }}</p>
</div>
```

The conversion is mechanical:

| Cuttlekit | React | Vue |
|---|---|---|
| `c-for='t of todos'` | `{todos.map(t => ...)}` | `v-for='t of todos'` |
| `c-if='isEmpty'` | `{isEmpty && ...}` | `v-if='isEmpty'` |
| `:text='t.text'` | `text={t.text}` | `:text='t.text'` |
| `{title}` | `{title}` | `{{ title }}` |
| `{"op":"state","set":{...}}` | `setState(...)` | `store.commit(...)` |
| `{"op":"define","tag":"todo-item",...}` | `function TodoItem(props) {...}` | `Vue.component('todo-item', {...})` |

### Migration Path

1. **Today**: Backend evaluates template + state → HTML → happy-dom VDOM → diff → patches → vanilla frontend
2. **React**: Backend sends state ops to React frontend → React evaluates component tree → React reconciler handles DOM → no patches needed
3. **The template definition migrates from backend-evaluated to frontend-evaluated** — same structure, different runtime

The state store maps directly to React/Vue state management (useState, Vuex, Zustand, etc.). No extraction needed — the state is already a structured JSON object.

---

## Approach B: Aggressive Componentisation

### Core Idea

Don't build new infrastructure. Lean harder into the existing component system. Components already separate state (props) from presentation (template). The compact HTML already strips templates, showing only `<todo-item text="Buy milk" done="false"/>`. If *everything* is a component — including one-off elements like headers, counters, buttons — then the compact HTML becomes a clean, minimal representation where all styling lives in `[COMPONENTS]` (cached) and all data lives in component props (in the compact HTML).

### What "Aggressive" Means

Today, the system prompt says: "When creating 3+ similar elements, ALWAYS define a component first."

Aggressive componentisation changes this to: "Define a component for ANY element that has significant styling (3+ Tailwind classes) or holds data. Even one-off elements."

**After aggressive componentisation:**
```
[COMPONENTS]
<page-title text:string> — leaf
  template: <h1 class='text-4xl font-black tracking-tight uppercase bg-[#FF00FF] text-white
    px-6 py-3 border-4 border-[#0a0a0a] rotate-[-1deg] shadow-[4px_4px_0_#0a0a0a]'>{text}</h1>

<stat-badge label:string color:string rotate:string> — leaf
  template: <div class='bg-{color} border-4 border-[#0a0a0a] px-4 py-2 font-black
    rotate-[{rotate}deg]'>{label}</div>

<info-text text:string> — leaf
  template: <span class='text-sm text-zinc-500 font-mono'>{text}</span>

[PAGE STATE]  (compact HTML)
<div id='root' class='min-h-screen bg-[#fafafa] p-8'>
  <page-title id='title' text='EMBRACE:AI'/>
  <div id='stats-row' class='flex gap-4 flex-wrap my-8'>
    <stat-badge id='s1' label='120+ ATTENDEES' color='white' rotate='-2'/>
    <stat-badge id='s2' label='FREE SNACKS' color='[#FF00FF]' rotate='3'/>
    <stat-badge id='s3' label='3 SPEAKERS' color='white' rotate='1'/>
  </div>
  <info-text id='count' text='42 registered'/>
</div>
```

All styling in `[COMPONENTS]` (cached). Compact HTML is almost pure data + structure.

### Component Granularity

**Make it a component when:**
- Element has 3+ Tailwind classes (styling bloat)
- Element pattern repeats 2+ times (structural repetition)
- Element holds data the LLM must preserve (data fidelity)

**Keep it inline when:**
- Simple structural wrapper (`<div id="container">`) with 0-2 classes
- Pure layout element (`<div class="flex gap-4">`) with no data

Realistic page: ~9 component definitions, ~37 instances. ~450-900 tokens in `[COMPONENTS]`. Very manageable.

### What It Does NOT Solve

1. **Data is still in the HTML.** Props change on every action → `[PAGE STATE]` never fully stable for caching.
2. **No explicit data model.** LLM infers lists from individual instances. After 20 ops, drift accumulates.
3. **Multi-page state loss.** Navigate away → data gone from DOM, no store to reconstruct from.
4. **React mapping requires extraction.** Must reverse-engineer state from component instance props.

---

## Comparative Analysis

### Summary

|  | Caching | Data Fidelity | Impl. Complexity | LLM Reliability | React Future | Multi-Page |
|---|---|---|---|---|---|---|
| **A: Render + State** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **B: Aggressive Components** | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ |

### Where Each Shines

**Approach A shines when:**
- Pages are data-heavy (dashboards, lists, forms, e-commerce)
- Users trigger many state-changing actions (high cache value)
- Data fidelity is critical (prices, quantities, names must never drift)
- Multi-page or React migration is planned

**Approach B shines when:**
- Pages are presentation-heavy (landing pages, marketing, creative layouts)
- Users mostly restyle and iterate on design
- The UI is simple with few data interactions
- Speed of implementation matters — works today with a prompt change

---

## Path Forward

These are not mutually exclusive. They can be sequenced:

1. **Now:** Approach B — update system prompt to encourage aggressive componentisation. Immediate token savings, no code changes.

2. **Next:** Build Approach A. Template evaluator (~200 lines), state store, VDOM differ (~250 lines), new op types. Start with minimal attributes (`each`/`if`), upgrade to Vue directives if nesting becomes an issue.

3. **Later:** Roll out A alongside B. Components handle styling. Template handles structure and iteration. State handles data. Three-way separation:

```
[COMPONENTS]  ← styling (component templates)
[RENDER]      ← structure (template with c-for/c-if)
[STATE]       ← data (structured JSON)
```

Components handle styling. Template handles structure. State handles data. Clean separation of all three concerns.
