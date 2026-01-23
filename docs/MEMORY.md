# Memory System Plan

## Overview

Replace the current dumb file-based storage with an intelligent Memory system that uses semantic search (mini-RAG) to provide relevant context for each generation request.

## Current State

- **StorageService** (`storage.ts`): File-based KeyValueStore storing prompts and actions
- **GenerateService** fetches last 3 prompts and last 5 actions blindly
- Session-based storage resets on app restart
- No semantic understanding - only recency matters

### Problem Example
User creates a landing page with "brutalist style with colorful borders", then makes 5 other changes. When they want to modify the design again, the original design context is lost since we only look at recent messages.

---

## Research: How Major AI Providers Implement Memory

### ChatGPT (OpenAI)

OpenAI implements [two memory systems](https://help.openai.com/en/articles/8983136-what-is-memory):

1. **Saved Memories**: Explicit facts the user asks ChatGPT to remember ("Remember I'm vegetarian")
2. **Chat History**: Implicit learning from past conversations

**Architecture**: Uses [RAG (Retrieval Augmented Generation)](https://medium.com/@jay-chung/how-does-chatgpts-memory-feature-work-57ae9733a3f0) - maintains a running summary of key facts that gets injected into new conversations.

**User Controls**:
- Toggle saved memories on/off
- Toggle chat history reference on/off
- **Temporary Chat**: Conversations that don't use or update memory
- Can view, edit, delete specific memories
- [Can link back to original conversations](https://www.techradar.com/ai-platforms-assistants/chatgpt/after-todays-big-memory-upgrade-chatgpt-can-now-remember-conversations-from-a-year-ago-and-link-you-directly-to-them) where information was learned

**Privacy**: Won't proactively remember sensitive info (health details) unless explicitly asked.

### Claude (Anthropic)

Anthropic uses a [file-based approach](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) rather than vector databases:

1. **Project-Scoped Memory**: Each project has its own separate memory context
2. **CLAUDE.md Files**: Memory stored in markdown files in a `/memories` directory
3. **Memory Summary**: Users can view exactly what Claude remembers and edit it

**Architecture**:
- Client-side tool - you control where/how data is stored
- CRUD operations: view, create, str_replace, insert, delete, rename
- Claude automatically checks memory directory before starting tasks

**User Controls**:
- **Incognito Chat**: [Chats don't appear in history or save to memory](https://claude.com/blog/memory)
- Adjustable focus: Tell Claude what to remember or ignore
- Fully optional feature via Settings
- Can view and directly edit memory summary

**Projects Feature**: [Claude Projects](https://elephas.app/blog/claude-projects) allow adding documents and custom instructions as a persistent knowledge base that applies to all chats within the project.

### Google Gemini

Gemini takes a [different approach](https://aitoolanalysis.com/gemini-gems-review/) leveraging its massive context window:

1. **Gems**: Custom versions with instructions and up to 10 reference files
2. **1M Token Context**: Can fit ~750,000 words in context window
3. **Memory Card Technique**: [Manual workaround](https://www.remio.ai/post/beyond-forgetfulness-how-to-build-a-powerful-ai-memory-with-gemini-gems) - users update instruction docs after each session

**Limitations**: [Users report](https://support.google.com/gemini/thread/366495040/gemini-user-memory?hl=en) Gems struggle with long-term memory. The AI can generate updated memory text but cannot overwrite files directly.

### Key Patterns Across Providers

| Feature | ChatGPT | Claude | Gemini |
|---------|---------|--------|--------|
| Memory Scope | User-level | Project-scoped | Gem-scoped |
| Storage | RAG + Summary | Markdown files | Context window |
| Privacy Mode | Temporary Chat | Incognito Chat | N/A |
| User Control | View/Edit/Delete | View/Edit files | Manual updates |
| Explicit Memory | Yes ("Remember X") | Yes (file writes) | Via instructions |
| Implicit Memory | Yes (chat history) | Via summaries | Limited |

---

## Our Memory Model: Sessions as Chats

Based on this research and our use case, we'll implement a **session-based memory model** similar to how chat applications work:

### Core Concept

```
┌─────────────────────────────────────────────────────────────┐
│                         User                                │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │  Session 1  │  │  Session 2  │  │  Session 3  │         │
│  │  "Landing   │  │  "Dashboard │  │  "E-commerce│         │
│  │   Page"     │  │   App"      │  │   Checkout" │         │
│  │             │  │             │  │             │         │
│  │  Memory:    │  │  Memory:    │  │  Memory:    │         │
│  │  - brutalist│  │  - corporate│  │  - checkout │         │
│  │  - pink     │  │  - sidebar  │  │  - cart     │         │
│  │    borders  │  │  - blue     │  │  - payment  │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
│                                                             │
│  [FUTURE] Long-Term Memory (spans all sessions)            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  - User prefers brutalist style                     │   │
│  │  - Always uses Tailwind CSS                         │   │
│  │  - Prefers dark mode defaults                       │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  [FUTURE] Projects (shared knowledge bases)                │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Project: "Acme Corp Brand"                         │   │
│  │  - Brand guidelines.pdf                             │   │
│  │  - Color palette                                    │   │
│  │  - Typography rules                                 │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Session Behavior (Current Scope)

| Action | Behavior |
|--------|----------|
| Open app in new tab | Creates new session with empty memory |
| Refresh page | Returns to same session with memory intact |
| Return to old session | Full memory context available |
| Make changes | Memory updated (async, non-blocking) |

### Future: Long-Term Memory

User-level preferences that span all sessions:
- Style preferences ("I like brutalist design")
- Technical preferences ("Use Tailwind, not Bootstrap")
- Learned from patterns across sessions OR explicitly told

Implementation: Separate `user_preferences` table with its own embeddings, searched alongside session memory.

### Future: Projects

Shared knowledge bases users can create and attach to sessions:
- Upload documents (brand guidelines, style guides)
- Add custom instructions
- Reusable across multiple sessions

Implementation: `projects` table with documents, embeddings, and session associations.

---

## Proposed Architecture

### Service Split

```
┌─────────────────────────────────────────────────────────────┐
│                      MemoryService                          │
│  - saveMemory(sessionId, entry)                             │
│  - search(sessionId, query, limit)                          │
│  - getRecent(sessionId, count)                              │
│  - Uses Effect Queue for async processing                   │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                      StoreService                           │
│  - CRUD operations via Drizzle                              │
│  - insertEntry / getEntries / searchByVector                │
│  - Pure data access, no business logic                      │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│            Turso Database (F32_BLOB vectors)                │
│  - sessions table                                           │
│  - memory_entries table                                     │
│  - Vector index for semantic search                         │
└─────────────────────────────────────────────────────────────┘
```

---

## Model Providers

### EmbeddingModelProvider

Using Vercel AI SDK with Google Gemini embedding, following the same pattern as `LanguageModelProvider`:

```typescript
// packages/common/src/embedding-model.ts

import { Context, Layer, Config, Effect, Redacted } from "effect";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { embed, embedMany, type EmbeddingModel } from "ai";

export type EmbeddingModelConfig = {
  readonly model: EmbeddingModel<string>;
  readonly dimensions: number;
  readonly providerName: string;
};

export class EmbeddingModelProvider extends Context.Tag("EmbeddingModelProvider")<
  EmbeddingModelProvider,
  EmbeddingModelConfig
>() {}

// packages/common/src/google/embedding-model.ts

export const GoogleEmbeddingModelLayer = (modelId: string = "text-embedding-004") =>
  Layer.effect(
    EmbeddingModelProvider,
    Effect.gen(function* () {
      const apiKey = yield* Config.redacted("GOOGLE_API_KEY");
      const google = createGoogleGenerativeAI({
        apiKey: Redacted.value(apiKey),
      });
      return {
        model: google.textEmbeddingModel(modelId),
        dimensions: 768, // text-embedding-004 outputs 768 dimensions
        providerName: "google",
      };
    })
  ).pipe(Layer.orDie);
```

### Summarization

For generating change summaries, we'll use the existing `LanguageModelProvider` with the configured model. In the future, we can add support for multiple models (e.g., a faster/cheaper model for summarization).

---

## Database Schema

### Sessions Table

Sessions are persistent "chats" that users can return to:

```typescript
import { createId } from "@paralleldrive/cuid2";

const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  userId: text("user_id").notNull(),              // For future auth, default "default-user"

  name: text("name"),                             // Optional user-given name, e.g., "Landing Page"

  createdAt: integer("created_at").notNull(),
  lastAccessedAt: integer("last_accessed_at").notNull(),
});

// Index for listing user's sessions
// CREATE INDEX sessions_user_idx ON sessions(user_id, last_accessed_at DESC)
```

### Memory Entries Table

Each request batch stored as a unified entry (input + output). Supports batched prompts/actions for future "stream buffering" feature (e.g., user clicks button 3 times quickly while AI is processing):

```typescript
const EMBEDDING_DIMENSIONS = 768;

const sessionMemoryEntries = sqliteTable("session_memory_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),

  // Input - supports batched prompts/actions
  // JSON array: [{ content: string, file?: { name, type } }, ...]
  prompts: text("prompts", { mode: "json" }),
  promptSummary: text("prompt_summary"),       // LLM-generated summary of all prompts

  // JSON array: [{ action: string, data?: unknown }, ...]
  actions: text("actions", { mode: "json" }),
  actionSummary: text("action_summary"),       // LLM-generated summary of all actions

  // Output
  changeSummary: text("change_summary").notNull(),
  patchCount: integer("patch_count").notNull(),

  // Semantic search
  embedding: float32Array("embedding", { dimensions: EMBEDDING_DIMENSIONS }),

  // Metadata
  createdAt: integer("created_at").notNull(),
});

// Vector index for semantic search
// CREATE INDEX session_memory_entries_embedding_idx ON session_memory_entries(libsql_vector_idx(embedding))

// Index for recent entries by session
// CREATE INDEX session_memory_entries_session_idx ON session_memory_entries(session_id, created_at DESC)
```

**Future: Stream Buffering**

When implemented, if the AI is still processing and the user quickly submits multiple prompts or clicks multiple buttons, these will be queued and batched into a single memory entry. For now, we handle single prompt/action per entry but the schema supports batching.

### Future Tables (Not Implemented Now)

```typescript
// User preferences (long-term memory)
const userPreferences = sqliteTable("user_preferences", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  content: text("content").notNull(),             // "Prefers brutalist style"
  embedding: float32Array("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
  createdAt: integer("created_at").notNull(),
});

// Projects (shared knowledge bases)
const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  instructions: text("instructions"),              // Custom instructions
  createdAt: integer("created_at").notNull(),
});

const projectDocuments = sqliteTable("project_documents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: text("project_id").notNull().references(() => projects.id),
  name: text("name").notNull(),
  content: text("content").notNull(),
  embedding: float32Array("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
  createdAt: integer("created_at").notNull(),
});

const sessionProjects = sqliteTable("session_projects", {
  sessionId: text("session_id").notNull().references(() => sessions.id),
  projectId: text("project_id").notNull().references(() => projects.id),
});
```

---

## Change Summary Generation

Using LLM summarization with the configured language model:

```typescript
const generateChangeSummary = (
  patches: Patch[],
  context: { prompt?: string; action?: string; currentHtml?: string }
) =>
  Effect.gen(function* () {
    const { model } = yield* LanguageModelProvider;

    const patchDescriptions = patches.map(describePatch).join("\n");

    const prompt = `Summarize these UI changes in 1-2 sentences. Focus on what changed visually/functionally, not technical details.

${context.prompt ? `User request: "${context.prompt}"` : ""}
${context.action ? `User action: ${context.action}` : ""}

Patches applied:
${patchDescriptions}

Summary:`;

    const result = await generateText({
      model,
      prompt,
      maxTokens: 100,
    });

    return result.text.trim();
  });

const describePatch = (patch: Patch): string => {
  if ("text" in patch) return `Set text in ${patch.selector} to "${patch.text.slice(0, 50)}..."`;
  if ("attr" in patch) return `Updated attributes on ${patch.selector}: ${Object.keys(patch.attr).join(", ")}`;
  if ("html" in patch) return `Replaced HTML in ${patch.selector}`;
  if ("append" in patch) return `Appended content to ${patch.selector}`;
  if ("prepend" in patch) return `Prepended content to ${patch.selector}`;
  if ("remove" in patch) return `Removed ${patch.selector}`;
  return `Modified ${JSON.stringify(patch)}`;
};
```

---

## Context Building Strategy

For each new request, build context from session memory:

### 1. Recent Summaries (last 5)
Always include the most recent entries for continuity:

```
[RECENT CHANGES]
1. Added navigation bar with three menu items
2. Updated hero section with brutalist styling
3. Changed button colors to match theme
4. Added footer with contact info
5. Fixed mobile responsiveness
```

### 2. Semantic Search Results (top 3, excluding recent)
Find historically relevant entries within this session:

```
[RELEVANT CONTEXT]
- (earlier) "Make it brutalist with colorful borders" → Changed hero section styling...
- (earlier) "Use a blue color theme" → Updated header, buttons, accent colors...
```

### Implementation

```typescript
const buildContext = (
  sessionId: string,
  currentRequest: { prompt?: string; action?: string }
) =>
  Effect.gen(function* () {
    const memory = yield* MemoryService;

    // 1. Get 5 most recent entries
    const recentEntries = yield* memory.getRecent(sessionId, 5);
    const recentIds = new Set(recentEntries.map(e => e.id));

    // 2. Semantic search (excluding recent to avoid duplicates)
    const searchQuery = currentRequest.prompt || `user action: ${currentRequest.action}`;
    const allRelevant = yield* memory.search(sessionId, searchQuery, 8);
    const relevantEntries = allRelevant.filter(e => !recentIds.has(e.id)).slice(0, 3);

    return { recentEntries, relevantEntries };
  });
```

---

## Async Processing with Effect Queue

Memory operations should not block the request stream:

```typescript
export class MemoryService extends Effect.Service<MemoryService>()(
  "MemoryService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const store = yield* StoreService;
      const { model: embeddingModel } = yield* EmbeddingModelProvider;

      // Queue for async memory operations
      const queue = yield* Queue.unbounded<MemoryOperation>();

      // Background fiber processing the queue
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            const operation = yield* Queue.take(queue);
            yield* processOperation(operation).pipe(
              Effect.catchAll((error) =>
                Effect.log("Memory operation failed", { error })
              )
            );
          })
        )
      );

      const processOperation = (op: MemoryOperation) =>
        Effect.gen(function* () {
          // 1. Generate change summary using LLM
          const summary = yield* generateChangeSummary(
            op.patches,
            { prompt: op.prompt, action: op.action }
          );

          // 2. Build text for embedding
          const inputDescription = op.prompt
            ? `User: ${op.prompt}`
            : `Action: ${op.action}`;
          const textToEmbed = `${inputDescription}. Changes: ${summary}`;

          // 3. Generate embedding
          const { embedding } = yield* Effect.promise(() =>
            embed({ model: embeddingModel, value: textToEmbed })
          );

          // 4. Store in database
          yield* store.insertMemoryEntry({
            sessionId: op.sessionId,
            prompt: op.prompt,
            action: op.action,
            actionData: op.actionData ? JSON.stringify(op.actionData) : null,
            changeSummary: summary,
            patchCount: op.patches.length,
            embedding: embedding,
            createdAt: Date.now(),
          });

          // 5. Update session last accessed
          yield* store.updateSessionLastAccessed(op.sessionId);
        });

      // Public API
      const saveMemory = (op: MemoryOperation) =>
        Queue.offer(queue, op);

      const search = (sessionId: string, query: string, limit: number) =>
        Effect.gen(function* () {
          const { embedding } = yield* Effect.promise(() =>
            embed({ model: embeddingModel, value: query })
          );
          return yield* store.searchByVector(sessionId, embedding, limit);
        });

      const getRecent = (sessionId: string, count: number) =>
        store.getRecentEntries(sessionId, count);

      return { saveMemory, search, getRecent };
    }),
  }
) {}

