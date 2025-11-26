# Performance Ideas

The bottleneck is LLM generation time. Already using Groq (~1000 tok/s). Network latency is negligible.

---

## Ranking

| Idea | Speed Gain | Complexity | Notes |
|------|-----------|------------|-------|
| 1. Streaming HTML | ⭐⭐⭐⭐ (perceived) | Low | First token in ~100ms |
| 2. Speculative Pre-gen | ⭐⭐⭐⭐⭐ | Medium | Zero latency on hit |
| 3. Shorter prompts | ⭐⭐⭐ | Low | Less tokens = faster |
| 4. Component Templates | ⭐⭐⭐⭐⭐ | High | 50 tokens output vs 2000 |
| 5. Semantic Caching | ⭐⭐⭐ | Medium | Instant for similar prompts |
| 6. Optimistic UI | ⭐⭐⭐ (perceived) | Low | Instant perceived response |

---

## 1. Streaming HTML

Stream tokens as they generate. User sees content appearing progressively.

**Speed**: First token in ~100ms vs waiting for full response.

**Server (using Vercel AI SDK)**:
```typescript
import { streamText } from "ai"

const stream = await streamText({
  model: llm.model,
  prompt: systemPrompt,
})

// Server-Sent Events
for await (const chunk of stream.textStream) {
  res.write(`data: ${JSON.stringify({ chunk })}\n\n`)
}
```

**Client**:
```typescript
const eventSource = new EventSource("/generate-stream")
let html = ""

eventSource.onmessage = (e) => {
  const { chunk } = JSON.parse(e.data)
  html += chunk
  contentEl.innerHTML = html
}
```

**Challenge**: Partial HTML may be invalid. Options:
1. Buffer until valid (loses streaming benefit)
2. Use a forgiving parser
3. Stream into hidden element, swap when complete

---

## 2. Speculative Pre-generation

Generate results before user acts.

**How it works**:
```typescript
// On hover, start generating
document.addEventListener("mouseover", (e) => {
  const button = e.target.closest("[data-action]")
  if (button) {
    const action = button.dataset.action
    const actionData = JSON.parse(button.dataset.actionData || "{}")
    prefetch(action, actionData)
  }
})

// Cache prefetched results
const prefetchCache = new Map<string, Promise<Patch[]>>()

function prefetch(action: string, actionData: object) {
  const key = JSON.stringify({ action, actionData })
  if (!prefetchCache.has(key)) {
    prefetchCache.set(key, generatePatches(action, actionData))
  }
}

// On click, use prefetched if available
async function handleClick(action: string, actionData: object) {
  const key = JSON.stringify({ action, actionData })
  const cached = prefetchCache.get(key)

  if (cached) {
    const patches = await cached
    applyPatches(patches)
    prefetchCache.delete(key)
  } else {
    const patches = await generatePatches(action, actionData)
    applyPatches(patches)
  }
}
```

**Speed**: If user hovers for 200ms before clicking, and generation takes 200ms, click is instant.

**Edge cases**:
- User hovers but doesn't click → wasted generation (acceptable)
- Form data changes after hover → invalidate prefetch
- Too many hovers → throttle/queue

---

## 3. Shorter Prompts

Less tokens = faster generation.

**Current prompt size**:
- System prompt: ~500 tokens
- Current HTML: ~500-2000 tokens
- Total input: ~1000-2500 tokens

**Optimizations**:

1. **Minify HTML before sending**:
   ```typescript
   const minified = currentHtml
     .replace(/\s+/g, ' ')
     .replace(/>\s+</g, '><')
     .replace(/<!--.*?-->/g, '')
   ```

2. **Truncate to relevant section**:
   ```typescript
   function getRelevantHtml(actionData: object): string {
     const targetId = actionData.id
     if (targetId) {
       const el = document.getElementById(targetId)
       return el?.closest("section")?.outerHTML || currentHtml
     }
     return currentHtml
   }
   ```

3. **Shorter system prompt**: Remove verbose examples.

---

## 4. Component Templates

Instead of generating raw HTML, LLM outputs structured data.

**Current**: LLM outputs ~2000 tokens of HTML
**With templates**: LLM outputs ~50 tokens of JSON

```json
{
  "type": "TodoList",
  "props": {
    "items": [
      { "id": 1, "text": "Buy milk", "done": false },
      { "id": 2, "text": "Call mom", "done": true }
    ]
  }
}
```

**Speed**: 40x less output = 40x faster generation.

**Implementation**:
1. Define component library (TodoList, DataTable, Form, Counter, etc.)
2. LLM outputs component tree with props
3. Client renders from library

**For patches**:
```json
{ "action": "toggle", "target": "todo-1", "props": { "done": true } }
```

