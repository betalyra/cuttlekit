# Input Handling Analysis

## Current State

The frontend currently handles two types of interactions:

1. **Click events** on elements with `data-action` attribute
2. **Enter key** in input/textarea fields

```typescript
// Click handler
document.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest("[data-action]")
  if (el) {
    e.preventDefault()
    this.triggerAction(el)
  }
})
```

## The Problem

When clicking a checkbox with `data-action="toggle"`:

1. Click event fires on the checkbox
2. `e.preventDefault()` is called → **checkbox never visually toggles**
3. `collectFormData()` runs → collects the **old** (pre-click) state
4. Request sent with stale data

Even without `preventDefault`, there's a timing issue: the browser updates the checkbox state asynchronously, but we collect form data synchronously.

## Input Types Not Handled

| Input Type | Current Status | Expected Behavior |
|------------|----------------|-------------------|
| Button click | ✅ Working | Click triggers action |
| Checkbox | ❌ Broken | Toggle should trigger action with new state |
| Radio button | ❌ Broken | Selection should trigger action |
| Select dropdown | ❌ Not handled | Change should trigger action |
| Text input | ⚠️ Partial | Only Enter key works, no blur/change |
| Range slider | ❌ Not handled | Change should trigger action |
| Color picker | ❌ Not handled | Change should trigger action |

## Proposed Solutions

### Option 1: Use `change` Event for Form Inputs

Listen for `change` events on inputs with `data-action`:

```typescript
document.addEventListener("change", (e) => {
  const target = e.target as HTMLElement
  if (target.hasAttribute("data-action")) {
    this.triggerAction(target)
  }
})
```

**Pros:**
- Native event, fires after state is updated
- Works for checkbox, radio, select, range, color
- No timing issues

**Cons:**
- Text inputs fire `change` on blur, not on typing (may need special handling)

### Option 2: Microtask Delay for Click Events

Let the browser update state before collecting:

```typescript
document.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest("[data-action]")
  if (el) {
    const isFormInput = el.matches("input, select, textarea")
    if (!isFormInput) e.preventDefault()

    // Let browser update state first
    queueMicrotask(() => this.triggerAction(el))
  }
})
```

**Pros:**
- Minimal change to existing code
- Click still works for everything

**Cons:**
- Feels hacky
- Click on checkbox is less semantic than change

### Option 3: Hybrid Approach (Recommended)

Use the right event for each input type:

```typescript
// Buttons: click
document.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest("button[data-action], a[data-action]")
  if (el) {
    e.preventDefault()
    this.triggerAction(el)
  }
})

// Form inputs: change
document.addEventListener("change", (e) => {
  const target = e.target as HTMLElement
  if (target.matches("input[data-action], select[data-action], textarea[data-action]")) {
    this.triggerAction(target)
  }
})

// Text inputs: Enter key (existing)
// Keep current keydown handler
```

**Pros:**
- Semantically correct events for each input type
- No timing issues
- Clear separation of concerns

**Cons:**
- Slightly more code

### Option 4: Debounced Input for Text Fields

For real-time text input (like search-as-you-type):

```typescript
let debounceTimer: number | null = null

document.addEventListener("input", (e) => {
  const target = e.target as HTMLElement
  if (target.matches("input[data-action-debounce], textarea[data-action-debounce]")) {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      this.triggerAction(target)
    }, 300)
  }
})
```

Use `data-action-debounce="search"` for real-time input handling.

## Recommendation

Implement **Option 3 (Hybrid)** as the base, with **Option 4** as an optional enhancement.

This gives us:
- `click` → buttons, links
- `change` → checkbox, radio, select, range, color
- `keydown Enter` → text input explicit submit
- `input` with debounce → real-time text input (opt-in via `data-action-debounce`)

## Implementation Checklist

- [x] Add `change` event listener for form inputs with `data-action`
- [x] Modify click handler to only target buttons/links
- [x] Keep Enter key handler as-is
- [ ] Optional: Add debounced `input` handler for `data-action-debounce`
- [x] Update system prompt to explain the different trigger modes
- [ ] Test with: checkbox, radio, select, range, color picker

---

## Brainstorm: Programmatic Actions vs AI-Generated Patches

### The Problem

Currently, every action (add, delete, toggle, increment) goes through the AI to generate patches. This has issues:

1. **Latency** - Even simple operations require an LLM round-trip (~200-500ms)
2. **Unreliability** - AI might generate wrong selectors, miss IDs, or produce invalid patches
3. **Cost** - Every checkbox toggle costs tokens
4. **Overkill** - Toggling a checkbox is deterministic, not creative

### Observation

Many UI operations are **deterministic**:

| Action | Input | Output | AI Needed? |
|--------|-------|--------|------------|
| Toggle checkbox | element id, current state | `{attr: {checked: null/checked}}` | ❌ No |
| Delete item | element id | `{remove: true}` | ❌ No |
| Increment counter | element id, current value | `{text: currentValue + 1}` | ❌ No |
| Add todo item | list id, item data | `{append: "<li>..."}` | ⚠️ Maybe |
| "Make it blue" | current HTML, prompt | new HTML | ✅ Yes |
| "Add a sidebar" | current HTML, prompt | patches | ✅ Yes |

