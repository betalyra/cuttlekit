# Memory Caching Experiment Design

## Goal

Measure cache efficiency of different context-building strategies without reimplementing the full application.

**Key insight:** We don't need to call the LLM to measure cache rates. Cache rate is determined by **prefix stability** - how much of the prompt stays identical between consecutive requests.

---

## Experiment Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    EXPERIMENT PIPELINE                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. SCENARIO GENERATOR                                          │
│     ├─ LLM generates realistic user interaction sequences       │
│     └─ Output: Array of { type, action?, prompt?, mockHtml }    │
│                                                                 │
│  2. CONTEXT BUILDERS (strategies to compare)                    │
│     ├─ CurrentStrategy: Recent changes + semantic search        │
│     ├─ TieredStrategy: Session summary + milestones + recent    │
│     ├─ ActionAwareStrategy: Skip history for simple actions     │
│     └─ ... other strategies                                     │
│                                                                 │
│  3. PROMPT SIMULATOR                                            │
│     ├─ For each interaction in scenario                         │
│     ├─ Build full prompt using each strategy                    │
│     └─ Output: Array of prompts per strategy                    │
│                                                                 │
│  4. CACHE ANALYZER                                              │
│     ├─ Compare consecutive prompts                              │
│     ├─ Measure prefix match length                              │
│     └─ Output: Cache hit rate, token counts, charts             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Component 1: Scenario Generator

Use an LLM to generate realistic interaction sequences:

```typescript
// apps/experiments/src/scenarios/generator.ts

const SCENARIO_PROMPT = `
Generate a realistic sequence of 50 user interactions with a generative UI system.
The user is building a counter dashboard app.

Output JSON array where each item is one of:
- { "type": "prompt", "prompt": "user's text request" }
- { "type": "action", "action": "increment", "data": { "id": "1" } }
- { "type": "action", "action": "decrement", "data": { "id": "2" } }
- { "type": "action", "action": "add-counter" }
- { "type": "action", "action": "delete", "data": { "id": "3" } }
- { "type": "action", "action": "reset" }

Realistic patterns:
- User starts with a prompt to create something
- Then interacts with it (many clicks)
- Occasionally refines with another prompt
- Sometimes adds/removes elements

Example sequence start:
[
  { "type": "prompt", "prompt": "create a simple counter" },
  { "type": "action", "action": "increment", "data": { "id": "1" } },
  { "type": "action", "action": "increment", "data": { "id": "1" } },
  { "type": "action", "action": "increment", "data": { "id": "1" } },
  { "type": "prompt", "prompt": "make it brutalist style" },
  ...
]
`;

type Interaction =
  | { type: "prompt"; prompt: string }
  | { type: "action"; action: string; data?: Record<string, unknown> };

const generateScenario = async (description: string): Promise<Interaction[]> => {
  // Call LLM with SCENARIO_PROMPT + description
  // Parse JSON response
  // Return interaction array
};
```

**Pre-built scenarios for consistency:**

```typescript
// apps/experiments/src/scenarios/prebuilt.ts

export const COUNTER_DASHBOARD_SCENARIO: Interaction[] = [
  { type: "prompt", prompt: "create a counter dashboard with 3 counters" },
  { type: "action", action: "increment", data: { id: "1" } },
  { type: "action", action: "increment", data: { id: "1" } },
  { type: "action", action: "increment", data: { id: "2" } },
  { type: "action", action: "decrement", data: { id: "1" } },
  { type: "prompt", prompt: "make it brutalist with thick black borders" },
  { type: "action", action: "increment", data: { id: "3" } },
  // ... 50+ interactions
];

export const TODO_APP_SCENARIO: Interaction[] = [
  { type: "prompt", prompt: "create a todo list" },
  { type: "action", action: "add", data: { text: "Buy groceries" } },
  { type: "action", action: "add", data: { text: "Walk the dog" } },
  { type: "action", action: "toggle", data: { id: "1" } },
  // ...
];
```

---

## Component 2: Mock State Tracker

Track simulated state without real LLM calls:

```typescript
// apps/experiments/src/state/mock-state.ts

type MemoryEntry = {
  sequenceNumber: number;
  type: "prompt" | "action";
  prompt?: string;
  action?: string;
  actionData?: Record<string, unknown>;
  changeSummary: string;  // Mock summary
  timestamp: number;
};

type SessionState = {
  sessionId: string;
  currentHtml: string;
  memoryEntries: MemoryEntry[];
  nextSequence: number;
};

const createMockState = (): SessionState => ({
  sessionId: "test-session",
  currentHtml: INITIAL_MOCK_HTML,
  memoryEntries: [],
  nextSequence: 1,
});

const applyInteraction = (state: SessionState, interaction: Interaction): SessionState => {
  const entry: MemoryEntry = {
    sequenceNumber: state.nextSequence,
    type: interaction.type,
    prompt: interaction.type === "prompt" ? interaction.prompt : undefined,
    action: interaction.type === "action" ? interaction.action : undefined,
    actionData: interaction.type === "action" ? interaction.data : undefined,
    changeSummary: generateMockSummary(interaction),
    timestamp: Date.now(),
  };

  return {
    ...state,
    currentHtml: mutateMockHtml(state.currentHtml, interaction),
    memoryEntries: [...state.memoryEntries, entry],
    nextSequence: state.nextSequence + 1,
  };
};

// Simple mock summaries - don't need to be accurate
const generateMockSummary = (interaction: Interaction): string => {
  if (interaction.type === "prompt") {
    return `User requested: "${interaction.prompt}"`;
  }
  return `User performed ${interaction.action} action`;
};
```

---

## Component 3: Context Builders (Strategies)

Define different strategies as pure functions:

```typescript
// apps/experiments/src/strategies/types.ts

type ContextBuilderInput = {
  state: SessionState;
  currentInteraction: Interaction;
};

type BuiltContext = {
  systemPrompt: string;
  userMessage: string;
};

type ContextStrategy = {
  name: string;
  description: string;
  build: (input: ContextBuilderInput) => BuiltContext;
};
```

### Strategy: Current (Baseline)

```typescript
// apps/experiments/src/strategies/current.ts

export const currentStrategy: ContextStrategy = {
  name: "current",
  description: "Current implementation: recent 5 + semantic search",

  build: ({ state, currentInteraction }) => {
    const recent = state.memoryEntries.slice(-5);
    // Mock semantic search - just grab some older entries
    const semantic = state.memoryEntries.slice(0, 3);

    const historyParts: string[] = [];

    if (recent.length > 0) {
      historyParts.push(
        `[RECENT CHANGES]\n${recent.map((e, i) =>
          `${i + 1}. ${e.changeSummary}`
        ).join("\n")}`
      );
    }

    if (semantic.length > 0) {
      historyParts.push(
        `[RELEVANT PAST CONTEXT]\n${semantic.map(e =>
          `- ${e.changeSummary}`
        ).join("\n")}`
      );
    }

    const actionPart = currentInteraction.type === "action"
      ? `[NOW] Action: ${currentInteraction.action} Data: ${JSON.stringify(currentInteraction.data ?? {})}`
      : `[NOW] Prompt: ${currentInteraction.prompt}`;

    const userMessage = [
      `HTML:\n${state.currentHtml}`,
      ...historyParts,
      actionPart,
    ].join("\n\n");

    return {
      systemPrompt: SYSTEM_PROMPT,
      userMessage,
    };
  },
};
```

### Strategy: Tiered