Instead of raw HTML patches.

**Tradeoff**: Less flexible. Novel UIs need raw HTML fallback. But covers 80% of cases.

---

## 5. Semantic Caching

Cache by meaning, not exact text.

```
"add a todo app" → cached result
"I need a task list" → same cache hit
"todo list please" → same cache hit
```

**Implementation**:
```typescript
import { embed } from "ai"

const cache = new Map<string, { embedding: number[], result: string }>()

async function getCachedOrGenerate(prompt: string): Promise<string> {
  const embedding = await embed({ model: embeddingModel, value: prompt })

  for (const [key, entry] of cache) {
    const similarity = cosineSimilarity(embedding, entry.embedding)
    if (similarity > 0.95) {
      return entry.result
    }
  }

  const result = await generate(prompt)
  cache.set(prompt, { embedding, result })
  return result
}
```

**Speed**: Instant for similar prompts.

**Limitation**: Only helps repeated/similar prompts across users.

---

## 6. Optimistic UI

Apply changes instantly, verify in background.

```typescript
function optimisticToggle(el: HTMLInputElement) {
  el.checked = !el.checked  // Instant

  // Verify with server
  generatePatches("toggle", { id: el.id })
    .catch(() => {
      el.checked = !el.checked  // Rollback
    })
}
```

**Speed**: Instant perceived response.

**Limitation**: Only safe for simple, reversible operations. Rollback can be jarring.

---

## Recommended Approach

### Phase 1: Perceived Speed
1. **Streaming** - immediate visual feedback
2. **Optimistic UI** - instant for simple ops

### Phase 2: Actual Speed
3. **Speculative pre-gen** - zero latency on predicted actions
4. **Shorter prompts** - reduce input tokens

### Phase 3: Structural Change
5. **Component templates** - 40x less output tokens (biggest win, most work)

---

## Expected Results

| Optimization | Impact |
|--------------|--------|
| Streaming | 100ms perceived vs 500ms |
| + Speculative pre-gen | 0ms on hover-then-click |
| + Component templates | 50 tokens output vs 2000 |

Best case with component templates: ~50ms for patches (vs ~500ms raw HTML).

---

## 7. Server-Triggered Compiled Actions + Browser LLM

Split the work: Server does smart planning, browser does simple execution.

**The Problem**: Server LLM is fast (1000 tok/s) but every action requires a round-trip. Browser LLM is slow (50 tok/s) but has local context and no latency.

**The Insight**: Server generates a *template* (small output), browser LLM *fills it in* (small task, local context).

**How it works**:

```
User clicks "add item"
    ↓
Server generates template (fast, ~50 tokens):
{
  "action": "addListItem",
  "template": "Create a list item matching existing style with text '{userInput}'",
  "context": ["#todo-list > li:first-child"],  // DOM references for style matching
  "params": { "userInput": "..." }
}
    ↓
Browser LLM receives:
- Template instruction
- Actual DOM content of referenced elements
- Current form values
    ↓
Browser LLM generates HTML (~100 tokens)
    ↓
Apply to DOM
```

**Why this works**:
- Server output: ~50 tokens (template) vs ~500 tokens (full HTML)
- Browser LLM task is simple: "fill in the blanks" + "match existing style"
- Browser has full local context (DOM state, form values, scroll position)
- Works offline for cached templates
- Template can be reused for similar actions

**Template types**:

1. **Parameterized insert**: `"Add item with text '{text}' to list '{listId}'"`
2. **Style-matched clone**: `"Clone element matching '{selector}' with new values {...}"`
3. **Conditional update**: `"If '{condition}' toggle class '{class}' on '{selector}'"`
4. **Data transform**: `"Re-render '{selector}' with updated data {...}"`

**Browser LLM requirements**:
- Understand basic HTML structure
- Match existing styles from examples
- Fill template variables
- Small context window is fine (~2k tokens)

**Caching strategy**:
```typescript
// Server sends template once per action type
const templateCache = new Map<string, CompiledTemplate>()

// On action, check if template exists
if (templateCache.has(actionType)) {
  // Browser LLM executes with local context
  const html = await browserLLM.execute(templateCache.get(actionType), localContext)
  applyToDom(html)
} else {
  // Request template from server, cache it
  const template = await fetchTemplate(actionType)
  templateCache.set(actionType, template)
  // Then execute locally
}
```

**Speed**: After first action, similar actions are instant (browser-only).

---

## 8. Dynamic Component Registry

Generate components on the fly, register them, reuse them.

**The Problem**: Hardcoded component templates are fast but inflexible. Raw HTML generation is flexible but slow.

**The Solution**: Two-layer architecture:
1. **Primitives** (hardcoded): shadcn-level building blocks
2. **Composites** (generated): AI creates components from primitives, registers them