### Proposed Solution: Action Handlers

Define **client-side or server-side handlers** for common actions that generate patches programmatically.

#### Option A: Client-Side Handlers

```typescript
const actionHandlers: Record<string, (el: Element, data: any) => Patch[] | null> = {
  toggle: (el, data) => {
    const isChecked = (el as HTMLInputElement).checked
    return [{ selector: `#${el.id}`, attr: { checked: isChecked ? "checked" : null } }]
  },

  delete: (el, data) => {
    const targetId = data.id
    return [{ selector: `#todo-${targetId}`, remove: true }]
  },

  increment: (el, data) => {
    const counterEl = document.querySelector(data.target || "#counter-value")
    const current = parseInt(counterEl?.textContent || "0")
    return [{ selector: data.target || "#counter-value", text: String(current + 1) }]
  },
}

// In triggerAction:
const handler = actionHandlers[action]
if (handler) {
  const patches = handler(element, actionData)
  if (patches) {
    patches.forEach(p => this.applyPatch(p))
    // Also sync to server VDOM
    this.syncPatches(patches)
    return
  }
}
// Fall through to AI if no handler or handler returns null
this.sendRequest(...)
```

**Pros:**
- Instant response (no network latency)
- Predictable behavior
- Zero LLM cost for common operations

**Cons:**
- Requires predefined handlers
- Client/server VDOM can desync if not careful
- Less flexible than AI

#### Option B: Server-Side Handlers

```typescript
// In UIService or a new ActionService
const deterministicActions: Record<string, (html: string, data: any) => Patch[] | null> = {
  toggle: (html, data) => {
    const id = data.id
    const checkboxId = `todo-${id}-checkbox`
    // Parse current state from HTML
    const isChecked = html.includes(`id="${checkboxId}" checked`) ||
                      html.includes(`id="${checkboxId}"`) && html.includes('checked="checked"')
    return [{
      selector: `#${checkboxId}`,
      attr: { checked: isChecked ? null : "checked" }
    }]
  },

  delete: (html, data) => {
    return [{ selector: `#todo-${data.id}`, remove: true }]
  },
}

// In generateStream:
const handler = deterministicActions[request.action]
if (handler) {
  const patches = handler(currentHtml, request.actionData)
  if (patches) {
    // Apply to VDOM and return immediately
    yield* vdomService.applyPatches(sessionId, patches)
    return Stream.make(
      { type: "session", sessionId },
      ...patches.map(p => ({ type: "patch", patch: p })),
      { type: "done", html: yield* vdomService.getHtml(sessionId) }
    )
  }
}
// Fall through to AI
```

**Pros:**
- Server VDOM stays in sync
- Still works if client JS fails
- Can validate against actual DOM state

**Cons:**
- Still has network latency (but no LLM latency)
- Requires HTML parsing for state

#### Option C: Hybrid with AI Fallback

Best of both worlds:

1. **Client** tries programmatic handler first for known actions
2. **Client** applies patches locally for instant feedback
3. **Client** sends patches to server for VDOM sync
4. **Server** validates patches, applies to VDOM
5. **If validation fails**, server asks AI to fix/regenerate
6. **If action unknown**, falls through to AI generation

```
User clicks "toggle" checkbox
       ↓
[Client] Handler generates patch locally
       ↓
[Client] Applies patch to DOM (instant!)
       ↓
[Client] Sends patch to server: POST /sync {patches, sessionId}
       ↓
[Server] Applies to VDOM, validates
       ↓
[Server] Returns OK or corrective patches
```

### Which Actions Should Be Programmatic?

**Good candidates (deterministic):**
- `toggle` - checkbox state flip
- `delete` - remove element by ID
- `increment` / `decrement` - numeric value change
- `select` - radio/select value change (if just updating visual state)

**Bad candidates (need AI):**
- `add` - requires generating new HTML with proper structure, IDs, classes
- `generate` - user prompt, needs AI
- `update` - semantic changes ("make this red")
- Any action with complex side effects

### For `add` Specifically

The `add` action is tricky because it needs to generate new HTML. Options:

1. **Template-based**: Define templates in the original HTML
   ```html
   <template id="todo-template">
     <li id="todo-{id}">
       <input type="checkbox" id="todo-{id}-checkbox" data-action="toggle">
       <span>{title}</span>
     </li>
   </template>
   ```
   Handler interpolates values and appends.

2. **AI generates once, client reuses**: First `add` uses AI, subsequent ones clone+modify.

3. **Keep AI for add**: It's infrequent and needs creativity for structure.

### Next Steps

1. Start with `toggle` and `delete` as programmatic handlers
2. Keep `add` and `generate` as AI-powered
3. Add `/sync` endpoint for client→server VDOM synchronization
4. Measure latency improvement
