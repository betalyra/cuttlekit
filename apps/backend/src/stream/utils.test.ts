import { describe, expect, it } from "@effect/vitest";
import { Effect, Stream, pipe, Chunk } from "effect";
import { accumulateLines, accumulateLinesWithFlush } from "./utils.js";

describe("accumulateLines", () => {
  it.effect("accumulates tokens split across boundaries", () =>
    Effect.gen(function* () {
      // Simulate tokens arriving in chunks that split JSON lines
      const tokens = Stream.make(
        '{"type":', // partial
        '"patches",', // partial
        '"patches":[]}', // completes first line
        "\n", // newline
        '{"type":"full",', // partial second line
        '"html":"<div>"}', // partial
        "\n" // completes second line
      );

      const result = yield* pipe(accumulateLines(tokens), Stream.runCollect);

      const lines = Chunk.toArray(result);

      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toEqual({ type: "patches", patches: [] });
      expect(JSON.parse(lines[1])).toEqual({ type: "full", html: "<div>" });
    })
  );

  it.effect("handles multiple lines in single token", () =>
    Effect.gen(function* () {
      // Sometimes multiple complete lines arrive in one chunk
      const tokens = Stream.make('{"a":1}\n{"b":2}\n{"c":3}', "\n");

      const result = yield* pipe(accumulateLines(tokens), Stream.runCollect);

      const lines = Chunk.toArray(result);

      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0])).toEqual({ a: 1 });
      expect(JSON.parse(lines[1])).toEqual({ b: 2 });
      expect(JSON.parse(lines[2])).toEqual({ c: 3 });
    })
  );

  it.effect("handles character-by-character streaming", () =>
    Effect.gen(function* () {
      // Extreme case: one character at a time
      const json = '{"x":1}\n';
      const tokens = Stream.fromIterable(json.split(""));

      const result = yield* pipe(accumulateLines(tokens), Stream.runCollect);

      const lines = Chunk.toArray(result);

      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual({ x: 1 });
    })
  );

  it.effect("handles empty tokens gracefully", () =>
    Effect.gen(function* () {
      const tokens = Stream.make(
        "",
        '{"a":1}',
        "",
        "\n",
        "",
        '{"b":2}',
        "\n",
        ""
      );

      const result = yield* pipe(accumulateLines(tokens), Stream.runCollect);

      const lines = Chunk.toArray(result);

      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toEqual({ a: 1 });
      expect(JSON.parse(lines[1])).toEqual({ b: 2 });
    })
  );

  it.effect("handles newlines embedded in values (escaped)", () =>
    Effect.gen(function* () {
      // JSON with escaped newlines in string values
      const tokens = Stream.make('{"text":"line1\\nline2"}', "\n");

      const result = yield* pipe(accumulateLines(tokens), Stream.runCollect);

      const lines = Chunk.toArray(result);

      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual({ text: "line1\nline2" });
    })
  );
});

describe("accumulateLinesWithFlush", () => {
  it.effect("flushes remaining buffer at end of stream", () =>
    Effect.gen(function* () {
      // No trailing newline - needs flush
      const tokens = Stream.make('{"final":true}');

      const result = yield* pipe(
        accumulateLinesWithFlush(tokens),
        Stream.runCollect
      );

      const lines = Chunk.toArray(result);

      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual({ final: true });
    })
  );
});