```typescript
// apps/experiments/src/strategies/tiered.ts

export const tieredStrategy: ContextStrategy = {
  name: "tiered",
  description: "Tiered: session summary (every 25) + milestones (every 10) + recent 3",

  build: ({ state, currentInteraction }) => {
    const currentSeq = state.nextSequence;

    // Session summary - regenerated every 25 interactions
    const summaryAsOf = Math.floor((currentSeq - 1) / 25) * 25;
    const sessionSummary = summaryAsOf > 0
      ? `Session with ${summaryAsOf} interactions. User building UI.`
      : null;

    // Milestones - every 10th entry
    const milestones = state.memoryEntries
      .filter(e => e.sequenceNumber % 10 === 0)
      .map(e => `#${e.sequenceNumber}: ${e.changeSummary}`);

    // Recent - last 3
    const recent = state.memoryEntries.slice(-3);

    const parts: string[] = [];

    if (sessionSummary) {
      parts.push(`[SESSION] ${sessionSummary}`);
    }

    if (milestones.length > 0) {
      parts.push(`[MILESTONES]\n${milestones.join("\n")}`);
    }

    // HTML in middle
    parts.push(`[HTML]\n${state.currentHtml}`);

    // Volatile content at END
    if (recent.length > 0) {
      parts.push(
        `[RECENT]\n${recent.map(e =>
          `#${e.sequenceNumber}: ${e.changeSummary}`
        ).join("\n")}`
      );
    }

    const actionPart = currentInteraction.type === "action"
      ? `[NOW] Action: ${currentInteraction.action}`
      : `[NOW] Prompt: ${currentInteraction.prompt}`;
    parts.push(actionPart);

    return {
      systemPrompt: SYSTEM_PROMPT,
      userMessage: parts.join("\n\n"),
    };
  },
};
```

### Strategy: Action-Aware

```typescript
// apps/experiments/src/strategies/action-aware.ts

const SIMPLE_ACTIONS = new Set(["increment", "decrement", "toggle"]);

export const actionAwareStrategy: ContextStrategy = {
  name: "action-aware",
  description: "Skip history for simple actions, full context for prompts",

  build: ({ state, currentInteraction }) => {
    const parts: string[] = [];

    // For simple actions: just HTML + action
    if (
      currentInteraction.type === "action" &&
      SIMPLE_ACTIONS.has(currentInteraction.action)
    ) {
      parts.push(`[HTML]\n${state.currentHtml}`);
      parts.push(`[NOW] Action: ${currentInteraction.action} Data: ${JSON.stringify(currentInteraction.data ?? {})}`);

      return {
        systemPrompt: SYSTEM_PROMPT,
        userMessage: parts.join("\n\n"),
      };
    }

    // For prompts/structural actions: include context
    const recent = state.memoryEntries.slice(-3);

    if (recent.length > 0) {
      parts.push(
        `[RECENT]\n${recent.map(e =>
          `#${e.sequenceNumber}: ${e.changeSummary}`
        ).join("\n")}`
      );
    }

    parts.push(`[HTML]\n${state.currentHtml}`);

    const actionPart = currentInteraction.type === "action"
      ? `[NOW] Action: ${currentInteraction.action}`
      : `[NOW] Prompt: ${currentInteraction.prompt}`;
    parts.push(actionPart);

    return {
      systemPrompt: SYSTEM_PROMPT,
      userMessage: parts.join("\n\n"),
    };
  },
};
```

---

## Component 4: Cache Analyzer

Measure prefix stability between consecutive prompts:

```typescript
// apps/experiments/src/analysis/cache-analyzer.ts

type PromptPair = {
  previous: string;
  current: string;
};

type CacheMetrics = {
  prefixLength: number;       // Characters that match
  totalLength: number;        // Total prompt length
  cacheRate: number;          // prefixLength / totalLength
  prefixTokens: number;       // Estimated tokens in prefix
  totalTokens: number;        // Estimated total tokens
};

// Simple token estimation (4 chars ≈ 1 token)
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const findPrefixLength = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i++;
  }
  return i;
};

const analyzeCacheRate = (pair: PromptPair): CacheMetrics => {
  const prefixLength = findPrefixLength(pair.previous, pair.current);
  const totalLength = pair.current.length;

  return {
    prefixLength,
    totalLength,
    cacheRate: totalLength > 0 ? prefixLength / totalLength : 0,
    prefixTokens: estimateTokens(pair.previous.slice(0, prefixLength)),
    totalTokens: estimateTokens(pair.current),
  };
};

// Analyze full sequence
const analyzeStrategy = (
  scenario: Interaction[],
  strategy: ContextStrategy
): StrategyAnalysis => {
  let state = createMockState();
  const prompts: string[] = [];
  const metrics: CacheMetrics[] = [];

  for (const interaction of scenario) {
    const context = strategy.build({ state, currentInteraction: interaction });
    const fullPrompt = context.systemPrompt + "\n\n" + context.userMessage;
    prompts.push(fullPrompt);

    if (prompts.length > 1) {
      metrics.push(analyzeCacheRate({
        previous: prompts[prompts.length - 2],
        current: fullPrompt,
      }));
    }

    state = applyInteraction(state, interaction);
  }

  return {
    strategyName: strategy.name,
    totalInteractions: scenario.length,
    averageCacheRate: metrics.reduce((sum, m) => sum + m.cacheRate, 0) / metrics.length,
    averageTokens: metrics.reduce((sum, m) => sum + m.totalTokens, 0) / metrics.length,
    cacheRateByIndex: metrics.map(m => m.cacheRate),
    // Breakdown by action type
    cacheRateByType: computeByType(scenario, metrics),
  };
};
```

