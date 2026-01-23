# Element IDs: The Selector Problem

## Problem

When users create multiple similar components (e.g., "create 3 more counters"), the LLM generates HTML but often uses non-unique or identical selectors. Later, when clicking a button on counter #3, the patch might target counter #1 instead.

**Example scenario:**
1. User: "Create a counter" → LLM creates `<div id="counter">...<span id="value">0</span>...</div>`
2. User: "Create 3 more counters" → LLM creates similar divs, potentially reusing `id="counter"` or `id="value"`
3. User clicks +1 on counter #3
4. LLM generates patch: `{"selector": "#value", "text": "1"}` → Updates counter #1 (first match)

**Root cause:** Two separate issues:
1. LLM doesn't generate unique IDs for repeated elements
2. LLM doesn't know WHICH element triggered the action

## The Real Problem

It's not just about unique IDs - it's that **the LLM doesn't know which specific element triggered the action**.

Currently:
- User clicks +1 on counter #3
- Server receives: `{ action: "increment", actionData: {...} }`
- LLM sees: "Action 'increment' was triggered" + full HTML
- LLM has to GUESS which counter to update

Even with perfect unique IDs, the LLM doesn't know which `#counter-3-btn` was clicked unless we tell it.

## Solution: Action Source Context + Stream ID Injection

Two complementary changes that work with SSR:

### 1. Capture Action Source ID

When an action is triggered, capture the ID of the element (or nearest identifiable parent).

**Frontend (main.ts):**
```typescript
triggerAction(actionElement: Element) {
  const action = actionElement.getAttribute("data-action");
  // Find the clicked element's ID or nearest parent with ID
  const sourceId = actionElement.id || actionElement.closest('[id]')?.id;

  this.sendRequest({
    type: "generate",
    action,
    actionData: { ...formData, ...actionData },
    sourceElementId: sourceId,  // NEW: tell server which element
  });
}
```

**Backend prompt:**
```
Action 'increment' triggered on element #counter-3-btn
```

Now the LLM knows EXACTLY which element was clicked and can target siblings/parents appropriately.

### 2. Stream ID Injection (Server-Side)

Transform LLM output DURING streaming to add unique IDs before content reaches client or VDOM.

**Why during stream?**
- IDs exist immediately when client receives HTML
- IDs exist when VDOM stores HTML
- Next request sees IDs (LLM can reference them)
- Works with SSR (server is source of truth)

**Implementation in service.ts:**
```typescript
const enrichHtml = (html: string): string => {
  const window = new Window();
  window.document.body.innerHTML = html;

  let counter = 0;
  window.document.querySelectorAll('[data-action]:not([id])').forEach(el => {
    el.id = `el-${Date.now().toString(36)}-${counter++}`;
  });

  return window.document.body.innerHTML;
};

// Transform patches before emitting:
const enrichPatch = (patch: Patch): Patch => {
  if ('html' in patch) return { ...patch, html: enrichHtml(patch.html) };
  if ('append' in patch) return { ...patch, append: enrichHtml(patch.append) };
  if ('prepend' in patch) return { ...patch, prepend: enrichHtml(patch.prepend) };
  return patch;
};
```

### 3. Strict Selector Validation (Optional)

Reject patches where the selector matches multiple elements:

```typescript
const elements = doc.querySelectorAll(patch.selector);
if (elements.length > 1) {
  yield* new PatchValidationError({
    patch,
    reason: "ambiguous_selector",
    message: `Selector matches ${elements.length} elements, must be unique`,
  });
}
```

This forces the LLM to use specific IDs via the retry mechanism.

## Why This Works Better

| Aspect | Previous Options | New Approach |
|--------|------------------|--------------|
| LLM knows target | No | Yes (sourceElementId) |
| IDs in current request | No (added after) | Yes (stream transform) |
| SSR compatible | Client-dependent | Server is source of truth |
| Enforcement | Hope LLM complies | Validation rejects ambiguous |

## ID Generation Constraints

**DON'T want:**
- UUIDs on every element (`id="550e8400-e29b-41d4-a716-446655440000"`)
- Long generated strings (`id="el-m1abc2d3f-counter-button-increment"`)
- IDs on non-interactive elements

**DO want:**
- Short, sequential IDs (`id="e1"`, `id="e2"`)
- Only on `[data-action]` elements that don't already have an ID
- LLM-assigned semantic IDs preserved (`id="add-btn"` stays)

**ID scheme:**
```typescript
// Simple sequential - short and predictable
let counter = 0;
const generateId = () => `e${counter++}`;

// Only target interactive elements without IDs
doc.querySelectorAll('[data-action]:not([id])').forEach(el => {
  el.id = generateId();
});
```

Result: `e0`, `e1`, `e2`, ... - minimal footprint, unique within page.

## Implementation Complexity

1. **Action source context**: ~10 lines frontend, ~5 lines prompt
2. **Stream ID injection**: ~30 lines in service.ts (only [data-action]:not([id]))
3. **Ambiguous selector validation**: ~10 lines in patch-validator.ts

Total: ~55 lines of code, no architectural changes.

## Data Flow

```
User clicks #counter-3-btn
    ↓
Frontend: { action: "increment", sourceElementId: "counter-3-btn" }
    ↓
Server prompt: "Action 'increment' on #counter-3-btn"
    ↓
LLM generates: { selector: "#counter-3-value", text: "6" }
    ↓
Stream transform: (adds IDs to any new elements)
    ↓
Validation: (rejects if selector matches multiple)
    ↓
Client receives patch with IDs already present
```

## Key Insight

The core fix is **action source context**, not ID generation. If the LLM knows "user clicked the +1 button on counter #3", it can generate the right patch even without perfect IDs - it can use relative references like "the span sibling of #counter-3-btn".

ID injection is a safety net that:
- Ensures every interactive element CAN be targeted
- Makes the next request's HTML have concrete IDs to reference
- Enables strict validation to catch ambiguous selectors

But the biggest win is simply telling the LLM which element was clicked.

---

## Alternative: Component Scoping (Future)

For complex UIs, could introduce explicit component boundaries:

```html
<div data-component="counter" data-cid="c1">
  <span class="value">5</span>
  <button data-action="increment">+</button>
</div>
```

Patches become component-scoped:
```json
{"component": "c1", "selector": ".value", "text": "6"}
```

Server resolves: `[data-cid="c1"] .value`

This is more powerful but requires more LLM coordination. Save for later if simpler approach proves insufficient.
