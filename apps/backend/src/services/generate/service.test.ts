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
import { StoreService } from "../memory/store.js";
import { ModelRegistry } from "../model-registry.js";
import { ToolService } from "./tools.js";
import { DocSearchService } from "../doc-search/service.js";
import { SandboxService } from "../sandbox/service.js";
import type { SandboxHandle } from "../sandbox/types.js";
import type { SandboxManagerInstance, ManagedSandbox } from "../sandbox/manager.js";
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
  enabled: true,
  provider: "deno",
  mode: "lazy",
  region: "ord",
  volumeTtlMinutes: 60,
  volumeCapacityMb: 256,
  snapshotCapacityMb: 10000,
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
  eval: () => Effect.succeed(evalResult),
});

const makeMockManager = (handle: SandboxHandle): SandboxManagerInstance => ({
  ensureSnapshot: Effect.succeed({ slug: "snap-test" }),
  getOrCreateSandbox: (_sessionId, sandboxRef, _volumeSlug) =>
    Effect.gen(function* () {
      // Simulate caching in the ref like the real manager does
      const existing = yield* Ref.get(sandboxRef);
      if (Option.isSome(existing)) return existing.value.handle;
      yield* Ref.set(sandboxRef, Option.some({ handle, scope: {} } as ManagedSandbox));
      return handle;
    }),
  releaseSandbox: (sandboxRef) => Ref.set(sandboxRef, Option.none()),
  volumeExists: () => Effect.succeed(true),
  createVolume: (sessionId) => Effect.succeed(`genui-session-${sessionId}`),
  deleteVolume: () => Effect.void,
  config: mockSandboxConfig,
});

type CallLog = Array<{ method: string; args: unknown[] }>;