---

## Component 5: Runner & Reporter

```typescript
// apps/experiments/src/runner.ts

import { COUNTER_DASHBOARD_SCENARIO, TODO_APP_SCENARIO } from "./scenarios/prebuilt.js";
import { currentStrategy, tieredStrategy, actionAwareStrategy } from "./strategies/index.js";
import { analyzeStrategy } from "./analysis/cache-analyzer.js";

const SCENARIOS = [
  { name: "Counter Dashboard", data: COUNTER_DASHBOARD_SCENARIO },
  { name: "Todo App", data: TODO_APP_SCENARIO },
];

const STRATEGIES = [
  currentStrategy,
  tieredStrategy,
  actionAwareStrategy,
];

const runExperiment = () => {
  const results: Record<string, Record<string, StrategyAnalysis>> = {};

  for (const scenario of SCENARIOS) {
    results[scenario.name] = {};

    for (const strategy of STRATEGIES) {
      const analysis = analyzeStrategy(scenario.data, strategy);
      results[scenario.name][strategy.name] = analysis;
    }
  }

  return results;
};

const printReport = (results: Record<string, Record<string, StrategyAnalysis>>) => {
  console.log("\n=== CACHE EFFICIENCY EXPERIMENT ===\n");

  for (const [scenarioName, strategyResults] of Object.entries(results)) {
    console.log(`\n## ${scenarioName}\n`);
    console.log("| Strategy | Avg Cache Rate | Avg Tokens | Simple Action Cache |");
    console.log("|----------|----------------|------------|---------------------|");

    for (const [strategyName, analysis] of Object.entries(strategyResults)) {
      const simpleRate = analysis.cacheRateByType["increment"] ?? "N/A";
      console.log(
        `| ${strategyName.padEnd(8)} | ${(analysis.averageCacheRate * 100).toFixed(1)}% | ${analysis.averageTokens.toFixed(0)} | ${typeof simpleRate === "number" ? (simpleRate * 100).toFixed(1) + "%" : simpleRate} |`
      );
    }
  }
};

// Run it
const results = runExperiment();
printReport(results);
```

---

## File Structure

```
apps/experiments/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                    # Main entry point
│   ├── scenarios/
│   │   ├── generator.ts            # LLM-based scenario generation
│   │   ├── prebuilt.ts             # Pre-defined test scenarios
│   │   └── types.ts
│   ├── state/
│   │   ├── mock-state.ts           # Session state simulation
│   │   └── mock-html.ts            # Mock HTML templates
│   ├── strategies/
│   │   ├── index.ts                # Export all strategies
│   │   ├── types.ts                # Strategy interface
│   │   ├── current.ts              # Baseline (current implementation)
│   │   ├── tiered.ts               # Tiered history
│   │   ├── action-aware.ts         # Skip history for simple actions
│   │   └── hybrid.ts               # Combined approach
│   ├── analysis/
│   │   ├── cache-analyzer.ts       # Prefix matching & metrics
│   │   └── reporter.ts             # Console/markdown output
│   └── runner.ts                   # Orchestrates everything
└── results/
    └── .gitkeep                    # Store experiment outputs
```

---

## Running the Experiment

```bash
# From repo root
cd apps/experiments
pnpm install
pnpm run experiment

# Or with specific scenario
pnpm run experiment --scenario=counter --interactions=100
```

---

## Expected Output

```
=== CACHE EFFICIENCY EXPERIMENT ===

