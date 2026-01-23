# Generative UI: Development Approach

A chronological journey building an AI-powered generative UI system.

---

## Step 1: Choosing the Stack

**Goal:** Find a frontend framework that AI can control by generating HTML.

**Why Alpine.js over React?**
- React requires generating JavaScript/JSX, component trees, state management
- Alpine.js works with plain HTML + declarative attributes
- AI can generate a complete interactive page as a single HTML string
- No build step needed for generated content - just render and it works

**Backend:** Effect-TS for type-safe services and dependency injection.

---

## Step 2: First AI-Generated Pages

**Goal:** AI generates complete HTML pages from natural language.

- User types "create a login form"
- AI returns raw HTML with Tailwind classes
- Frontend renders it via Alpine's `x-html`

**Problem:** AI sometimes wrapped output in markdown code blocks.
**Solution:** Stronger system prompt - "raw HTML only, never use code fences."

---

## Step 3: Generated UI Isn't Interactive

**Problem:** Buttons don't click. Forms don't submit. Nothing works.

**Root Cause:** Alpine.js doesn't process directives (`@click`, `x-model`) inside `x-html` for security reasons - this prevents XSS attacks.

**Implication:** Our core assumption was broken. We can generate HTML, but it can't have any Alpine interactivity.

---

## Step 4: Adding Conversation Memory

**Goal:** AI should remember what it built so users can iterate.

- Store conversation history per session
- "Make the button red" works because AI sees previous HTML
- Enables back-and-forth design refinement

---

## Step 5: Solving Interactivity

**Problem:** How do we make generated UIs interactive without client-side JavaScript?

**Key Insight:** Move ALL interaction handling to the server. This is the LiveView/HTMX pattern.

**Why this approach?**
- No client-side code in generated HTML = no security concerns
- AI only needs to generate declarative markup
- Server has full context (session, state, history)
- Single mental model: every interaction regenerates the page

---

## Step 6: The Action System

**How it works:**
1. AI generates buttons with `data-action="increment"` instead of `@click`
2. User clicks button
3. Frontend intercepts click, collects all form values, sends to server
4. Server tells AI: "user clicked increment, here's the current HTML"
5. AI regenerates complete page with updated state
6. Frontend replaces content

**Result:** Fully interactive UIs with zero client-side logic in generated code.

---

## Step 7: Quality of Life - Enter Key

**Problem:** Users expect Enter to submit, but it doesn't work.

**Solution:** Frontend automatically finds the nearest action button when Enter is pressed in an input field.

---

## Step 8: State Persistence Bug

**Problem:** Building a counter works, but clicking +1 resets everything to the welcome screen.

**Root Cause:** When there's an action but no text prompt, the system prompt fell through to "generate initial welcome page."

**Fix:** Explicit instruction to AI: "When handling an action, look at your previous HTML and update it. Never revert to the welcome page."

---

## Step 9: Token Usage Grows Fast

**Problem:** Every request sends full conversation history including complete HTML pages. Gets expensive quickly.

**Explored options:**
1. **Extract state to JSON** - AI embeds `<!-- STATE: {...} -->`, backend parses it. Concern: brittle, regex parsing, AI might forget format.
2. **Prompt caching** - Groq caches repeated prefixes at 50% discount. Simpler, no code changes, but still sends full content.

**Status:** Open decision point.

---

## Step 10: VDOM for Efficient Updates

**Problem:** Full page replacement on every action feels heavy. Could we send just the changes?

**Exploration:** Built a proof-of-concept showing:
- Represent UI as serializable virtual DOM
- Diff old vs new, generate patches
- Send patches over the wire instead of full HTML
- Client applies minimal DOM updates

**Potential:** Smaller payloads, smoother updates, better perceived performance.

**Status:** Proof of concept only, not integrated.

---

## Step 11: Server-Side VDOM Integration

**Problem:** Full page regeneration on every click is slow and expensive. AI has to regenerate entire HTML even for small changes like incrementing a counter.

**Solution:** Server-side DOM with patch-based updates.

**Key changes:**
- Server maintains a DOM per session using happy-dom (headless browser environment)
- AI can generate either full HTML (for new UIs) or small CSS-selector patches (for updates)
- Patches are simpler: `{ selector: "#counter", text: "6" }` instead of full HTML
- If patches fail (selector not found), retry with error context, then fall back to full regeneration