const makeMockStoreLayer = (callLog: CallLog) => {
  let volumeRegistered = false;

  return Layer.succeed(StoreService, {
    getSessionVolume: (sessionId: string) => {
      callLog.push({ method: "getSessionVolume", args: [sessionId] });
      // After registerVolume is called, return the volume
      return Effect.succeed(
        volumeRegistered
          ? { sessionId, volumeSlug: `genui-session-${sessionId}`, region: "ord", createdAt: Date.now(), lastAccessedAt: Date.now() }
          : null,
      );
    },
    registerVolume: (sessionId: string, slug: string, region: string) => {
      callLog.push({ method: "registerVolume", args: [sessionId, slug, region] });
      volumeRegistered = true;
      return Effect.void;
    },
    touchVolume: (sessionId: string) => {
      callLog.push({ method: "touchVolume", args: [sessionId] });
      return Effect.void;
    },
    deleteVolumeRegistry: (sessionId: string) => {
      callLog.push({ method: "deleteVolumeRegistry", args: [sessionId] });
      return Effect.void;
    },
  } as unknown as StoreService);
};

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
    upsertCodeModule: () => Effect.void,
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
        Layer.provide(makeMockStoreLayer(callLog)),
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

        // Volume was created (getSessionVolume returned null → createVolume → registerVolume)
        expect(callLog.some((c) => c.method === "registerVolume")).toBe(true);
        expect(callLog.some((c) => c.method === "touchVolume")).toBe(true);
      })
    );

    it.effect("search_docs → run_code → code_modules + patches", () =>
      Effect.gen(function* () {
        const callLog: CallLog = [];
        const handle = makeMockSandboxHandle();
        const manager = makeMockManager(handle);

        const model = new MockLanguageModelV3({
          doStream: async function () {
            const step = model.doStreamCalls.length;
            if (step === 1) {
              return {
                stream: makeStream([
                  toolCall("search_docs", { query: "linear issues" }),
                  finishToolCalls,
                ]),
                rawCall: { rawPrompt: null, rawSettings: {} },
              };
            } else if (step === 2) {
              return {
                stream: makeStream([
                  toolCall("run_code", { code: "Deno.writeTextFile('lib/linear.ts', '...')", description: "save module" }, "call-2"),
                  finishToolCalls,
                ]),
                rawCall: { rawPrompt: null, rawSettings: {} },
              };
            } else {
              // Step 2: code_modules + patches
              return {
                stream: makeStream([
                  textDelta('{"type":"code_modules","modules":[{"path":"lib/linear.ts","description":"Linear API wrapper","exports":["getIssues"],"usage":"import { getIssues } from \'./lib/linear.ts\'"}]}\n', "t-0"),
                  textDelta('{"type":"patches","patches":[{"selector":"#app","html":"<ul><li>ISS-1: Fix bug</li></ul>"}]}\n', "t-1"),
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

        // Both code_modules and patches appear in stream
        expect(items.some((i) => i.type === "code_modules")).toBe(true);
        expect(items.some((i) => i.type === "patches")).toBe(true);
        expect(items.some((i) => i.type === "stats")).toBe(true);
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

        // No volume operations attempted
        expect(callLog.some((c) => c.method === "registerVolume")).toBe(false);
      })
    );

    it.effect("stale volume is cleaned up during search_docs", () =>
      Effect.gen(function* () {
        const callLog: CallLog = [];
        const handle = makeMockSandboxHandle();
        const staleManager: SandboxManagerInstance = {
          ...makeMockManager(handle),
          volumeExists: () => Effect.succeed(false), // Volume is stale
        };

        // Override store to always return a stale volume entry
        const staleStoreLayer = Layer.succeed(StoreService, {
          getSessionVolume: (sessionId: string) => {
            callLog.push({ method: "getSessionVolume", args: [sessionId] });
            return Effect.succeed({
              sessionId,
              volumeSlug: "old-stale-vol",
              region: "ord",
              createdAt: Date.now(),
              lastAccessedAt: Date.now(),
            });
          },
          registerVolume: (_sid: string, _slug: string, _region: string) => Effect.void,
          touchVolume: () => Effect.void,
          deleteVolumeRegistry: (sessionId: string) => {
            callLog.push({ method: "deleteVolumeRegistry", args: [sessionId] });
            return Effect.void;
          },
        } as unknown as StoreService);

        const model = new MockLanguageModelV3({
          doStream: async function () {
            const step = model.doStreamCalls.length;
            if (step === 1) {
              return {
                stream: makeStream([
                  toolCall("search_docs", { query: "linear" }),
                  finishToolCalls,
                ]),
                rawCall: { rawPrompt: null, rawSettings: {} },
              };
            } else {
              return {
                stream: makeStream([
                  textDelta('{"type":"patches","patches":[{"selector":"#app","text":"Done"}]}\n'),
                  finishStop,
                ]),
                rawCall: { rawPrompt: null, rawSettings: {} },
              };
            }
          },
        });

        const layer = GenerateService.Default.pipe(
          Layer.provide(TestLanguageModelLayer(model)),
          Layer.provide(MockMemoryLayer),
          Layer.provide(PatchValidator.Default),
          Layer.provide(MockPromptLoggerLayer),
          Layer.provide(MockModelRegistryLayer),
          Layer.provide(
            ToolService.Default.pipe(
              Layer.provide(makeMockDocSearchLayer(callLog)),
              Layer.provide(staleStoreLayer),
              Layer.provide(makeMockSandboxServiceLayer(staleManager)),
            ),
          ),
        );

        const items = yield* Effect.gen(function* () {
          const service = yield* GenerateService;
          const stream = yield* service.streamUnified({
            sessionId: "test-session",
            currentHtml: '<div id="app">old</div>',
            actions: [{ type: "prompt", prompt: "Search docs" }],
          });
          return yield* Stream.runCollect(stream).pipe(Effect.map(Chunk.toArray));
        }).pipe(Effect.provide(layer));

        // Stale volume was cleaned up
        expect(callLog.some((c) => c.method === "deleteVolumeRegistry")).toBe(true);

        // Stream still completed
        expect(items.some((i) => i.type === "patches")).toBe(true);
      })
    );
  });
});