type MemoryOperation = {
  sessionId: string;
  prompt?: string;
  action?: string;
  actionData?: Record<string, unknown>;
  patches: Patch[];
};
```

---

## Session Management

### SessionService Updates

```typescript
export class SessionService extends Effect.Service<SessionService>()(
  "SessionService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const store = yield* StoreService;
      const DEFAULT_USER_ID = "default-user";

      // ID generation handled by Drizzle schema ($defaultFn with cuid2)
      const createSession = () =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const timestamp = DateTime.toEpochMillis(now);

          // Store handles ID generation via cuid2, returns the new session
          const session = yield* store.insertSession({
            userId: DEFAULT_USER_ID,
            createdAt: timestamp,
            lastAccessedAt: timestamp,
          });

          return session.id;
        });

      const getSession = (sessionId: string) =>
        store.getSession(sessionId);

      const getOrCreateSession = (sessionId?: string) =>
        Effect.gen(function* () {
          if (sessionId) {
            const session = yield* getSession(sessionId);
            if (session) {
              yield* store.updateSessionLastAccessed(sessionId);
              return session;
            }
          }
          const newSessionId = yield* createSession();
          return yield* getSession(newSessionId);
        });

      const listSessions = (userId: string = DEFAULT_USER_ID) =>
        store.listSessionsByUser(userId);

      return {
        createSession,
        getSession,
        getOrCreateSession,
        listSessions,
      };
    }),
  }
) {}
```

---

## Integration Points

### 1. UIService Changes

After stream completes, enqueue memory save:

```typescript
const doneEvent = Stream.fromEffect(
  Effect.gen(function* () {
    const memory = yield* MemoryService;
    const finalHtml = yield* vdomService.getHtml(sessionId);

    // Enqueue memory save (non-blocking)
    if (appliedPatches.length > 0) {
      yield* memory.saveMemory({
        sessionId,
        prompt,
        action,
        actionData,
        patches: appliedPatches,
      });
    }

    return { type: "done" as const, html: finalHtml || lastHtml };
  })
);
```

### 2. GenerateService Changes

Use semantic context instead of dumb recency:

```typescript
// In streamUnified:
const { recentEntries, relevantEntries } = yield* buildContext(
  sessionId,
  { prompt: options.prompt, action: options.action }
);