**Resilience:**
- Frontend sends current HTML with each request
- If server restarts, it recovers state from client
- No session loss on server restart

**Dropped Alpine.js:**
- Frontend is now vanilla TypeScript
- Simpler, no framework dependency
- Same event delegation pattern (data-action clicks)

**Result:** Counter increments now use ~50 tokens (patch) instead of ~500 tokens (full HTML). Faster responses.

---

## Step 12: Drop Conversation History

**Problem:** Still sending full conversation history to LLM on every request. Tokens add up, context window fills.

**Insight:** The current HTML already contains all state. Why send history?

**Solution:**
- History is still recorded (for potential future features like rolling summary)
- But NOT sent to LLM - only the current HTML is sent
- Current HTML IS the state - AI can see exactly what the user sees

**Result:** Dramatically reduced token usage per request. Simpler mental model.

---

## Step 13: Prompt Caching Optimization

**Problem:** System prompts were rebuilt dynamically on every request, mixing static instructions with dynamic content. This breaks Groq's automatic prompt caching (which requires exact prefix matching).

**Solution:** Separate static and dynamic content into system vs user messages:
- Static system prompt: All instructions, rules, examples (cacheable)
- Dynamic user message: Current HTML, action, actionData (varies per request)

**Structure:**
```
[SYSTEM] Static instructions, rules, examples  ← cached after first request
[USER]   Current HTML + action context         ← dynamic per request
```

**Result:** Noticeably faster responses. Groq caches the system prompt prefix and only processes the dynamic user content on subsequent requests.

---

## Step 14: Streaming Patches via SSE

**Problem:** Even with patches, users wait for AI to generate all patches before seeing any update. Perceived latency is still high.

**Solution:** Stream patches individually as they're generated using Server-Sent Events (SSE).

**Key changes:**

