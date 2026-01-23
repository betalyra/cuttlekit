import { describe, expect, it } from "@effect/vitest";
import { Effect, Stream, Layer, Chunk } from "effect";
import { MockLanguageModelV3 } from "ai/test";
import { simulateReadableStream } from "ai";
import { GenerateService } from "./service.js";
import { TestLanguageModelLayer } from "@betalyra/generative-ui-common/server";
import { PatchValidator } from "../vdom/index.js";
import { MemoryService } from "../memory/index.js";

const createMockModel = (chunks: string[]) =>
  new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs: 5,
        chunks: [
          ...chunks.map((text, i) => ({
            type: "text-delta" as const,
            id: `chunk-${i}`,
            delta: text,
          })),
          {
            type: "finish" as const,
            finishReason: {
              unified: "stop" as const,
              raw: "stop",
            },
            usage: {
              inputTokens: {
                total: 100,
                noCache: 100,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: {
                total: 50,
                text: 50,
                reasoning: undefined,
              },
            },
          },
        ],
      }),
      rawCall: { rawPrompt: null, rawSettings: {} },
    }),
  });

const MockMemoryLayer = Layer.succeed(MemoryService, {
  getRecent: () => Effect.succeed([]),
  search: () => Effect.succeed([]),
  saveMemory: () => Effect.void,
  describePatch: () => "",
  describePatches: () => "",
} as unknown as MemoryService);

const createTestLayer = (mockModel: ReturnType<typeof createMockModel>) =>
  GenerateService.Default.pipe(
    Layer.provide(TestLanguageModelLayer(mockModel)),
    Layer.provide(MockMemoryLayer),
    Layer.provide(PatchValidator.Default)
  );

describe("GenerateService", () => {
  describe("streamUnified", () => {
    it.effect("streams valid patches immediately", () =>
      Effect.gen(function* () {
        const service = yield* GenerateService;
        const stream = yield* service.streamUnified({
          sessionId: "test",
          currentHtml: '<div id="app">old</div>',
          prompt: "Say hello",
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
          prompt: "Create app",
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
          prompt: "Update both",
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
});
