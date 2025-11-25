# VDOM Architecture for Generative UI

## Current Architecture (Implemented)

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

1. **Client** (pure vanilla JS): Sends requests with `data-action` + form data
2. **Server**: Maintains VDOM per session via happy-dom
3. **LLM**: Generates patches (for actions) or full HTML (for prompts/initial)
4. **Server**: Applies patches to VDOM, validates, retries on error
5. **Server**: Sends full HTML to client
6. **Client**: Renders via `innerHTML`

### Key Files

| File | Purpose |
|------|---------|
| [vdom.ts](apps/backend/src/services/vdom.ts) | VdomService - happy-dom per session, patch application |
| [generate.ts](apps/backend/src/services/generate.ts) | GenerateService - `generateFullHtml()` + `generatePatches()` |
| [request-handler.ts](apps/backend/src/services/request-handler.ts) | Routes requests, retry loop, fallback logic |
| [session.ts](apps/backend/src/services/session.ts) | SessionService - conversation history |
| [main.ts](apps/webpage/src/main.ts) | Client - vanilla JS, event delegation |

### Request Routing

| Condition | Action |
|-----------|--------|
| No VDOM (new session) | Generate full HTML |
| Has prompt | Generate full HTML |
| `action="generate"` | Generate full HTML |
| `action="reset"` | Clear VDOM, generate full HTML |
| Other actions | Generate patches → apply → retry on error → fallback to full HTML |

---

## Patch Format

LLM generates CSS selector-based patches:

```json
[
  { "selector": "#counter", "text": "42" },
  { "selector": "#status", "attr": { "class": "online" } },
  { "selector": "#todos", "append": "<li>New item</li>" },
  { "selector": "#item-3", "remove": true }
]
```

Supported operations:
- `text` - Set textContent
- `html` - Set innerHTML
- `attr` - Set attributes
- `append` - Insert at end
- `prepend` - Insert at start
- `remove` - Remove element

---

## Token Efficiency

| Scenario | Full HTML | Patches |
|----------|-----------|---------|
| Counter increment | ~2000 tokens | ~50 tokens |
| Add todo item | ~2000 tokens | ~100 tokens |
| Complex UI change | ~2000 tokens | ~200 tokens |

The win is **LLM generation time**, not network size.

---

## Problem: Message History Growth

### Current Issue

The `SessionService` stores conversation history:
```typescript
[
  { role: "user", content: "create a todo app", timestamp: ... },
  { role: "assistant", content: "[Generated UI: <div>...</div>...]", timestamp: ... },
  { role: "user", content: "[Action: add-todo] {\"todo\": \"Buy milk\"}", timestamp: ... },
  { role: "assistant", content: "[Applied 2 patches]", timestamp: ... },
  // ... grows indefinitely
]
```

Problems:
1. **Token bloat**: History sent to LLM on each request
2. **Irrelevant context**: Old actions don't help with new ones
3. **Cost**: More tokens = more cost + latency

### Key Insight

For generative UI, **the current HTML IS the state**. We don't need full history to understand "what the UI looks like" - the VDOM already has that. History is only useful for:
1. Understanding user intent evolution
2. Maintaining conversation context for prompts

---

## Proposed: Tiered History Compression

Based on [compaction research](compaction.md), implement a 3-tier history system:

### Tier 1: Current State (Always Present)
- **Current HTML** from VDOM (already doing this)
- **Last 2-4 interactions** verbatim

### Tier 2: Rolling Summary
- Compressed summary of older interactions
- Updated when tier 1 overflows
- Format: Structured, not prose

```typescript
type RollingSummary = {
  originalRequest: string           // "user requested a todo app"
  keyFeatures: string[]             // ["todo list", "add/delete", "counter"]
  recentChanges: string[]           // ["added 3 todos", "deleted todo-2"]
  userPreferences: string[]         // ["dark mode", "minimal design"]
}
```

### Tier 3: Discarded
- Very old interactions
- Only relevant parts extracted to rolling summary

### Implementation

```typescript
type SessionState = {
  // Tier 1: Recent (verbatim)
  recentHistory: ConversationMessage[]  // Last N messages

  // Tier 2: Compressed
  summary: RollingSummary

  // VDOM state (current truth)
  vdom: Window
}

const compactHistory = (session: SessionState) =>
  Effect.gen(function* () {
    if (session.recentHistory.length <= MAX_RECENT) return

    // Extract key info from oldest messages
    const toCompress = session.recentHistory.slice(0, -MAX_RECENT)

    // Use fast model to extract structured summary
    const extracted = yield* extractKeyInfo(toCompress)

    // Merge into rolling summary
    session.summary = mergeSummary(session.summary, extracted)

    // Keep only recent
    session.recentHistory = session.recentHistory.slice(-MAX_RECENT)
  })
```

### Prompt Construction

```typescript
const buildContext = (session: SessionState) => `
CURRENT UI STATE:
${session.vdom.document.body.innerHTML}

CONTEXT SUMMARY:
- Original request: ${session.summary.originalRequest}
- Key features: ${session.summary.keyFeatures.join(", ")}
- Recent changes: ${session.summary.recentChanges.slice(-3).join(", ")}

RECENT INTERACTIONS:
${session.recentHistory.map(m => `${m.role}: ${m.content}`).join("\n")}
`
```

### Token Budget

| Component | Max Tokens |
|-----------|------------|
| Current HTML | ~1500 |
| Summary | ~200 |
| Recent history (4 msgs) | ~400 |
| System prompt | ~500 |
| **Total context** | ~2600 |
| LLM response | ~500 |
| **Total per request** | ~3100 |

### Compression Triggers

Compact when:
1. `recentHistory.length > MAX_RECENT` (e.g., 6)
2. Total tokens exceed budget
3. Time-based (every N minutes for long sessions)

### Fast Model for Compression

Use a cheaper/faster model for summary extraction:
```typescript
const extractKeyInfo = (messages: ConversationMessage[]) =>
  Effect.gen(function* () {
    const fastLlm = yield* FastLlmService  // e.g., Haiku, Flash-Lite

    return yield* fastLlm.generate({
      prompt: `Extract key info from these interactions as JSON:
        - originalIntent: what did user originally want?
        - features: what UI features were created?
        - changes: what significant changes were made?

        Messages:
        ${messages.map(m => `${m.role}: ${m.content}`).join("\n")}`,
      responseFormat: "json"
    })
  })
```

---

## Alternative: No History for Actions

Simpler approach: **Don't send history for patch generation at all**.

Rationale:
- Current HTML already shows complete UI state
- Action + actionData tells LLM what to do
- No history needed to "increment counter" or "add todo"

```typescript
// For patches, only send:
const patchPrompt = `
CURRENT HTML:
${currentHtml}

ACTION: ${action}
DATA: ${JSON.stringify(actionData)}

Generate patches to update the UI.
`
// No history!
```

Only send history for:
- Full HTML generation (prompts, generate action)
- Complex actions that need context

This could reduce token usage by 50-80% for most interactions.

---

## Implementation Priority

1. **Quick win**: Remove history from patch generation prompts
2. **Medium effort**: Implement rolling summary with fast model
3. **Future**: Semantic retrieval for very long sessions

---

## Next Steps

1. ✅ VDOM architecture implemented
2. ✅ Patch generation working
3. ✅ Escape hatch (reset button) added
4. 🔲 Implement history compaction
5. 🔲 Measure token reduction
6. 🔲 Add streaming for perceived speed
7. 🔲 Session cleanup/garbage collection
