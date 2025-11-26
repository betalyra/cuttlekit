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

See [architecture.md](architecture.md)
