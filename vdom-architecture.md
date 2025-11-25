# VDOM Architecture for Generative UI

## Current Architecture

1. **Frontend (Alpine.js)**: Sends requests to backend with action data and form inputs
2. **Backend**: Passes prompt + conversation history to LLM
3. **LLM**: Generates **complete HTML** for the entire page
4. **Backend**: Returns full HTML to frontend
5. **Frontend**: Replaces entire content via Alpine's `x-html`

### The Performance Problem

Every interaction triggers a **full page regeneration** by the LLM. As the UI grows more complex, generation time increases significantly.

**Key insight**: Network payload size is NOT the bottleneck. HTML is small. The bottleneck is **LLM token generation time**. Generating 2000 tokens takes much longer than generating 200 tokens.

---

## Proposed Architecture: LLM Generates Patches

```
┌─────────────┐     ┌─────────────────────────┐     ┌─────────────┐
│   Client    │────▶│        Server           │────▶│     LLM     │
│             │     │                         │     │             │
│  Render     │◀────│  happy-dom (VDOM)       │◀────│  Generate   │
│  Full HTML  │     │  + diffdom validation   │     │  Patches    │
└─────────────┘     └─────────────────────────┘     └─────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  If patches     │
                    │  invalid:       │
                    │  retry with     │
                    │  error feedback │
                    └─────────────────┘
```

### Core Idea

1. **Server maintains VDOM** using happy-dom (lightweight DOM in Node.js)
2. **LLM generates patches** (not full HTML) - faster, fewer tokens
3. **Server applies patches** using diffdom to the VDOM
4. **Validation with retry**: If patches fail to apply, give LLM error feedback and retry
5. **Server sends full HTML** to client (serialized from VDOM)
6. **Client stays simple** - just renders HTML, no patch logic needed

### Why This Works

| Aspect | Full HTML Generation | Patch Generation |
|--------|---------------------|------------------|
| LLM tokens | ~2000 for full page | ~50-200 for patch |
| Generation time | Slow, scales with page size | Fast, scales with change size |
| Network payload | ~2KB | ~2KB (still send full HTML) |
| Client complexity | Simple | Simple |
| Server complexity | Low | Medium |

The win is **LLM generation speed**, not network efficiency. A counter increment that currently requires regenerating 2000 tokens of HTML becomes a 50-token patch operation.

### Dropping Alpine.js

Alpine.js becomes unnecessary in this setup:
- Currently used for: `x-data` state, `x-html` rendering
- But actual interactivity already uses `data-action` with event delegation
- With server-rendered HTML, we just need vanilla JS event delegation

The client becomes pure vanilla JS:
- Fetch HTML from server
- Render to DOM
- Event delegation for `data-action` clicks
- That's it

---

## Patch Format for LLM

The LLM needs a simple, unambiguous patch format. Options:

### Option 1: diffdom-style patches

```json
[
  { "action": "modifyTextElement", "route": [0, 1, 0], "oldValue": "41", "newValue": "42" },
  { "action": "modifyAttribute", "route": [0, 2], "name": "class", "newValue": "status online" }
]
```

### Option 2: Simplified custom format

```json
[
  { "op": "text", "path": "#counter .value", "value": "42" },
  { "op": "attr", "path": "#status", "attr": "class", "value": "status online" },
  { "op": "replace", "path": "#todo-list", "html": "<ul>...</ul>" }
]
```

### Option 3: CSS selector + operation

```json
[
  { "selector": "#counter", "text": "42" },
  { "selector": "#status", "addClass": "online", "removeClass": "offline" },
  { "selector": "#todos", "append": "<li>New item</li>" }
]
```

**Recommendation**: Option 3 (CSS selectors) - LLMs understand CSS selectors well, and it's human-readable. We can translate to diffdom format on the server.

---

## Server-Side Implementation

### Tech Stack

- **happy-dom**: Lightweight DOM implementation for Node.js
- **diffdom**: Diff/patch library for DOM trees
- **Effect**: For service structure (as per project conventions)

### Services

```
┌─────────────────────────────────────────────────────────┐
│                    VdomService                          │
├─────────────────────────────────────────────────────────┤
│ - Maintains happy-dom Window per session                │
│ - Applies LLM patches to VDOM                           │
│ - Serializes VDOM to HTML string                        │
│ - Validates patches (returns errors for retry)          │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                  GenerateService                        │
├─────────────────────────────────────────────────────────┤
│ - Prompts LLM for patches (not full HTML)               │
│ - Includes current VDOM state in context                │
│ - Handles retry loop on patch errors                    │
│ - Falls back to full regeneration if retries exhausted  │
└─────────────────────────────────────────────────────────┘
```

### Session State

```typescript
type SessionState = {
  history: ConversationMessage[]
  vdom: Window  // happy-dom Window instance
}
```

### Patch Application Flow

```typescript
const applyPatches = (session: SessionState, patches: Patch[]) =>
  Effect.gen(function* () {
    const errors: string[] = []

    for (const patch of patches) {
      const result = yield* tryApplyPatch(session.vdom.document, patch)
      if (result._tag === 'Error') {
        errors.push(result.message)
      }
    }

    if (errors.length > 0) {
      return Effect.fail({ type: 'PatchError', errors })
    }

    return session.vdom.document.body.innerHTML
  })
```

