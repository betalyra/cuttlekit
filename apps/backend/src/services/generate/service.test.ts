import { describe, expect, it } from "@effect/vitest";
import { Effect, Stream, Layer, Chunk, Option, Ref } from "effect";
import { MockLanguageModelV3 } from "ai/test";
import { simulateReadableStream } from "ai";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { GenerateService } from "./service.js";
import { PromptLogger } from "./prompt-logger.js";
import { TestLanguageModelLayer } from "@betalyra/generative-ui-common/server";
import { PatchValidator } from "../vdom/index.js";
import { MemoryService } from "../memory/index.js";
import { ModelRegistry } from "../model-registry.js";
import { ToolService } from "./tools.js";
import { DocSearchService } from "../doc-search/service.js";
import { SandboxService } from "../sandbox/service.js";
import type { SandboxHandle } from "../sandbox/types.js";
import type { SandboxManagerInstance, ManagedSandbox, SandboxContext } from "../sandbox/manager.js";
import type { SandboxConfig } from "../app-config.js";

// ============================================================
// Shared mock helpers
// ============================================================

const mockUsage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 50, text: 50, reasoning: undefined },
};

const finishStop = {
  type: "finish" as const,
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: mockUsage,
};

const finishToolCalls = {
  type: "finish" as const,
  finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
  usage: mockUsage,
};

const textDelta = (text: string, id = "t-0") => ({
  type: "text-delta" as const,
  id,
  delta: text,
});

const toolCall = (toolName: string, input: Record<string, unknown>, id = "call-1") => ({
  type: "tool-call" as const,
  toolCallId: id,
  toolName,
  input: JSON.stringify(input),
});

const makeStream = (chunks: LanguageModelV3StreamPart[]) =>
  simulateReadableStream({ chunkDelayInMs: 5, chunks });

// ============================================================
// Text-only mock model (existing tests)
// ============================================================

const createMockModel = (chunks: string[]) =>
  new MockLanguageModelV3({
    doStream: async () => ({
      stream: makeStream([
        ...chunks.map((text, i) => textDelta(text, `chunk-${i}`)),
        finishStop,
      ]),
      rawCall: { rawPrompt: null, rawSettings: {} },
    }),
  });

// ============================================================
// Mock layers — shared across all tests
// ============================================================

const MockMemoryLayer = Layer.succeed(MemoryService, {
  getRecent: () => Effect.succeed([]),
  search: () => Effect.succeed([]),
  saveMemory: () => Effect.void,
  describePatch: () => "",
  describePatches: () => "",
} as unknown as MemoryService);

const MockPromptLoggerLayer = Layer.succeed(PromptLogger, {
  logMessages: () => Effect.void,
} as unknown as PromptLogger);

const MockModelRegistryLayer = Layer.succeed(ModelRegistry, {
  resolve: () => Effect.fail(new Error("not configured")),
  availableModels: () => [],
  defaultModelId: "test",
} as unknown as ModelRegistry);

// ============================================================
// Mock ToolService (no tools — for text-only tests)
// ============================================================

const MockToolServiceLayer = Layer.succeed(ToolService, {
  makeTools: () => ({}),
  listPackages: () => [],
  listPackageInfo: () => [],
} as unknown as ToolService);

// ============================================================
// Test layer builders
// ============================================================

const createTestLayer = (mockModel: ReturnType<typeof createMockModel>) =>
  GenerateService.Default.pipe(
    Layer.provide(TestLanguageModelLayer(mockModel)),
    Layer.provide(MockMemoryLayer),
    Layer.provide(PatchValidator.Default),
    Layer.provide(MockPromptLoggerLayer),
    Layer.provide(MockModelRegistryLayer),
    Layer.provide(MockToolServiceLayer),
  );

// ============================================================
// Mock services for tool integration tests
// ============================================================

const mockSandboxConfig: SandboxConfig = {
  provider: "deno",
  mode: "lazy",
  region: "ord",
  useSnapshots: true,
  snapshotCapacityMb: 10000,
  volumeCapacityMb: 5000,
  timeoutSeconds: 30,
  memoryMb: 512,
  dependencies: [{ package: "@linear/sdk", docs: [], secretEnv: undefined, secretValue: undefined, hosts: [] }],
};

const makeMockSandboxHandle = (
  evalResult: { success: true; result: unknown; stdout: string } | { success: false; error: string; stdout: string } = {
    success: true,
    result: [{ id: "ISS-1", title: "Fix bug" }],
    stdout: "",
  },
): SandboxHandle => ({
  initRepl: () => Effect.void,
  eval: () => Effect.succeed(evalResult),
  writeTextFile: () => Effect.void,
  readTextFile: () => Effect.succeed(""),
  sh: () => Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }),
});

