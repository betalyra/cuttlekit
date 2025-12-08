# Message History & Caching Strategy

## Analysis

### User Interaction Patterns

The typical user journey follows two distinct phases:

1. **Creation Phase**: User describes what they want via prompts
   - "Create a todo list with checkboxes"
   - "Add a delete button to each item"
   - "Make the completed items gray"

2. **Interaction Phase**: User operates the created UI via actions
   - toggle checkbox → action
   - delete item → action
   - add new item → action

**Key insight**: Once a UI is created, users predominantly trigger actions. Prompts become rare refinement requests.

### Caching Implications

Groq's prompt caching uses prefix matching - content at the start of the message array is cached and reused across requests.

| Content Type | Change Frequency | Cache Value |
|--------------|------------------|-------------|
| System prompt | Never | ★★★★★ (always cached) |
| UI creation prompts | Rare after creation | ★★★★ (high cache hit) |
| Recent actions | Every request | ★ (rarely cached) |
| Current request | Every request | ☆ (never cached) |

### The Problem

If we store prompts and actions together chronologically:
```
[system] [prompt1] [action1] [action2] [prompt2] [action3] [action4] [current]
```

The cache breaks at every action insertion, wasting the cacheability of prompts.

## Proposal: Segmented History

### Message Structure

Organize messages by category, not chronology:

```
[system prompt]           ← Static, always cached
[prompt history]          ← Semi-static, high cache hits
[action context]          ← Dynamic summary, compact
[current request]         ← Always fresh
```

### Storage Schema

Store prompts and actions separately:

```typescript
const SessionDataSchema = Schema.Struct({
  // Prompt history - stored verbatim for RAG potential
  prompts: Schema.Array(Schema.Struct({
    content: Schema.String,
    timestamp: Schema.Number,
    embedding: Schema.optional(Schema.Array(Schema.Number)),
  })),

  // Action history - stored for context, compacted aggressively
  actions: Schema.Array(Schema.Struct({
    action: Schema.String,
    data: Schema.optional(Schema.Unknown),
    timestamp: Schema.Number,
  })),

  // Compacted summaries
  promptSummary: Schema.optional(Schema.String),
  actionSummary: Schema.optional(Schema.String),

  // Current UI state hash (for cache invalidation)
  uiStateHash: Schema.optional(Schema.String),
});
```

### Context Assembly

For each request, assemble context based on request type:

**For action requests:**
```
[system prompt]
[last 2-3 prompts verbatim]     ← Cached prefix
[action summary: "User has toggled items, deleted 2 items"]
[current action + HTML]
```

**For prompt requests:**
```
[system prompt]
[relevant past prompts via RAG]  ← Retrieved by similarity
[brief action summary]
[current prompt + HTML]
```

### Compaction Strategy

**Prompts**: Keep last N verbatim, summarize older ones
- Verbatim: "Create a todo list" → keeps full intent
- Summary: "User previously created a todo list, added priority feature"

**Actions**: Aggregate into patterns
- Raw: toggle(1), toggle(2), toggle(1), delete(3)
- Compacted: "User toggled items 1,2 and deleted item 3"

### Implementation Phases

#### Phase 1: Separate Storage (Now)
- Store prompts and actions in separate arrays
- Return last 3 of each for context
- No compaction yet

#### Phase 2: Smart Assembly
- Order messages for optimal caching: system → prompts → actions → current
- Add action aggregation (dedupe repeated toggles)

#### Phase 3: Compaction
- Summarize prompts older than N messages
- Aggregate action patterns into summaries
- Trigger compaction when token estimate exceeds threshold

#### Phase 4: RAG Integration
- Generate embeddings for prompts on storage
- On new prompt: retrieve top-k similar past prompts
- Include retrieved prompts in context for continuity

### Token Budget

Target: Keep history under 500 tokens to maximize cache efficiency.

| Segment | Token Budget | Strategy |
|---------|--------------|----------|
| System prompt | ~800 | Fixed, always cached |
| Prompt history | ~300 | Last 2-3 or RAG top-k |
| Action context | ~100 | Aggregated summary |
| Current HTML | Variable | Full HTML required |
| Current request | ~50 | Action or prompt |

### Cache Optimization Rules

1. **Prompt-first ordering**: Always place prompts before actions in message array
2. **Stable prompt prefix**: Don't interleave actions with prompts
3. **Action summaries**: Convert action history to single summary message
4. **Lazy compaction**: Only compact when approaching token budget

### Example Message Arrays

**Initial creation (prompt):**
```json
[
  {"role": "system", "content": "...static prompt..."},
  {"role": "user", "content": "Create a todo list with checkboxes"}
]
```

**After several interactions:**
```json
[
  {"role": "system", "content": "...static prompt..."},
  {"role": "user", "content": "Create a todo list"},
  {"role": "user", "content": "Add priority colors"},
  {"role": "user", "content": "[Actions: toggled 5 items, deleted 2, added 3]"},
  {"role": "user", "content": "CURRENT HTML:...\nACTION: toggle..."}
]
```

The first 3 messages form a stable prefix → high cache hit rate.

## Trade-offs

| Approach | Pros | Cons |
|----------|------|------|
| Chronological | Simple, preserves order | Poor caching, prompt cache breaks on every action |
| Segmented | Optimal caching, compact | Loses exact chronology, more complex |
| RAG-only | Retrieves relevant context | Requires embeddings, latency |

**Recommendation**: Start with segmented storage (Phase 1-2), add compaction and RAG as token usage grows.

## Next Steps

1. Update `StorageService` schema to separate prompts and actions
2. Modify `streamUnified` to assemble messages in cache-optimal order
3. Add action aggregation logic
4. Monitor cache hit rates via Groq usage stats