## Counter Dashboard (50 interactions)

| Strategy      | Avg Cache Rate | Avg Tokens | Simple Action Cache |
|---------------|----------------|------------|---------------------|
| current       | 31.2%          | 2,450      | 28.5%               |
| tiered        | 58.7%          | 2,100      | 62.3%               |
| action-aware  | 71.4%          | 1,850      | 94.2%               |
| hybrid        | 68.9%          | 1,920      | 92.1%               |

## Breakdown by Interaction Type (action-aware strategy)

| Type       | Count | Avg Cache Rate |
|------------|-------|----------------|
| prompt     | 5     | 45.2%          |
| increment  | 28    | 94.2%          |
| decrement  | 12    | 94.1%          |
| add        | 3     | 52.3%          |
| delete     | 2     | 51.8%          |
```

---

## Visualization Ideas

Generate charts using terminal or export to CSV for visualization:

1. **Cache rate over time** - Line chart showing how cache rate changes as session progresses
2. **Cache rate by action type** - Bar chart comparing different action types
3. **Token usage comparison** - Bar chart of average tokens per strategy
4. **Cumulative token savings** - Area chart showing total tokens saved over session

```typescript
// Simple ASCII chart for terminal
const printCacheRateChart = (rates: number[], width = 50) => {
  rates.forEach((rate, i) => {
    const bars = Math.round(rate * width);
    console.log(`${String(i + 1).padStart(3)}: ${"█".repeat(bars)}${"░".repeat(width - bars)} ${(rate * 100).toFixed(0)}%`);
  });
};
```

---

## Part 2: Running on Actual Code

The mock strategies above are useful for comparing approaches, but we also want to test the **real implementation** to catch regressions when modifying prompt structure.

### Approach: Intercept Real Context Building

Instead of mocking, we extract the context-building logic and make it testable:

```typescript
// apps/backend/src/services/generate/context-builder.ts

// Extract this from GenerateService.streamUnified()
export const buildMessages = (options: {
  sessionId: string;
  currentHtml: string | undefined;
  prompt: string | undefined;
  action: string | undefined;
  actionData: Record<string, unknown> | undefined;
  recentEntries: MemorySearchResult[];
  relevantEntries: MemorySearchResult[];
}): readonly Message[] => {
  // ... existing logic from streamUnified lines 290-331
  // Returns the messages array that would be sent to LLM
};

// Export for testing
export { buildMessages };
```

### Test Harness with Mocked Dependencies

```typescript
// apps/experiments/src/real-code/harness.ts

import { Effect, Layer } from "effect";
import { buildMessages } from "@backend/services/generate/context-builder.js";
import { MemoryService } from "@backend/services/memory/index.js";
import { StoreService } from "@backend/services/memory/store.js";

// Mock MemoryService that returns controlled data
const createMockMemoryLayer = (entries: MemorySearchResult[]) =>
  Layer.succeed(MemoryService, {
    getRecent: (sessionId, count) => Effect.succeed(entries.slice(-count)),
    search: (sessionId, query, limit) => Effect.succeed(entries.slice(0, limit)),
    saveMemory: () => Effect.void,
    describePatch: () => "",
    describePatches: () => "",
  });

// Run actual context builder with mock data
const capturePrompt = (
  interaction: Interaction,
  memoryEntries: MemorySearchResult[],
  currentHtml: string,
) =>
  Effect.gen(function* () {
    const messages = buildMessages({
      sessionId: "test",
      currentHtml,
      prompt: interaction.type === "prompt" ? interaction.prompt : undefined,
      action: interaction.type === "action" ? interaction.action : undefined,
      actionData: interaction.type === "action" ? interaction.data : undefined,
      recentEntries: memoryEntries.slice(-5),
      relevantEntries: memoryEntries.slice(0, 3),
    });

    // Serialize to string for comparison
    return messages.map(m => `[${m.role.toUpperCase()}]\n${m.content}`).join("\n\n");
  });
```

### Integration with Vitest

```typescript
// apps/experiments/src/benchmark.test.ts

import { describe, it, expect } from "vitest";
import { runBenchmark, loadBaseline, saveBaseline } from "./benchmark.js";