**Primitive Layer** (always available):
```typescript
const PRIMITIVES = {
  Button: ({ variant, size, children, onClick }) => ...,
  Input: ({ type, placeholder, value, onChange }) => ...,
  Checkbox: ({ checked, label, onChange }) => ...,
  Card: ({ title, children }) => ...,
  List: ({ items, renderItem }) => ...,
  Table: ({ columns, rows }) => ...,
  // ~20 shadcn-style primitives
}
```

**Composite Layer** (generated on demand):
```typescript
// Registry stores generated components
const componentRegistry = new Map<string, ComponentDefinition>()

type ComponentDefinition = {
  name: string
  props: Record<string, PropType>
  render: (props: any) => VNode  // Uses primitives
}
```

**Generation flow**:

```
User: "I need a todo list"
    ↓
Server checks: Does "TodoList" exist in registry?
    ↓
NO → Generate component definition:
{
  "name": "TodoList",
  "props": {
    "items": "array<{ id: string, text: string, done: boolean }>",
    "onToggle": "function",
    "onDelete": "function"
  },
  "render": {
    "type": "Card",
    "props": { "title": "Tasks" },
    "children": [{
      "type": "List",
      "props": {
        "items": "{items}",
        "renderItem": {
          "type": "div",
          "className": "flex items-center gap-2 p-2",
          "children": [
            { "type": "Checkbox", "props": { "checked": "{item.done}", "onChange": "{onToggle(item.id)}" }},
            { "type": "span", "props": { "className": "{item.done ? 'line-through text-gray-400' : ''}" }, "children": "{item.text}" },
            { "type": "Button", "props": { "variant": "ghost", "size": "sm", "onClick": "{onDelete(item.id)}" }, "children": "×" }
          ]
        }
      }
    }]
  }
}
    ↓
Register component, return instance:
{
  "component": "TodoList",
  "props": {
    "items": [
      { "id": "1", "text": "Buy milk", "done": false }
    ]
  }
}
```

**Subsequent requests are tiny**:
```
User: "Add 'call mom'"
    ↓
Server: TodoList exists, just update props
{
  "component": "TodoList",
  "props": {
    "items": [
      { "id": "1", "text": "Buy milk", "done": false },
      { "id": "2", "text": "Call mom", "done": false }
    ]
  }
}
```

**Component evolution**:
```
User: "Make checkboxes bigger"
    ↓
Server: Update TodoList definition
{
  "action": "updateComponent",
  "name": "TodoList",
  "patch": {
    "render.children[0].props.renderItem.children[0].props.size": "lg"
  }
}
```

**Registry scoping**:
- **Session-scoped**: Fresh registry per user, evolves with conversation
- **Global cache**: Popular components cached across users
- **Persistent**: Save user's component library

**Output size comparison**:
| Scenario | Raw HTML | Component Instance |
|----------|----------|-------------------|
| Initial TodoList | ~800 tokens | ~200 tokens (def) + ~50 tokens (instance) |
| Add item | ~800 tokens | ~30 tokens (props update) |
| Toggle item | ~800 tokens | ~20 tokens (props update) |

**After initial generation, updates are 40x smaller.**

**Hybrid approach for novel UIs**:
```typescript
// Try component approach first
const result = await generateWithComponents(prompt, registry)

if (result.needsNewPrimitive) {
  // Fall back to raw HTML for truly novel UI
  const html = await generateRawHtml(prompt)
  // Optionally: extract and register new component from the HTML
}
```

---

## Combining Ideas: The Full Stack

```
User Action
    ↓
┌─────────────────────────────────────────────────────┐
│ Client                                              │
│                                                     │
│  1. Check template cache (from idea #7)             │
│     → HIT: Browser LLM executes locally (instant)   │
│     → MISS: Continue to server                      │
│                                                     │
│  2. Check component registry (from idea #8)         │
│     → Component exists: Optimistic update (instant) │
│     → Continue to server for validation             │
└─────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────┐
│ Server                                              │
│                                                     │
│  3. Generate response:                              │
│     - Simple action → Return template for browser   │
│     - Known component → Return props update         │
│     - New component → Generate definition + instance│
│     - Novel UI → Fall back to raw HTML              │
└─────────────────────────────────────────────────────┘
    ↓
Client applies result, caches templates/components
```

**Expected performance**:
| Scenario | Latency |
|----------|---------|
| Cached template + browser LLM | ~200ms (no server) |
| Known component, props update | ~50ms (tiny payload) |
| New component generation | ~300ms (one-time) |
| Novel UI fallback | ~500ms (full HTML) |

Most interactions after initial setup: <100ms.
