# Memory System v2: Optimizing for Cache Efficiency

## Current Problem

The mini-RAG pipeline breaks prompt caching because:

1. **No chronological ordering** - Changes have no sequence numbers, so the AI can't tell which came first
2. **History changes every request** - `[RECENT CHANGES]` updates on every interaction, breaking the cache prefix
3. **Semantic search is volatile** - `[RELEVANT PAST CONTEXT]` varies per query, further destabilizing the prefix
4. **Everything is in one user message** - The entire context block changes together

### Current Message Structure

```
[SYSTEM] Static instructions                    ← Cached ✓
[USER]
  HTML: ...                                     ← Changes with patches
  [RECENT CHANGES] 1-5                          ← Changes EVERY request ✗
  [RELEVANT PAST CONTEXT]                       ← Varies per query ✗
  [NOW] Action/Prompt                           ← Always different
```

**Result**: Only the system prompt gets cached. Everything after breaks on every request.

---

## Design Goals

1. **Maximize cacheable prefix** - More stable content at the start
2. **Clear chronology** - Sequence numbers for all changes
3. **Semantic richness** - Don't lose relevant context
4. **Compact representation** - Minimize token usage
5. **Graceful degradation** - Works even if cache misses

---

## Proposed Solutions

### Option A: Tiered History with Update Frequencies

Split history into tiers that update at different rates:

```
[SYSTEM] Static instructions                    ← Always cached

[USER]
  [SESSION SUMMARY]                             ← Updates every ~20-30 turns
  "Session #abc123 started with a prompt to create a landing page.
   User iterated on brutalist styling with colorful borders.
   Built a counter dashboard with 6 nodes. 47 total interactions."

  [MILESTONES] #1, #12, #24, #36                ← Updates every ~10 turns
  #1: Created landing page with hero section
  #12: Switched to brutalist style with thick borders
  #24: Added counter dashboard with 3 nodes
  #36: Expanded to 6 counter nodes

  [RECENT] #45-#47                              ← Changes every request (at END)
  #45: Incremented Node Alpha count to 5
  #46: Decremented Node Beta count to 4
  #47: [Current request]

  [HTML]
  <div>...</div>

  [NOW] Action: increment Data: {"id":"5"}
```

**Cache behavior:**
- `[SESSION SUMMARY]` + `[MILESTONES]`: Stable for 10-30 requests → HIGH cache hits
- `[RECENT]` + `[NOW]`: Volatile but at END → Only cache miss is the tail

**Implementation:**
```typescript
type MemoryEntry = {
  sequenceNumber: number;  // Global counter per session
  // ... existing fields
};

// In StoreService
const getSessionSummary = (sessionId: string) => ...;  // Regenerate every ~25 turns
const getMilestones = (sessionId: string) => ...;      // Every ~10 turns
const getRecentChanges = (sessionId: string, since: number) => ...; // Last 3-5
```

**Pros:**
- Simple to implement
- Clear cache boundaries
- Chronology is explicit

**Cons:**
- Summary regeneration has latency (but happens rarely)
- Fixed thresholds may not fit all session patterns

---

### Option B: Epoch-Based Snapshots

Inspired by event sourcing - take snapshots at regular intervals:

```
[SYSTEM] Static instructions

[USER]
  [EPOCH 2] (changes #26-#50, summarized at #50)        ← Cached for 25 requests
  "Counter dashboard with 6 nodes. User has been incrementing/decrementing
   counters. Current totals: Alpha=5, Beta=3, Gamma=1, Delta=0, Epsilon=2, Zeta=5.
   Total sum: 16. No structural changes since epoch start."

  [SINCE EPOCH] #51-#53                                  ← Volatile tail
  #51: +1 to Node Alpha (now 6)
  #52: -1 to Node Beta (now 2)
  #53: [Current]

  [HTML]
  ...

  [NOW] ...
```

**Epoch rules:**
- New epoch every 25 changes OR when major structural change happens
- Epoch summary is cached until next epoch
- Only changes since epoch are listed individually

**Pros:**
- Very stable prefix (entire epoch cached)
- Natural compression of repetitive actions
- Epoch summaries can be richer (include state snapshots)

**Cons:**
- Need to detect "major structural changes"
- Epoch generation adds latency at boundaries

---

### Option C: Action-Type Aware Compression

Different actions need different levels of history:

| Action Type | History Needed |
|-------------|---------------|
| increment/decrement | Almost none - just current values |
| add-item | Recent structure context |
| delete-item | Recent structure context |
| style change | Full style history |
| prompt (new UI) | Full context |

```typescript
const buildContext = (action: string, prompt?: string) => {
  if (isSimpleAction(action)) {
    // No history needed - just HTML state
    return { historyParts: [], html: currentHtml };
  }

  if (isStructuralAction(action)) {
    // Light history - recent 3 changes
    return { historyParts: getRecent(3), html: currentHtml };
  }

  if (prompt) {
    // Full context - semantic search + recent
    return { historyParts: [...semantic, ...recent], html: currentHtml };
  }
};
```