describe("Cache Rate Benchmark", () => {
  it("should not regress cache rate for counter scenario", async () => {
    const results = await runBenchmark("counter-dashboard");
    const baseline = await loadBaseline("counter-dashboard");

    // Allow 5% variance
    expect(results.averageCacheRate).toBeGreaterThanOrEqual(baseline.averageCacheRate - 0.05);
    expect(results.simpleActionCacheRate).toBeGreaterThanOrEqual(baseline.simpleActionCacheRate - 0.05);
  });

  it("should not increase token usage significantly", async () => {
    const results = await runBenchmark("counter-dashboard");
    const baseline = await loadBaseline("counter-dashboard");

    // Allow 10% increase
    expect(results.averageTokens).toBeLessThanOrEqual(baseline.averageTokens * 1.1);
  });
});

// Update baseline when intentionally changing
describe.skip("Update Baseline", () => {
  it("saves new baseline", async () => {
    const results = await runBenchmark("counter-dashboard");
    await saveBaseline("counter-dashboard", results);
  });
});
```

---

## Part 3: Stateful Tracking Over Time

### Local State: JSON Baseline File

Store benchmark results in a committed file:

```
apps/experiments/
├── baselines/
│   ├── counter-dashboard.json
│   ├── todo-app.json
│   └── history.json          # Historical runs
```

```typescript
// apps/experiments/src/baseline.ts

import { readFile, writeFile } from "fs/promises";
import { join } from "path";

const BASELINE_DIR = join(import.meta.dirname, "../baselines");

type BaselineResult = {
  averageCacheRate: number;
  simpleActionCacheRate: number;
  promptCacheRate: number;
  averageTokens: number;
  timestamp: string;
  gitCommit: string;
};

type HistoryEntry = BaselineResult & {
  scenario: string;
};

export const loadBaseline = async (scenario: string): Promise<BaselineResult> => {
  const path = join(BASELINE_DIR, `${scenario}.json`);
  const content = await readFile(path, "utf-8");
  return JSON.parse(content);
};

export const saveBaseline = async (scenario: string, result: BaselineResult) => {
  const path = join(BASELINE_DIR, `${scenario}.json`);
  const gitCommit = await getGitCommit();

  const baseline: BaselineResult = {
    ...result,
    timestamp: new Date().toISOString(),
    gitCommit,
  };

  await writeFile(path, JSON.stringify(baseline, null, 2));

  // Also append to history
  await appendToHistory({ ...baseline, scenario });
};

export const appendToHistory = async (entry: HistoryEntry) => {
  const historyPath = join(BASELINE_DIR, "history.json");
  let history: HistoryEntry[] = [];

  try {
    const content = await readFile(historyPath, "utf-8");
    history = JSON.parse(content);
  } catch {
    // File doesn't exist yet
  }

  history.push(entry);

  // Keep last 100 entries
  if (history.length > 100) {
    history = history.slice(-100);
  }

  await writeFile(historyPath, JSON.stringify(history, null, 2));
};

const getGitCommit = async (): Promise<string> => {
  const { execSync } = await import("child_process");
  return execSync("git rev-parse --short HEAD").toString().trim();
};
```

### Example Baseline File

```json
// apps/experiments/baselines/counter-dashboard.json
{
  "averageCacheRate": 0.312,
  "simpleActionCacheRate": 0.285,
  "promptCacheRate": 0.452,
  "averageTokens": 2450,
  "timestamp": "2026-01-30T10:00:00Z",
  "gitCommit": "abc1234"
}
```

### History File for Trend Tracking

```json
// apps/experiments/baselines/history.json
[
  {
    "scenario": "counter-dashboard",
    "averageCacheRate": 0.285,
    "simpleActionCacheRate": 0.250,
    "promptCacheRate": 0.400,
    "averageTokens": 2600,
    "timestamp": "2026-01-25T10:00:00Z",
    "gitCommit": "def5678"
  },
  {
    "scenario": "counter-dashboard",
    "averageCacheRate": 0.312,
    "simpleActionCacheRate": 0.285,
    "promptCacheRate": 0.452,
    "averageTokens": 2450,
    "timestamp": "2026-01-30T10:00:00Z",
    "gitCommit": "abc1234"
  }
]
```

---

## Part 4: GitHub Actions Integration

### Workflow: Run on PR

```yaml
# .github/workflows/cache-benchmark.yml

