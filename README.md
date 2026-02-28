<p align="center">
  <img src="assets/logo-text.svg" alt="cuttlekit" width="500" />
</p>

cuttlekit is a generative UI toolkit that generates interactive UIs on the fly using LLMs.

> ⚠️ **Highly experimental** — APIs, config format, and behavior may change at any time. Expect rough edges.

## Features

- 🎨 **Generate any UI** — Describe what you need and get a fully interactive interface, no predefined templates
- ⚡ **Real-time streaming** — UI updates stream to the browser as the LLM generates them, near-instant feedback
- 🛠️ **Sandbox code execution** — Integrate with external services and libraries through secure server-side TypeScript execution
- 🌐 **Multi-model & provider** — Switch between LLM providers and models per request (Google, Groq, etc.)
- 🧠 **Memory** — Remembers past interactions and patterns across sessions using vector-based semantic recall
- 🧩 **Framework independent** — Pure HTML + CSS output, no React/Vue/Svelte required on the client

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v20+)
- [pnpm](https://pnpm.io/) (v9+)

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment variables

Copy the example env file and fill in your API keys:

```bash
cp .env.example .env
```

At minimum you need one provider API key matching a provider in your `config.toml` (e.g. `GOOGLE_API_KEY` for Google). See [.env.example](.env.example) for all options.

### 3. Configure models & providers

Copy the example config and adjust as needed:

```bash
cp config.example.toml config.toml
```

This is where you configure which LLM providers, models, and optional features (sandbox, dependencies) are available. See [config.example.toml](config.example.toml) for all options with comments.

**Recommended setup:** Google with `gemini-3-flash-preview` offers a good balance of performance and quality. Groq is also supported with `openai/gpt-oss-120b` and `moonshotai/kimi-k2-instruct-0905` (Kimi K2) — faster, but don't match Gemini 3 Flash on quality.

### 4. Run

```bash
pnpm run dev:backend   # Terminal 1 — auto-loads .env from project root
pnpm run dev:webpage   # Terminal 2
```

If you manage env vars yourself (e.g. via 1Password CLI, direnv, shell exports), use the `no-env` variant instead:

```bash
pnpm run dev:backend:no-env
```

Then open http://localhost:5173 🚀

## License

This software is licensed under the [O'Saasy License Agreement](./LICENSE.md).

**You are free to use, modify, and distribute this software** for personal projects, internal tools, or any use where you're not reselling the software's functionality itself.

**A commercial license is required** if you want to offer this software (or derivatives) as a hosted, managed, or SaaS product where the primary value is the software's functionality. [Contact us](https://cal.com/betalyra/30min) for commercial licensing.

## Contributing

We welcome contributions via pull requests! 🎉 All contributors must sign our [Contributor License Agreement](./CLA.md) before a PR can be merged — the CLA bot will guide you through the process on your first PR.