**Message for simple action (e.g., increment):**
```
[SYSTEM] Static

[USER]
  [HTML]
  ...

  [NOW] Action: increment Data: {"id":"5"}
```

No history at all! Maximum caching, minimal tokens.

**Pros:**
- Optimal token usage per request type
- Simple actions are VERY fast
- Cache hit rate is action-dependent (simple = 100%)

**Cons:**
- Loses context for edge cases
- AI might make mistakes without history

---

### Option D: Sliding Window with Compressed Tail

Keep a fixed window of detailed changes, compress everything older:

```
[SYSTEM] Static

[USER]
  [HISTORY DIGEST] (changes #1-#44, compressed)         ← Updates every ~10 turns
  "Session: counter dashboard. Style: brutalist, monochrome.
   Key events: landing page (#1) → brutalist restyle (#12) →
   dashboard with counters (#24) → expanded to 6 nodes (#36).
   44 total changes, mostly counter increments."

  [WINDOW] #45-#49 (last 5 with full detail)           ← Slides every request
  #45: Incremented Alpha (1→2), sum 8→9
  #46: Incremented Beta (4→5), sum 9→10
  #47: Decremented Gamma (2→1), sum 10→9
  #48: Incremented Zeta (4→5), sum 9→10
  #49: [Current]

  [HTML] ...
  [NOW] ...
```

**The key insight:** The DIGEST only needs to update when:
1. We run out of window space (every ~5-10 requests)
2. A "significant" change happens that should be in the digest

**Pros:**
- Predictable memory usage
- Clear chronology
- Digest provides semantic richness

**Cons:**
- Digest update frequency still relatively high
- Window size is a tuning parameter

---

### Option E: Multi-Message Caching Trick

Force a longer cacheable prefix by splitting into multiple messages:

```
[SYSTEM] Static instructions                            ← Cached

[USER] Session context (stable)                         ← Cached with system!
  [SESSION SUMMARY] Built counter dashboard...
  [MILESTONES] #1, #12, #24, #36...

[ASSISTANT] Ready to process your request.              ← Forces cache break

[USER] Current request (volatile)                       ← Not cached, but small
  [RECENT] #45-#47
  [HTML] ...
  [NOW] Action: increment
```

The `[ASSISTANT]` message forces the API to cache everything before it as a unit. The second `[USER]` message is small and volatile.

**Groq/Anthropic caching behavior:**
- Caches longest matching prefix
- The `[ASSISTANT]` response creates a "checkpoint"
- Second user message only invalidates from that point

**Pros:**
- Maximum cache hit rate
- Clean separation of concerns
- Works with current API behavior

**Cons:**
- Extra round-trip if using real multi-turn
- Slightly hacky (relies on cache implementation)
- Need to verify this works with streaming

---

### Option F: Hybrid - Recommended Approach

Combine the best ideas:

1. **Sequence numbers** on all changes (from Option A)
2. **Tiered updates** with SESSION_SUMMARY and MILESTONES (from Option A)
3. **Action-aware context** - skip history for simple actions (from Option C)
4. **Semantic search only for prompts** - don't run it for actions

```
┌─────────────────────────────────────────────────────────────────┐
│ Request Type: PROMPT (user types something)                     │
├─────────────────────────────────────────────────────────────────┤
│ [SYSTEM] Static                                                 │
│ [USER]                                                          │
│   [SESSION] Created counter dashboard, 6 nodes, brutalist...   │  ← Cached
│   [MILESTONES] #1 landing, #12 style, #24 dashboard...         │  ← Cached
│   [RELEVANT] Semantic search results for this prompt           │  ← Varies
│   [HTML] Current state                                          │
│   [NOW] Prompt: "make the counters larger"                     │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Request Type: SIMPLE ACTION (increment, decrement, toggle)      │
├─────────────────────────────────────────────────────────────────┤
│ [SYSTEM] Static                                                 │
│ [USER]                                                          │
│   [HTML] Current state                                          │
│   [NOW] Action: increment Data: {"id":"5"}                     │
│                                                                 │
│ NO HISTORY! The HTML contains all needed state.                │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Request Type: STRUCTURAL ACTION (add, delete, reset)            │
├─────────────────────────────────────────────────────────────────┤
│ [SYSTEM] Static                                                 │
│ [USER]                                                          │
│   [SESSION] Brief summary                                       │  ← Cached
│   [RECENT] Last 3 changes                                       │  ← Small
│   [HTML] Current state                                          │
│   [NOW] Action: delete Data: {"id":"3"}                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 1: Add Sequence Numbers

```typescript
// In sessions table
nextSequenceNumber: integer("next_sequence_number").notNull().default(1),

// In memory_entries table
sequenceNumber: integer("sequence_number").notNull(),

