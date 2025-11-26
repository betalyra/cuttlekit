# Generative UI Architecture

## Overview

```
┌─────────────┐     ┌─────────────────────────┐     ┌─────────────┐
│   Client    │────▶│        Server           │────▶│     LLM     │
│  (vanilla)  │     │                         │     │             │
│             │     │  happy-dom (VDOM)       │     │  Patches or │
│  Render     │◀────│  + patch application    │◀────│  Full HTML  │
│  Full HTML  │     │  + retry loop           │     │             │
└─────────────┘     └─────────────────────────┘     └─────────────┘
```

### Flow

1. **Client** (vanilla JS): Sends requests with `data-action` + form data
2. **Server**: Maintains VDOM per session via happy-dom
3. **LLM**: Generates patches (for actions) or full HTML (for prompts/initial)
4. **Server**: Applies patches to VDOM, validates, retries on error
5. **Server**: Sends full HTML to client
6. **Client**: Renders via `innerHTML`

---

## Key Files

| File | Purpose |
|------|---------|
| [vdom.ts](apps/backend/src/services/vdom.ts) | VdomService - happy-dom per session, patch application |
| [generate.ts](apps/backend/src/services/generate.ts) | GenerateService - `generateFullHtml()` + `generatePatches()` |
| [request-handler.ts](apps/backend/src/services/request-handler.ts) | Routes requests, retry loop, fallback logic |
| [session.ts](apps/backend/src/services/session.ts) | SessionService - conversation history (recorded, not sent to LLM) |
| [main.ts](apps/webpage/src/main.ts) | Client - vanilla JS, event delegation |

---

## Request Routing

| Condition | Action |
|-----------|--------|
| No VDOM (new session) | Generate full HTML |
| Has prompt | Generate full HTML (with current HTML for style preservation) |
| `action="generate"` | Generate full HTML |
| `action="reset"` | Clear VDOM, generate fresh HTML |
| Other actions | Generate patches → apply → retry on error → fallback to full HTML |

---

## Patch Format

LLM generates CSS selector-based patches (must use ID selectors):

```json
[
  { "selector": "#counter-value", "text": "42" },
  { "selector": "#status", "attr": { "class": "online" } },
  { "selector": "#todo-1-checkbox", "attr": { "checked": "checked" } },
  { "selector": "#todo-2-checkbox", "attr": { "checked": null } },
  { "selector": "#todo-list", "append": "<li id=\"todo-4\">New item</li>" },
  { "selector": "#todo-3", "remove": true }
]
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

## HTML Generation Requirements

### Unique IDs (Critical)

All interactive elements must have unique IDs for the patch system:

```html
<input type="checkbox" id="todo-1-checkbox" data-action="toggle" data-action-data="{&quot;id&quot;:&quot;1&quot;}">
<li id="todo-1">...</li>
<button id="delete-1" data-action="delete" data-action-data="{&quot;id&quot;:&quot;1&quot;}">Delete</button>
```

### Escape Hatch (Required)

Every generated UI must include one of:
1. Prompt input (`id="prompt"`) + Generate button (`data-action="generate"`)
2. Reset button (`data-action="reset"`)

### Style Preservation

When user prompts modify existing UI, the current HTML is passed to the LLM with instructions to preserve existing design, layout, and style.

---

## Token Efficiency

| Scenario | Full HTML | Patches |
|----------|-----------|---------|
| Counter increment | ~2000 tokens | ~50 tokens |
| Add todo item | ~2000 tokens | ~100 tokens |
| Toggle checkbox | ~2000 tokens | ~30 tokens |

The win is **LLM generation time**, not network size.

---

## History Management

### Current Implementation (Quick Win)

- History is **recorded** in SessionService for future use
- History is **NOT sent** to LLM for patch generation
- Current HTML serves as the complete state
- Action + actionData tells LLM what to do

### Rationale

For generative UI, **the current HTML IS the state**:
- No need for history to understand UI state
- Action data contains all necessary context
- Reduces token usage by 50-80%

### Future: Rolling Summary

Planned tiered compression system:

```typescript
type RollingSummary = {
  originalRequest: string      // "user requested a todo app"
  keyFeatures: string[]        // ["todo list", "add/delete", "counter"]
  recentChanges: string[]      // ["added 3 todos", "deleted todo-2"]
  userPreferences: string[]    // ["dark mode", "minimal design"]
}
```

---

## Retry & Fallback

1. Generate patches for action
2. Apply patches to VDOM
3. If errors: retry up to 2 times with error feedback
4. If still failing: fallback to full HTML generation

Error feedback is included in retry prompts:
```
YOUR PREVIOUS PATCHES FAILED:
Element not found: #nonexistent

Please generate corrected patches.
```

---

## Implementation Status

### Completed

- [x] VDOM architecture with happy-dom
- [x] Patch generation with ID-based selectors
- [x] Retry loop with error feedback
- [x] Fallback to full HTML
- [x] Escape hatch (reset/generate buttons)
- [x] Style preservation for prompts
- [x] History recording (not sent to LLM)
- [x] Unique ID requirements in prompts
- [x] HTML entity encoding for JSON in attributes
- [x] Boolean attribute handling (null to remove)

### Pending

- [ ] Rolling summary for history compaction
- [ ] Streaming for perceived speed
- [ ] Session cleanup/garbage collection
- [ ] Token usage metrics