### Retry Loop

```typescript
const generateWithRetry = (options: GenerateOptions, maxRetries = 2) =>
  Effect.gen(function* () {
    let lastErrors: string[] = []

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const patches = yield* llm.generatePatches({
        ...options,
        previousErrors: lastErrors  // Feed errors back to LLM
      })

      const result = yield* vdomService.applyPatches(patches)

      if (result._tag === 'Success') {
        return result.html
      }

      lastErrors = result.errors
    }

    // Fallback: full regeneration
    yield* Effect.log('Patch retries exhausted, falling back to full generation')
    return yield* llm.generateFullHtml(options)
  })
```

---

## LLM Prompt Strategy

### System Prompt (simplified)

```
You are a UI update engine. Given the current HTML state and a user action,
generate ONLY the patches needed to update the UI.

CURRENT HTML:
${currentHtml}

Respond with a JSON array of patches:
- { "selector": "#id", "text": "new text" } - update text content
- { "selector": ".class", "html": "<div>...</div>" } - replace innerHTML
- { "selector": "#id", "attr": { "class": "new-class" } } - set attributes
- { "selector": "#list", "append": "<li>new item</li>" } - append child
- { "selector": "#item-3", "remove": true } - remove element

Keep patches minimal. Only include what actually changes.
```

### Error Feedback Prompt

```
Your previous patches failed with these errors:
${errors.join('\n')}

The current HTML state is:
${currentHtml}

Please generate corrected patches.
```

---

## Client-Side Implementation

The client becomes minimal vanilla JS:

```typescript
const app = {
  sessionId: null,

  async sendAction(action: string, data?: Record<string, unknown>) {
    const formData = collectFormData()

    const response = await fetch('/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: this.sessionId,
        action,
        actionData: { ...formData, ...data }
      })
    })

    const { html, sessionId } = await response.json()
    this.sessionId = sessionId
    document.getElementById('app').innerHTML = html
  },

  init() {
    // Event delegation for data-action
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]')
      if (el) {
        e.preventDefault()
        const action = el.getAttribute('data-action')
        const data = JSON.parse(el.getAttribute('data-action-data') || '{}')
        this.sendAction(action, data)
      }
    })

    // Enter key handling
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('input')) {
        const actionEl = e.target.closest('[data-action]') ||
                         e.target.closest('div, form')?.querySelector('[data-action]')
        if (actionEl) {
          e.preventDefault()
          actionEl.click()
        }
      }
    })

    // Initial load
    this.sendAction('init')
  }
}

app.init()
```

No Alpine.js, no VDOM on client, no patch application. Just:
1. Send action to server
2. Receive full HTML
3. Render it

---

## Trade-offs

### Pros

- **Faster LLM generation**: Patches are much smaller than full HTML
- **Simple client**: No client-side VDOM or patch logic
- **Validation**: Server validates patches before committing
- **Fallback**: Can always fall back to full regeneration
- **Debuggable**: Can log patches to see exactly what LLM changed

### Cons

- **Server memory**: Must maintain VDOM per session (happy-dom is lightweight though)
- **Prompt complexity**: LLM needs to understand patch format
- **Potential for drift**: If LLM misunderstands current state
- **New failure mode**: Patch errors require retry logic

### Risk Mitigation

1. **State drift**: Include current HTML in every prompt so LLM always has ground truth
2. **Patch errors**: Retry loop with error feedback (2-3 attempts)
3. **Exhausted retries**: Fall back to full HTML generation
4. **Complex updates**: LLM can always output a full `replace` patch for entire sections

---

## Open Questions

1. **Patch granularity**: Should we encourage small patches or allow large section replacements?
2. **Streaming**: Can we stream patch generation for perceived speed?
3. **Initial render**: Full HTML generation for first render, then patches?
4. **Memory cleanup**: When to garbage collect session VDOMs?

---

## Implementation Status

✅ **Completed:**

1. **VdomService** ([vdom.ts](apps/backend/src/services/vdom.ts))
   - Manages happy-dom Window instances per session
   - Applies patches using native DOM methods
   - Returns errors for retry loop

2. **GenerateService** ([generate.ts](apps/backend/src/services/generate.ts))
   - `generateFullHtml()` - for initial render and fallback
   - `generatePatches()` - for incremental updates

3. **RequestHandlerService** ([request-handler.ts](apps/backend/src/services/request-handler.ts))
   - Routes to full HTML or patch generation based on context
   - Implements retry loop (max 2 retries) with error feedback
   - Falls back to full HTML if patches fail

4. **Client** ([main.ts](apps/webpage/src/main.ts))
   - Pure vanilla JS (no Alpine.js)
   - Event delegation for `data-action` clicks
   - Just renders HTML received from server

## Next Steps

1. Test with existing todo/counter examples
2. Measure token reduction and speed improvement
3. Add streaming for perceived speed
4. Consider session cleanup/garbage collection