1. **GenerateService:** Switched from `generateText` to `streamObject` with Zod schema validation
   - Uses `partialObjectStream` to get patches as they're parsed
   - Emits each complete patch immediately (doesn't wait for full array)

2. **UIService:** New `generateStream` method returns `Stream<StreamEvent>`
   - Event types: `session`, `patch`, `html`, `done`
   - Each patch is applied to server VDOM as it arrives
   - Maintains consistency between streamed patches and server state

3. **SSE Endpoint:** New `/generate/stream` POST endpoint
   - Returns `text/event-stream` content type
   - Each event is `event: message\ndata: {...}\n\n`
   - Ends with `event: close\n\n`

4. **Frontend:** Raw fetch with ReadableStream parsing
   - Buffers partial SSE frames, parses complete events
   - Applies each patch to DOM immediately via `applyPatch`
   - Falls back to regular request for initial loads and prompts

**Why raw fetch instead of EventSource?**
- EventSource only supports GET requests
- We need POST to send the request payload (action, sessionId, currentHtml)

**Result:** UI updates appear progressively as AI generates them. Counter increments feel instant because the first patch (the only patch) arrives and applies within ~200ms.

---

## Step 15: On-Demand Icons with Iconify

**Problem:** AI-generated UIs lack visual polish. Icons would help, but bundling icon libraries bloats the frontend.

**Solution:** Iconify web component with on-demand loading from CDN.

**How it works:**
1. Include single script: `<script src="https://code.iconify.design/iconify-icon/2.3.0/iconify-icon.min.js"></script>`
2. AI generates icons as: `<iconify-icon icon="mdi:home"></iconify-icon>`
3. Web component fetches icon SVG from Iconify API on first render
4. Icons are cached in localStorage for subsequent loads

**System prompt addition:**
```
ICONS:
Use Iconify web component for icons (loaded on-demand):
- <iconify-icon icon="mdi:home"></iconify-icon>
- <iconify-icon icon="lucide:search" width="20"></iconify-icon>

Popular icon sets: mdi, lucide, tabler, ph
Icons inherit text color via currentColor.
```

**Trade-offs:**
- ~50KB one-time cost for web component script
- ~50-100ms latency on first load of each unique icon
- Requires internet (icons cached after first fetch)
- Access to 200,000+ icons without bundling any

**Result:** AI can now generate UIs with contextual icons. Navigation menus, action buttons, and status indicators look polished without any bundle size impact per icon.

---

## Step 16: On-Demand Fonts with Fontsource

**Problem:** AI-generated UIs use system fonts only. Custom fonts would improve aesthetics, but bundling fonts bloats the frontend.

**Solution:** Dynamic font loading using Fontsource API for metadata and jsDelivr CDN for font files.

**How it works:**
1. AI generates HTML with `font-family: 'Space Grotesk', sans-serif`
2. Frontend parses HTML string for font-family declarations (regex, not DOM traversal)
3. For each custom font, fetch metadata from Fontsource API (cached)
4. Load font via FontFace API from jsDelivr CDN
5. Browser re-renders with loaded font

**Key implementation details:**
- `extractFontsFromHTML(html)` - Fast regex parsing, no DOM traversal needed
- Uses `defSubset` from API - works with any language (Latin, CJK, Arabic, etc.)
- Prefers variable fonts when available (single file for all weights)
- Graceful fallback - unknown fonts show system font

**Font loading for patches:**
- `extractPatchContent(patch)` extracts content from html/append/prepend/style patches
- `applyPatch()` calls `loadFontsFromHTML()` for any patch with font content

**Trade-offs:**
- Brief FOUT (~50-100ms) while font loads
- Extra API call on first use of each font
- Relies on Fontsource API availability
- Access to 1500+ open-source fonts without bundling

**Result:** AI can now specify any Google Font or open-source font by name. UIs look polished with proper typography.

---

## Step 17: Unified Response Schema (AI Decides Mode)

**Problem:** Hardcoded routing logic decided when to use patches vs full HTML based on action type. This was inflexible and didn't account for context.

**Previous logic:**
```typescript
const shouldGenerateFullHtml = !currentHtml || prompt || isGenerateAction || isResetAction;
```

**Solution:** Let the AI decide the mode via a unified response schema.

**Unified schema:**
```typescript
const UnifiedResponseSchema = z.union([
  z.object({ mode: z.literal("patches"), patches: PatchArraySchema }),
  z.object({ mode: z.literal("full"), html: z.string() }),
]);
```

**Single system prompt** explains both modes and when to use each:
- **Patches** for: counter increments, checkbox toggles, adding/removing items, style changes
- **Full HTML** for: initial generation, major redesigns, when most of the page changes

**Key changes:**
1. **GenerateService:** New `streamUnified()` function streams either patches or full HTML
2. **UIService:** Simplified `generateStream()` - just passes request to AI, handles response
3. **No hardcoded routing** - AI understands context better than rules

**Benefits:**
- More generic - works for any use case from single-letter font change to full redesign
- AI can batch related style changes in one html patch on a container
- Simpler codebase - removed conditional logic
- Future-proof - AI adapts to new patterns without code changes

**Result:** The system is now fully generic. AI chooses the optimal update strategy based on the actual request context.

---

## Step 18: Persistent Storage with Effect KeyValueStore

**Problem:** Session data was ephemeral. Server restart loses all state.

**Solution:** New `StorageService` using Effect's `KeyValueStore` abstraction.

**Key changes:**
- `STORAGE=memory` (default) or `STORAGE=file` (persists to `.data/`)
- Effect Schema validates stored data with proper `StorageParseError`
- `SessionService` only generates IDs; `StorageService` handles all persistence
- Schema includes `embedding`, `summary`, `facts` fields for future compaction and RAG

**Result:** Clean separation of concerns. Ready for conversation summarization and semantic search.

---

## Step 19: Fixed Footer for Reliable Navigation

**Problem:** The AI-generated prompt input and reset button could break or be missing if AI generates malformed HTML.

**Solution:** Move escape hatch controls (prompt input, send, reset) to a fixed client-side footer outside AI-generated content.

**Key changes:**
- Fixed footer in `index.html` with prompt input, send button, reset button
- Initial intro HTML defined as constant in frontend (no AI call until first prompt)
- Removed escape hatch instructions from system prompts
- AI only generates content inside `#content` div

**Benefits:**
- Navigation controls always work regardless of AI output
- System prompt is shorter and fully static (better cache hit rate)
- First load is instant - no AI call needed

---

## Step 20: Separated History for Optimal Caching

**Problem:** Message history breaks Groq's prompt caching. Storing prompts and actions together chronologically means the cache prefix breaks on every action, wasting cacheability of prompts.

**Insight from usage patterns:**
- Users create UI via prompts (2-3 prompts typically)
- Then interact via actions (10-50+ actions)
- Prompts change rarely after creation; actions change every request

**Solution:** Store prompts and actions separately in `StorageService`:
- `prompts:{sessionId}` - User descriptions of what to create/change
- `actions:{sessionId}` - User interactions with the UI

**Message structure optimized for caching:**
```
[system prompt]           ← Static, always cached
[prompt 1]                ← Semi-static prefix (high cache hits)
[prompt 2]
[RECENT ACTIONS: ...]     ← Compact summary (changes frequently)
[current request]         ← Dynamic
```

**Key changes:**
- `StorageService` refactored with separate `addPrompt`, `addAction`, `getRecentPrompts`, `getRecentActions`
- Prompts stored verbatim for future RAG potential
- Actions summarized into single compact message
- `streamUnified` finalizer stores prompt/action after generation completes

**Trade-off:** Loses exact chronology, but prompts form stable prefix that gets cached across requests.

**Result:** With typical usage (3 prompts, 20 actions), the prompt prefix stays cached for all 20 action requests instead of breaking on each.

---

## Step 21: Fail-Fast Patch Validation with Retry

**Problem:** LLM sometimes generates invalid patches - malformed JSON, selectors that don't exist, or broken HTML. These errors would crash the stream or corrupt the UI state.

**Solution:** Validate patches during streaming using a temporary DOM, fail fast on first error, and retry with a corrective prompt.

**How it works:**
1. Create a validation document (happy-dom) from current HTML before streaming
2. As each patch streams in, apply it to the validation document
3. If validation fails: stop streaming, capture valid responses so far, append corrective prompt
4. Retry up to 3 times with context about what went wrong
5. AI sees the error and fixes its approach

**Key patterns:**
- **Error as data** - Validation errors are emitted as stream items, not thrown exceptions
- **Effect.iterate** - Functional retry loop with immutable state
- **Stream.mapAccumEffect** - Threading accumulated responses through the stream

**Error types handled:**
- `JsonParseError` - Malformed JSON in LLM output
- `PatchValidationError` - Selector not found, empty selector, apply error

**Result:** Invalid patches trigger automatic retry with helpful context. Users see clean UI updates even when LLM makes mistakes.

---

## Step 22: Semantic Memory with Vector Search

**Problem:** The system has no long-term memory. Users can't ask "what did I build last week?" or have the AI recall context from previous sessions.

**Solution:** SQLite-based memory system with LLM-generated summaries and vector embeddings for semantic search.

**Architecture:**
- `Database` - libSQL/Turso with Drizzle ORM, runs migrations on startup
- `StoreService` - Low-level CRUD for sessions and memory entries
- `MemoryService` - Background queue for async processing, summarization, embedding
- `SessionService` - Session lifecycle management

**How memory is saved:**
1. After each UI generation, a `MemoryOperation` is enqueued (non-blocking)
2. Background processor generates summaries via LLM (prompts, actions, changes)
3. Summaries are embedded using embedding model
4. Entry stored with: raw data, summaries, embedding, timestamps

**Key design decisions:**
- **Discriminated union for changes** - `MemoryChange = { type: "patches", patches } | { type: "full", html }` elegantly handles both update types
- **Zod over Effect Schema** - AI SDK's `Output.object()` works with Zod but not Effect Schema at runtime
- **Effect.fromNullable** - Clean effect failure when LLM returns no output
- **Background queue** - Memory processing doesn't block UI responses

**Vector search:**
- Uses libSQL's `vector_distance_cos` and `vector_top_k` for ANN search
- Searches within session scope for relevant past interactions
- Returns entries ranked by semantic similarity

**Result:** Sessions persist across restarts. Future: semantic search for "remember when I..." queries.

---

## Key Takeaways

1. **Plain HTML over JSX** - AI can steer a responsive frontend by generating plain HTML
2. **Server-side actions** - Solved the x-html security limitation elegantly
3. **Single endpoint** - One `/generate` route handles both prompts and actions
4. **Current HTML is the state** - No need to maintain separate state or conversation history
5. **Patches over full regeneration** - Small updates are fast and cheap
6. **Graceful degradation** - Patch failures automatically fall back to full regeneration
7. **Separate prompt/action history** - Maximizes cache hits by keeping prompts as stable prefix
8. **Fail-fast with corrective retry** - Validate patches during streaming, retry with error context if invalid
9. **Background queues for expensive operations** - Memory summarization and embedding runs async, doesn't block UI
