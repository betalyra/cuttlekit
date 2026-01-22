import { describe, expect, it } from "@effect/vitest";
import { Chunk, Effect, pipe, Stream } from "effect";
import {
  createStreamWithRetry,
  MaxRetriesExceeded,
  type RetryConfig,
} from "./stream-retry.js";

describe("stream-retry", () => {
  describe("createStreamWithRetry", () => {
    it("happy path - emits all tokens when no failures", () =>
      Effect.gen(function* () {
        const tokens = ["a", "b", "c"];
        const config: RetryConfig = {
          maxAttempts: 3,
          failingTokens: new Map(),
        };

        const result = yield* pipe(
          createStreamWithRetry(() => tokens, config),
          Stream.runCollect
        );

        expect(Array.from(result)).toEqual(["a", "b", "c"]);
      }));

    it("single retry - emits valid tokens before failure, then retries", () =>
      Effect.gen(function* () {
        const tokens = ["a", "b", "c"];
        const config: RetryConfig = {
          maxAttempts: 3,
          failingTokens: new Map([
            [0, new Set(["c"])], // "c" fails on attempt 0
          ]),
        };

        const result = yield* pipe(
          createStreamWithRetry(() => tokens, config),
          Stream.runCollect
        );

        // Attempt 0: a, b emitted, c fails
        // Attempt 1: a, b, c all succeed
        expect(Array.from(result)).toEqual(["a", "b", "a", "b", "c"]);
      }));

    it("multiple retries - chains valid tokens from all attempts", () =>
      Effect.gen(function* () {
        const tokens = ["a", "b", "c"];
        const config: RetryConfig = {
          maxAttempts: 3,
          failingTokens: new Map([
            [0, new Set(["b"])], // "b" fails on attempt 0
            [1, new Set(["c"])], // "c" fails on attempt 1
          ]),
        };

        const result = yield* pipe(
          createStreamWithRetry(() => tokens, config),
          Stream.runCollect
        );

        // Attempt 0: a emitted, b fails
        // Attempt 1: a, b emitted, c fails
        // Attempt 2: a, b, c all succeed
        expect(Array.from(result)).toEqual(["a", "a", "b", "a", "b", "c"]);
      }));

    it("max retries exceeded - fails with MaxRetriesExceeded", () =>
      Effect.gen(function* () {
        const tokens = ["a", "b", "c"];
        const config: RetryConfig = {
          maxAttempts: 2,
          failingTokens: new Map([
            [0, new Set(["a"])], // "a" fails on attempt 0
            [1, new Set(["a"])], // "a" fails on attempt 1
          ]),
        };

        const result = yield* pipe(
          createStreamWithRetry(() => tokens, config),
          Stream.runCollect,
          Effect.either
        );

        expect(result._tag).toBe("Left");
        if (result._tag === "Left") {
          expect(result.left._tag).toBe("MaxRetriesExceeded");
          expect((result.left as MaxRetriesExceeded).attempts).toBe(2);
        }
      }));

    it("different tokens per attempt - each attempt gets fresh tokens", () =>
      Effect.gen(function* () {
        const tokensByAttempt = [
          ["x1", "x2", "x3"],
          ["y1", "y2", "y3"],
          ["z1", "z2", "z3"],
        ];
        const config: RetryConfig = {
          maxAttempts: 3,
          failingTokens: new Map([
            [0, new Set(["x3"])], // x3 fails on attempt 0
            [1, new Set(["y2"])], // y2 fails on attempt 1
          ]),
        };

        const result = yield* pipe(
          createStreamWithRetry(
            (attempt) => tokensByAttempt[attempt] ?? [],
            config
          ),
          Stream.runCollect
        );

        // Attempt 0: x1, x2 emitted, x3 fails
        // Attempt 1: y1 emitted, y2 fails
        // Attempt 2: z1, z2, z3 all succeed
        expect(Array.from(result)).toEqual([
          "x1",
          "x2",
          "y1",
          "z1",
          "z2",
          "z3",
        ]);
      }));

    it("first token fails - immediately retries", () =>
      Effect.gen(function* () {
        const tokens = ["a", "b"];
        const config: RetryConfig = {
          maxAttempts: 2,
          failingTokens: new Map([
            [0, new Set(["a"])], // "a" fails on attempt 0
          ]),
        };

        const result = yield* pipe(
          createStreamWithRetry(() => tokens, config),
          Stream.runCollect
        );

        // Attempt 0: a fails immediately (nothing emitted)
        // Attempt 1: a, b succeed
        expect(Array.from(result)).toEqual(["a", "b"]);
      }));

    it("empty token stream - completes immediately", () =>
      Effect.gen(function* () {
        const config: RetryConfig = {
          maxAttempts: 3,
          failingTokens: new Map(),
        };

        const result = yield* pipe(
          createStreamWithRetry(() => [], config),
          Stream.runCollect
        );

        expect(Array.from(result)).toEqual([]);
      }));

    it("streaming behavior - tokens emit incrementally (not batched)", () =>
      Effect.gen(function* () {
        const emissionOrder: string[] = [];
        const tokens = ["a", "b", "c"];
        const config: RetryConfig = {
          maxAttempts: 3,
          failingTokens: new Map([
            [0, new Set(["c"])], // "c" fails on attempt 0
          ]),
        };

        yield* pipe(
          createStreamWithRetry(() => tokens, config),
          Stream.tap((token) =>
            Effect.sync(() => {
              emissionOrder.push(token);
            })
          ),
          Stream.runDrain
        );

        // Verify order: attempt 0 tokens, then attempt 1 tokens
        expect(emissionOrder).toEqual(["a", "b", "a", "b", "c"]);
      }));

    it("preserves chunk boundaries for performance", () =>
      Effect.gen(function* () {
        const tokens = ["a", "b", "c"];
        const config: RetryConfig = {
          maxAttempts: 3,
          failingTokens: new Map(),
        };

        const chunks: Chunk.Chunk<string>[] = [];

        yield* pipe(
          createStreamWithRetry(() => tokens, config),
          Stream.mapChunks((chunk) => {
            chunks.push(chunk);
            return chunk;
          }),
          Stream.runDrain
        );

        // Each token should be in its own chunk (since we emit one at a time)
        expect(chunks.length).toBeGreaterThanOrEqual(3);
      }));
  });
});
