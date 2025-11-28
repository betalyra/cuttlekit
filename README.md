# Generative UI

What if your interface just... changed to fit what you're doing? 🤯

Need a quick todo list? You get a simple checkbox list. Running a business and need to track projects with deadlines, priorities, and team assignments? Same app, but now it's a full project manager. Want it in dark mode with bigger fonts? Just say so.

The AI generates the whole UI on the fly. You describe what you need, it builds it. You click around, interact with it, ask for tweaks. It remembers what you've done and builds on top of it.

```
"I need a todo list"
→ Simple todo app appears

"Add priority levels and due dates"
→ Features added, existing todos preserved

"Actually make it a kanban board"
→ Same data, new layout 🪄
```

## Try it

```bash
pnpm install
pnpm run dev:backend   # Terminal 1
pnpm run dev:webpage   # Terminal 2
```

Then open http://localhost:5173

## How it works

See [docs/APPROACH.md](docs/APPROACH.md) for the development journey and key decisions.

---

## Roadmap / Ideas to Explore

### Measurement First
- **Test harness for performance** - Can't improve what we can't measure. Need baseline latency, token usage, and perceived speed metrics before optimizing.

### Perceived Speed
- **Stream HTML to frontend** - Show content as it generates instead of waiting for completion. First token in ~100ms vs full response in ~500ms.

### Context Management
- **Re-add conversation history with aggressive compaction** - Current HTML alone loses nuance. Implement rolling summaries: recent turns verbatim, older turns compressed to structured bullet points. See [docs/COMPACTION.md](docs/COMPACTION.md).

### Multi-Page Support
- **Backend-managed page state** - Current approach assumes single page. Need to store/switch between pages server-side while maintaining session continuity.

### Speculative Execution
- **Pre-generate on hover** - Start generating before user clicks. If hover→click takes 200ms and generation takes 200ms, click feels instant. See [docs/PERFORMANCE.md](docs/PERFORMANCE.md) for more techniques.

### Tool Integration
- **MCP support** - Add Model Context Protocol so AI can use external tools (databases, APIs, file systems) when building UIs.

### Hybrid AI Architecture
- **Browser-side AI for minor updates** - Use lightweight models (Chrome's Gemini Nano) for simple operations locally. Server generates templates, browser AI fills them in. Zero latency for cached actions.