const makeMockManager = (handle: SandboxHandle): SandboxManagerInstance => ({
  ensureSnapshot: Effect.succeed(Option.some({ slug: "snap-test" })),
  getOrCreateSandbox: (_sessionId, ctx: SandboxContext) =>
    Effect.gen(function* () {
      const existing = yield* Ref.get(ctx.ref);
      if (Option.isSome(existing)) return existing.value.handle;
      yield* Ref.set(ctx.ref, Option.some({ handle, scope: {} } as ManagedSandbox));
      return handle;
    }),
  releaseSandbox: (ctx: SandboxContext) => Ref.set(ctx.ref, Option.none()),
  config: mockSandboxConfig,
});

type CallLog = Array<{ method: string; args: unknown[] }>;

const makeMockDocSearchLayer = (callLog: CallLog) =>
  Layer.succeed(DocSearchService, {
    search: (query: string, options?: Record<string, unknown>) => {
      callLog.push({ method: "search", args: [query, options] });
      return Effect.succeed([
        { type: "doc" as const, heading: "Issues API", content: "linearClient.issues()", package: "@linear/sdk" },
      ]);
    },
    listPackages: () => ["@linear/sdk"],
    listPackageInfo: () => [{ package: "@linear/sdk", envVar: "LINEAR_API_KEY" }],
  } as unknown as DocSearchService);

const makeMockSandboxServiceLayer = (manager: SandboxManagerInstance | null) =>
  Layer.succeed(SandboxService, {
    manager: manager ? Option.some(manager) : Option.none(),
  } as unknown as SandboxService);

const createToolTestLayer = (
  mockModel: MockLanguageModelV3,
  callLog: CallLog,
  manager: SandboxManagerInstance | null,
) =>
  GenerateService.Default.pipe(
    Layer.provide(TestLanguageModelLayer(mockModel)),
    Layer.provide(MockMemoryLayer),
    Layer.provide(PatchValidator.Default),
    Layer.provide(MockPromptLoggerLayer),
    Layer.provide(MockModelRegistryLayer),
    Layer.provide(
      ToolService.Default.pipe(
        Layer.provide(makeMockDocSearchLayer(callLog)),
        Layer.provide(makeMockSandboxServiceLayer(manager)),
      ),
    ),
  );

// ============================================================
// Tests
// ============================================================