name: Cache Rate Benchmark

on:
  pull_request:
    paths:
      - 'apps/backend/src/services/generate/**'
      - 'apps/backend/src/services/memory/**'
      - 'packages/common/src/**'

jobs:
  benchmark:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Need history for git commit

      - uses: pnpm/action-setup@v2
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install

      - name: Run cache benchmark
        id: benchmark
        run: |
          cd apps/experiments
          pnpm run benchmark --json > results.json
          cat results.json

      - name: Compare with baseline
        id: compare
        run: |
          cd apps/experiments
          node scripts/compare-baseline.js results.json > comparison.md
          cat comparison.md

      - name: Comment on PR
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const comparison = fs.readFileSync('apps/experiments/comparison.md', 'utf8');

            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: `## 📊 Cache Rate Benchmark\n\n${comparison}`
            });

      - name: Fail if regression
        run: |
          cd apps/experiments
          node scripts/check-regression.js results.json
```

### Comparison Script

```typescript
// apps/experiments/scripts/compare-baseline.ts

import { readFileSync } from "fs";
import { loadBaseline } from "../src/baseline.js";

const main = async () => {
  const resultsPath = process.argv[2];
  const results = JSON.parse(readFileSync(resultsPath, "utf-8"));

  const scenarios = ["counter-dashboard", "todo-app"];
  const output: string[] = [];

  for (const scenario of scenarios) {
    const baseline = await loadBaseline(scenario);
    const current = results[scenario];

    const cacheRateDelta = current.averageCacheRate - baseline.averageCacheRate;
    const tokensDelta = current.averageTokens - baseline.averageTokens;

    const cacheIcon = cacheRateDelta >= 0 ? "✅" : "⚠️";
    const tokensIcon = tokensDelta <= 0 ? "✅" : "⚠️";

    output.push(`### ${scenario}\n`);
    output.push(`| Metric | Baseline | Current | Delta |`);
    output.push(`|--------|----------|---------|-------|`);
    output.push(
      `| Cache Rate | ${(baseline.averageCacheRate * 100).toFixed(1)}% | ${(current.averageCacheRate * 100).toFixed(1)}% | ${cacheIcon} ${cacheRateDelta >= 0 ? "+" : ""}${(cacheRateDelta * 100).toFixed(1)}% |`
    );
    output.push(
      `| Avg Tokens | ${baseline.averageTokens.toFixed(0)} | ${current.averageTokens.toFixed(0)} | ${tokensIcon} ${tokensDelta >= 0 ? "+" : ""}${tokensDelta.toFixed(0)} |`
    );
    output.push("");
  }

  console.log(output.join("\n"));
};

main();
```

### Regression Check Script

```typescript
// apps/experiments/scripts/check-regression.ts

import { readFileSync } from "fs";
import { loadBaseline } from "../src/baseline.js";

const CACHE_RATE_THRESHOLD = 0.05;  // 5% regression allowed
const TOKEN_THRESHOLD = 0.10;       // 10% increase allowed

const main = async () => {
  const resultsPath = process.argv[2];
  const results = JSON.parse(readFileSync(resultsPath, "utf-8"));

  const scenarios = ["counter-dashboard", "todo-app"];
  let hasRegression = false;

  for (const scenario of scenarios) {
    const baseline = await loadBaseline(scenario);
    const current = results[scenario];

    const cacheRateDelta = current.averageCacheRate - baseline.averageCacheRate;
    const tokensRatio = current.averageTokens / baseline.averageTokens;

    if (cacheRateDelta < -CACHE_RATE_THRESHOLD) {
      console.error(`❌ ${scenario}: Cache rate regressed by ${(-cacheRateDelta * 100).toFixed(1)}%`);
      hasRegression = true;
    }

    if (tokensRatio > 1 + TOKEN_THRESHOLD) {
      console.error(`❌ ${scenario}: Token usage increased by ${((tokensRatio - 1) * 100).toFixed(1)}%`);
      hasRegression = true;
    }
  }

  if (hasRegression) {
    process.exit(1);
  }

  console.log("✅ No significant regressions detected");
};

