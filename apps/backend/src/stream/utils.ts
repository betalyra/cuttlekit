import { Stream, pipe } from "effect";

/**
 * Accumulate streaming tokens into complete JSON lines.
 * Tokens may arrive split across line boundaries, so we buffer
 * until we see a newline character.
 *
 * Uses mapAccum to maintain state and mapConcat to flatten output.
 */
export const accumulateLines = <E>(
  tokenStream: Stream.Stream<string, E>
): Stream.Stream<string, E> =>
  pipe(
    tokenStream,
    // mapAccum maintains state (buffer) across stream elements
    // Returns [newState, outputChunk] for each input
    Stream.mapAccum("", (buffer, token: string) => {
      const combined = buffer + token;
      const lines = combined.split("\n");

      // Last element is incomplete (no trailing newline) - keep as buffer
      const newBuffer = lines.pop() ?? "";

      // All other elements are complete lines
      return [newBuffer, lines];
    }),
    // Flatten the arrays of lines into individual stream elements
    Stream.mapConcat((lines) => lines),
    // Strip carriage returns (handles \r\n line endings)
    Stream.map((line) => line.replace(/\r/g, "")),
    // Filter empty lines
    Stream.filter((line) => line.trim().length > 0)
  );

/**
 * Same as accumulateLines but also flushes any remaining buffer content at stream end.
 * Use this when the stream may not end with a newline.
 */
export const accumulateLinesWithFlush = <E>(
  tokenStream: Stream.Stream<string, E>
): Stream.Stream<string, E> => {
  const streamWithFlush = pipe(tokenStream, Stream.concat(Stream.make("\n")));
  return accumulateLines(streamWithFlush);
};