describe("GenerateService", () => {
  describe("streamUnified — text only", () => {
    it.effect("streams valid patches immediately", () =>
      Effect.gen(function* () {
        const service = yield* GenerateService;
        const stream = yield* service.streamUnified({
          sessionId: "test",
          currentHtml: '<div id="app">old</div>',
          actions: [{ type: "prompt", prompt: "Say hello" }],
        });

        const results = yield* Stream.runCollect(stream);
        const items = Chunk.toArray(results);

        expect(items.length).toBe(2); // patches + stats
        expect(items[0]).toEqual({
          type: "patches",
          patches: [{ selector: "#app", text: "Hello" }],
        });
        expect(items[1].type).toBe("stats");
      }).pipe(Effect.provide(createTestLayer(createMockModel([
        '{"type":"patches","patches":[{"selector":"#app","text":"Hello"}]}\n',
      ]))))
    );

    it.effect("handles full HTML response", () =>
      Effect.gen(function* () {
        const service = yield* GenerateService;
        const stream = yield* service.streamUnified({
          sessionId: "test",
          actions: [{ type: "prompt", prompt: "Create app" }],
        });

        const results = yield* Stream.runCollect(stream);
        const items = Chunk.toArray(results);

        expect(items[0]).toEqual({
          type: "full",
          html: "<div id='app'>New content</div>",
        });
      }).pipe(Effect.provide(createTestLayer(createMockModel([
        `{"type":"full","html":"<div id='app'>New content</div>"}\n`,
      ]))))
    );

    it.effect("streams multiple patch batches", () =>
      Effect.gen(function* () {
        const service = yield* GenerateService;
        const stream = yield* service.streamUnified({
          sessionId: "test",
          currentHtml: '<div id="a">old</div><div id="b">old</div>',
          actions: [{ type: "prompt", prompt: "Update both" }],
        });

        const results = yield* Stream.runCollect(stream);
        const items = Chunk.toArray(results);

        expect(items.length).toBe(3); // 2 patches + stats
        expect(items[0].type).toBe("patches");
        expect(items[1].type).toBe("patches");
        expect(items[2].type).toBe("stats");
      }).pipe(Effect.provide(createTestLayer(createMockModel([
        '{"type":"patches","patches":[{"selector":"#a","text":"A"}]}\n',
        '{"type":"patches","patches":[{"selector":"#b","text":"B"}]}\n',
      ]))))
    );
  });

  describe("streamUnified — tool call flow", () => {
    it.effect("search_docs → run_code → patches", () =>
      Effect.gen(function* () {
        const callLog: CallLog = [];
        const handle = makeMockSandboxHandle();
        const manager = makeMockManager(handle);

        const model = new MockLanguageModelV3({
          doStream: async function () {
            const step = model.doStreamCalls.length;
            if (step === 1) {
              // Step 0: LLM calls search_docs
              return {
                stream: makeStream([
                  toolCall("search_docs", { query: "linear issues" }),
                  finishToolCalls,
                ]),
                rawCall: { rawPrompt: null, rawSettings: {} },
              };
            } else if (step === 2) {
              // Step 1: LLM calls run_code
              return {
                stream: makeStream([
                  toolCall("run_code", { code: "linearClient.issues()", description: "fetch issues" }, "call-2"),
                  finishToolCalls,
                ]),
                rawCall: { rawPrompt: null, rawSettings: {} },
              };
            } else {
              // Step 2: LLM emits patches
              return {
                stream: makeStream([
                  textDelta('{"type":"patches","patches":[{"selector":"#app","html":"<table><tr><td>ISS-1</td></tr></table>"}]}\n'),
                  finishStop,
                ]),
                rawCall: { rawPrompt: null, rawSettings: {} },
              };
            }
          },
        });

        const layer = createToolTestLayer(model, callLog, manager);

        const items = yield* Effect.gen(function* () {
          const service = yield* GenerateService;
          const stream = yield* service.streamUnified({
            sessionId: "test-session",
            currentHtml: '<div id="app">loading...</div>',
            actions: [{ type: "prompt", prompt: "Show my Linear issues" }],
          });
          return yield* Stream.runCollect(stream).pipe(Effect.map(Chunk.toArray));
        }).pipe(Effect.provide(layer));

        // 3 steps were executed
        expect(model.doStreamCalls.length).toBe(3);

        // Stream produced patches + stats
        expect(items.some((i) => i.type === "patches")).toBe(true);
        expect(items.some((i) => i.type === "stats")).toBe(true);

        // search_docs was called
        expect(callLog.some((c) => c.method === "search")).toBe(true);
      })
    );

    it.effect("sandbox disabled — run_code returns error, LLM adapts", () =>
      Effect.gen(function* () {
        const callLog: CallLog = [];

        const model = new MockLanguageModelV3({
          doStream: async function () {
            const step = model.doStreamCalls.length;
            if (step === 1) {
              // Step 0: search_docs (works without sandbox)
              return {
                stream: makeStream([
                  toolCall("search_docs", { query: "linear issues" }),
                  finishToolCalls,
                ]),
                rawCall: { rawPrompt: null, rawSettings: {} },
              };
            } else if (step === 2) {
              // Step 1: run_code (will get "Sandbox not configured")
              return {
                stream: makeStream([
                  toolCall("run_code", { code: "...", description: "fetch" }, "call-2"),
                  finishToolCalls,
                ]),
                rawCall: { rawPrompt: null, rawSettings: {} },
              };
            } else {
              // Step 2: LLM adapts with fallback UI
              return {
                stream: makeStream([
                  textDelta('{"type":"patches","patches":[{"selector":"#app","text":"Code execution is not available"}]}\n'),
                  finishStop,
                ]),
                rawCall: { rawPrompt: null, rawSettings: {} },
              };
            }
          },
        });

        // Sandbox disabled (Option.none)
        const layer = createToolTestLayer(model, callLog, null);

        const items = yield* Effect.gen(function* () {
          const service = yield* GenerateService;
          const stream = yield* service.streamUnified({
            sessionId: "test-session",
            currentHtml: '<div id="app">loading...</div>',
            actions: [{ type: "prompt", prompt: "Show my Linear issues" }],
          });
          return yield* Stream.runCollect(stream).pipe(Effect.map(Chunk.toArray));
        }).pipe(Effect.provide(layer));

        // All 3 steps executed
        expect(model.doStreamCalls.length).toBe(3);

        // Stream still completes with patches
        expect(items.some((i) => i.type === "patches")).toBe(true);
        expect(items.some((i) => i.type === "stats")).toBe(true);
      })
    );
  });
});