main();
```

### PR Comment Example

When the workflow runs, it posts a comment like:

```markdown
## 📊 Cache Rate Benchmark

### counter-dashboard

| Metric | Baseline | Current | Delta |
|--------|----------|---------|-------|
| Cache Rate | 31.2% | 58.7% | ✅ +27.5% |
| Avg Tokens | 2450 | 2100 | ✅ -350 |

### todo-app

| Metric | Baseline | Current | Delta |
|--------|----------|---------|-------|
| Cache Rate | 28.5% | 55.2% | ✅ +26.7% |
| Avg Tokens | 1890 | 1650 | ✅ -240 |
```

---

## Part 5: Updating Baselines

When you intentionally improve caching (or accept a regression), update baselines:

```bash
# Run benchmark and update baseline
cd apps/experiments
pnpm run benchmark:update

# Or manually
pnpm run benchmark --json > results.json
pnpm run baseline:save results.json

# Commit the updated baseline
git add baselines/
git commit -m "chore: update cache benchmark baseline"
```

### Script for Updating

```typescript
// apps/experiments/scripts/update-baseline.ts

import { readFileSync } from "fs";
import { saveBaseline } from "../src/baseline.js";

const main = async () => {
  const resultsPath = process.argv[2] || "results.json";
  const results = JSON.parse(readFileSync(resultsPath, "utf-8"));

  for (const [scenario, data] of Object.entries(results)) {
    await saveBaseline(scenario, data as any);
    console.log(`✅ Updated baseline for ${scenario}`);
  }
};

main();
```

---

## Part 6: Visualization (Optional)

### Trend Chart in Terminal

```typescript
// apps/experiments/scripts/show-history.ts

import { readFileSync } from "fs";
import { join } from "path";

const historyPath = join(import.meta.dirname, "../baselines/history.json");
const history = JSON.parse(readFileSync(historyPath, "utf-8"));

const counterHistory = history.filter((h: any) => h.scenario === "counter-dashboard");

console.log("\n📈 Cache Rate Trend (counter-dashboard)\n");
console.log("Date       | Commit  | Cache Rate");
console.log("-----------|---------|------------");

for (const entry of counterHistory.slice(-10)) {
  const date = entry.timestamp.split("T")[0];
  const rate = (entry.averageCacheRate * 100).toFixed(1).padStart(5);
  const bar = "█".repeat(Math.round(entry.averageCacheRate * 30));

  console.log(`${date} | ${entry.gitCommit} | ${rate}% ${bar}`);
}
```

Output:

```
📈 Cache Rate Trend (counter-dashboard)

Date       | Commit  | Cache Rate
-----------|---------|------------
2026-01-20 | abc1234 | 28.5% █████████
2026-01-22 | def5678 | 30.1% █████████
2026-01-25 | ghi9012 | 31.2% █████████
2026-01-28 | jkl3456 | 45.6% ██████████████
2026-01-30 | mno7890 | 58.7% ██████████████████
```

---

## Summary: What Gets Committed

```
apps/experiments/
├── baselines/
│   ├── counter-dashboard.json    # ✅ Committed (baseline)
│   ├── todo-app.json             # ✅ Committed (baseline)
│   └── history.json              # ✅ Committed (trend tracking)
├── results/
│   └── *.json                    # ❌ .gitignored (temp results)
├── src/                          # ✅ Committed (benchmark code)
└── scripts/                      # ✅ Committed (CI scripts)

.github/workflows/
└── cache-benchmark.yml           # ✅ Committed (CI config)
```

---

## Future Extensions

1. **Real embedding comparison** - Use actual embedding model to test semantic search stability
2. **A/B in production** - Add feature flag to test strategies with real users
3. **Cost modeling** - Calculate actual $ savings based on Groq/Anthropic pricing
4. **Latency simulation** - Model expected latency improvements from caching
5. **Dashboard** - Build a simple web UI to visualize trends over time
6. **Slack/Discord alerts** - Notify on significant regressions