// Format for prompt
const historyParts: string[] = [];

if (recentEntries.length > 0) {
  historyParts.push(
    `[RECENT CHANGES]\n${recentEntries.map((e, i) =>
      `${i + 1}. ${e.prompt ? `"${e.prompt}" → ` : ""}${e.changeSummary}`
    ).join("\n")}`
  );
}

if (relevantEntries.length > 0) {
  historyParts.push(
    `[RELEVANT PAST CONTEXT]\n${relevantEntries.map(e =>
      `- ${e.prompt ? `"${e.prompt}" → ` : ""}${e.changeSummary}`
    ).join("\n")}`
  );
}
```

### 3. API Endpoints (Future)

```typescript
// List user's sessions
GET /api/sessions

// Rename a session
PATCH /api/sessions/:sessionId
{ "name": "My Landing Page" }
```

---

## File Structure

```
packages/common/src/
├── embedding-model.ts              # EmbeddingModelProvider tag
├── google/
│   ├── language-model.ts           # (existing)
│   └── embedding-model.ts          # GoogleEmbeddingModelLayer
└── server.ts                       # Updated exports

apps/backend/src/services/
├── memory/
│   ├── index.ts                    # Exports
│   ├── service.ts                  # MemoryService (mini-RAG logic)
│   ├── store.ts                    # StoreService (Drizzle CRUD)
│   ├── schema.ts                   # Drizzle schema definitions
│   ├── database.ts                 # Turso client setup
│   └── types.ts                    # Type definitions
├── session.ts                      # Updated SessionService
├── generate/
│   └── service.ts                  # Updated to use MemoryService
├── ui.ts                           # Updated to save to memory
└── storage.ts                      # DEPRECATED - remove after migration
```

---

## Dependencies to Add

**packages/common/package.json:**
```json
{
  "dependencies": {
    "@ai-sdk/google": "...",  // (already present)
    "ai": "..."               // (already present, has embed/embedMany)
  }
}
```

**apps/backend/package.json:**
```json
{
  "dependencies": {
    "@libsql/client": "^0.17.0",
    "@paralleldrive/cuid2": "^2.2.2",
    "drizzle-orm": "^0.45.1"
  },
  "devDependencies": {
    "drizzle-kit": "^0.30.0"
  }
}
```

---

## Implementation Order

### Phase 1: Model Providers
1. [ ] Create `packages/common/src/embedding-model.ts`
2. [ ] Create `packages/common/src/google/embedding-model.ts`
3. [ ] Update `packages/common/src/server.ts` exports

### Phase 2: Database Layer
4. [ ] Add `@paralleldrive/cuid2` dependency to backend
5. [ ] Create `apps/backend/src/services/memory/schema.ts`
6. [ ] Create `apps/backend/src/services/memory/database.ts`
7. [ ] Create `apps/backend/src/services/memory/store.ts`

### Phase 3: Memory Service
8. [ ] Create `apps/backend/src/services/memory/service.ts`
9. [ ] Implement Queue-based async processing
10. [ ] Implement LLM summarization (using existing LanguageModelProvider)
11. [ ] Implement semantic search

### Phase 4: Integration
12. [ ] Update `SessionService` for database-backed sessions
13. [ ] Update `GenerateService` to use semantic context
14. [ ] Update `UIService` to save memory after completion
15. [ ] Wire up layers in application entry point

### Phase 5: Cleanup
16. [ ] Remove old `StorageService`
17. [ ] Test end-to-end flow

---

## Testing Strategy

1. **Unit Tests**
   - EmbeddingModelProvider: mock API, verify embedding shape
   - StoreService: test CRUD with in-memory SQLite
   - MemoryService: test queue processing, search ranking

2. **Integration Tests**
   - Full flow: request → patches → summary → embed → store → search finds it
   - Verify semantic relevance ("color theme" finds color-related entries)
   - Session isolation (Session A memory doesn't appear in Session B)

3. **Manual Testing**
   - Create UI with specific style
   - Make unrelated changes
   - Return to style changes
   - Verify context includes original style request

---

## Resolved Questions

1. **Embedding model**: Google Gemini `text-embedding-004` via Vercel AI SDK
2. **Summarization**: LLM-based using existing `LanguageModelProvider` (same model as UI generation for now)
3. **Memory pruning**: Store `createdAt` timestamp, implement pruning later
4. **Session vs User**: Session-based (like chats), with future path to user-level long-term memory
5. **Memory toggle**: Out of scope for now (future feature for long-term memory)
6. **ID generation**: Using `@paralleldrive/cuid2` in Drizzle schema

---

## Future Roadmap

### Short Term (After MVP)
- [ ] Session list/history UI
- [ ] Session renaming

### Medium Term
- [ ] Long-term memory (user preferences spanning sessions)
- [ ] Memory toggle (enable/disable long-term memory)
- [ ] Memory pruning/archival strategy

### Long Term
- [ ] Projects (shared knowledge bases with documents)
- [ ] better-auth integration
- [ ] Multi-user support

---

## Sources

- [ChatGPT Memory Feature](https://help.openai.com/en/articles/8983136-what-is-memory)
- [ChatGPT Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq)
- [How ChatGPT Memory Works (Technical)](https://medium.com/@jay-chung/how-does-chatgpts-memory-feature-work-57ae9733a3f0)
- [ChatGPT Memory Upgrade 2026](https://www.techradar.com/ai-platforms-assistants/chatgpt/after-todays-big-memory-upgrade-chatgpt-can-now-remember-conversations-from-a-year-ago-and-link-you-directly-to-them)
- [Claude Memory Announcement](https://claude.com/blog/memory)
- [Claude Memory Tool API](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- [Claude Projects Guide](https://elephas.app/blog/claude-projects)
- [Gemini Gems Review](https://aitoolanalysis.com/gemini-gems-review/)
- [Gemini Memory Card Technique](https://www.remio.ai/post/beyond-forgetfulness-how-to-build-a-powerful-ai-memory-with-gemini-gems)