// When saving memory
const seq = yield* store.incrementAndGetSequence(sessionId);
yield* store.insertMemoryEntry({ ...entry, sequenceNumber: seq });
```

### Phase 2: Tiered Summary Generation

```typescript
// New fields in sessions table
sessionSummary: text("session_summary"),
sessionSummaryAsOf: integer("session_summary_as_of"),  // Sequence # when generated
milestones: text("milestones"),  // JSON array of milestone entries
milestonesAsOf: integer("milestones_as_of"),

// Update logic
const SUMMARY_INTERVAL = 25;
const MILESTONE_INTERVAL = 10;

const maybeUpdateSummary = (sessionId: string, currentSeq: number) =>
  Effect.gen(function* () {
    const session = yield* store.getSession(sessionId);
    if (currentSeq - (session.sessionSummaryAsOf ?? 0) >= SUMMARY_INTERVAL) {
      const newSummary = yield* generateSessionSummary(sessionId);
      yield* store.updateSession(sessionId, {
        sessionSummary: newSummary,
        sessionSummaryAsOf: currentSeq,
      });
    }
  });
```

### Phase 3: Action-Aware Context Building

```typescript
const SIMPLE_ACTIONS = new Set(["increment", "decrement", "toggle"]);
const STRUCTURAL_ACTIONS = new Set(["add", "delete", "reset", "add-counter"]);

const buildContextForRequest = (options: UnifiedGenerateOptions) =>
  Effect.gen(function* () {
    const { action, prompt, sessionId, currentHtml } = options;

    // Prompts get full context
    if (prompt) {
      const [session, milestones, semantic, recent] = yield* Effect.all([
        store.getSessionSummary(sessionId),
        store.getMilestones(sessionId),
        memory.search(sessionId, prompt, 5),
        memory.getRecent(sessionId, 3),
      ]);
      return { session, milestones, semantic, recent, html: currentHtml };
    }

    // Simple actions: HTML only
    if (SIMPLE_ACTIONS.has(action!)) {
      return { html: currentHtml };
    }

    // Structural actions: brief context
    const [session, recent] = yield* Effect.all([
      store.getSessionSummary(sessionId),
      memory.getRecent(sessionId, 3),
    ]);
    return { session, recent, html: currentHtml };
  });
```

### Phase 4: Format Context for Caching

```typescript
const formatContext = (ctx: Context): string => {
  const parts: string[] = [];

  // Stable prefix (cacheable)
  if (ctx.session) {
    parts.push(`[SESSION] ${ctx.session}`);
  }
  if (ctx.milestones?.length) {
    parts.push(`[MILESTONES]\n${ctx.milestones.map(m =>
      `#${m.seq}: ${m.summary}`
    ).join('\n')}`);
  }

  // Semi-stable (may vary for prompts)
  if (ctx.semantic?.length) {
    parts.push(`[RELEVANT]\n${ctx.semantic.map(s =>
      `- ${s.promptSummary ?? s.actionSummary}: ${s.changeSummary}`
    ).join('\n')}`);
  }

  // Volatile (always at end)
  if (ctx.recent?.length) {
    parts.push(`[RECENT]\n${ctx.recent.map(r =>
      `#${r.sequenceNumber}: ${r.changeSummary}`
    ).join('\n')}`);
  }

  parts.push(`[HTML]\n${ctx.html}`);

  return parts.join('\n\n');
};
```

---

## Expected Improvements

| Scenario | Current Cache Rate | Expected Cache Rate |
|----------|-------------------|---------------------|
| Simple action (increment) | ~30% (system only) | ~95% (system + HTML prefix) |
| Structural action | ~30% | ~60% (session + milestones) |
| Prompt (new request) | ~30% | ~50% (session + milestones) |
| Repeated prompts | ~30% | ~70% (+ semantic results) |

---

## Metrics to Track

1. **Cache hit rate** - Already tracking, should improve
2. **Tokens per request** - Should decrease for simple actions
3. **Latency** - Should decrease due to caching
4. **Summary generation frequency** - Track when summaries regenerate
5. **Context size by action type** - Verify simple actions are smaller

---

## Open Questions

1. **Should we skip memory entirely for simple actions?**
   - Pro: Faster, cheaper, simpler
   - Con: Loses the record for later semantic search
   - Compromise: Still save to memory, just don't fetch context

2. **How to detect "significant" changes for milestones?**
   - Heuristic: Full HTML regeneration = milestone
   - Heuristic: >5 patches at once = milestone
   - LLM-based: Ask the summarizer if this is significant

3. **Should semantic search results be cached?**
   - If user keeps asking similar questions, results would be similar
   - Could cache embeddings and reuse for identical queries

4. **Multi-message vs single-message?**
   - Need to verify Groq's caching behavior with multi-turn
   - May not work with streaming

---

## References

- [Groq Prompt Caching](https://console.groq.com/docs/prompt-caching) - 50% off cached tokens
- [Anthropic Prompt Caching](https://docs.anthropic.com/claude/docs/prompt-caching) - Different mechanics
- Original MEMORY.md for context on current implementation
