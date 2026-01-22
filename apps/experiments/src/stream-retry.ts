/**
 * Stream Retry Experiment
 *
 * Demonstrates how to use Stream.catchAll for seamless error recovery
 * without consuming/blocking the stream.
 *
 * The key insight: catchAll lets valid items flow through, then switches
 * to a recovery stream on error - the consumer sees one continuous stream.
 */

import { NodeRuntime } from "@effect/platform-node";
import { Data, Effect, pipe, Stream } from "effect";

// ============================================================
// Error Types
// ============================================================

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly token: string;
  readonly reason: string;
}> {}

export class MaxRetriesExceeded extends Data.TaggedError("MaxRetriesExceeded")<{
  readonly attempts: number;
}> {}

// ============================================================
// Configuration
// ============================================================

export type RetryConfig = {
  readonly maxAttempts: number;
  readonly failingTokens: ReadonlyMap<number, Set<string>>; // attempt -> tokens that fail
};

// ============================================================
// Mock Token Stream
// ============================================================

/**
 * Simulates an LLM token stream with optional latency
 */
export const mockTokenStream = (
  tokens: readonly string[],
  delayMs = 10
): Stream.Stream<string, never> =>
  pipe(
    Stream.fromIterable(tokens),
    Stream.tap(() => Effect.sleep(`${delayMs} millis`))
  );

// ============================================================
// Validation
// ============================================================

/**
 * Validates a token, failing with ValidationError if it's in the failing set
 */
export const validateToken = (
  token: string,
  attemptIndex: number,
  failingTokens: ReadonlyMap<number, Set<string>>
): Effect.Effect<string, ValidationError> =>
  Effect.gen(function* () {
    const failSet = failingTokens.get(attemptIndex);
    if (failSet?.has(token)) {
      return yield* new ValidationError({
        token,
        reason: `Token "${token}" failed validation on attempt ${attemptIndex}`,
      });
    }
    return token;
  });

// ============================================================
// Stream with Retry (the core pattern!)
// ============================================================

/**
 * Creates a stream that validates tokens and retries on failure.
 *
 * Key insight: Stream.catchAll lets valid items flow through to downstream
 * BEFORE the error occurs. When validation fails:
 * 1. All valid tokens have already been emitted
 * 2. catchAll intercepts the error
 * 3. A new retry stream continues seamlessly
 *
 * The consumer sees ONE continuous stream of valid tokens.
 */
export const createStreamWithRetry = (
  getTokensForAttempt: (attempt: number) => readonly string[],
  config: RetryConfig,
  attemptIndex = 0
): Stream.Stream<string, MaxRetriesExceeded> => {
  // Base case: max retries exceeded
  if (attemptIndex >= config.maxAttempts) {
    return Stream.fail(new MaxRetriesExceeded({ attempts: attemptIndex }));
  }

  const tokens = getTokensForAttempt(attemptIndex);

  return pipe(
    // Create token stream for this attempt
    mockTokenStream(tokens, 5),

    // Log each token as it's processed (before validation)
    Stream.tap((token) =>
      Effect.log(`[Attempt ${attemptIndex}] Processing: "${token}"`)
    ),

    // Validate each token - this can FAIL with ValidationError
    Stream.mapEffect((token) =>
      validateToken(token, attemptIndex, config.failingTokens)
    ),

    // Log successful validations
    Stream.tap((token) =>
      Effect.log(`[Attempt ${attemptIndex}] Emitting valid: "${token}"`)
    ),

    // THE KEY: catchAll intercepts errors and continues with retry stream
    Stream.catchAll((error: ValidationError) =>
      pipe(
        // Log the retry
        Stream.fromEffect(
          Effect.log(
            `[Attempt ${attemptIndex}] FAILED on "${error.token}", retrying...`
          )
        ),
        // Drain the log effect (produces no values)
        Stream.drain,
        // Continue with the next attempt
        Stream.concat(
          createStreamWithRetry(getTokensForAttempt, config, attemptIndex + 1)
        )
      )
    )
  );
};

// ============================================================
// Demo Scenarios
// ============================================================

/**
 * Scenario 1: Happy path - all tokens valid
 */
export const runHappyPath = () => {
  const tokens = ["token1", "token2", "token3"];
  const config: RetryConfig = {
    maxAttempts: 3,
    failingTokens: new Map(), // Nothing fails
  };

  return pipe(
    createStreamWithRetry(() => tokens, config),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk))
  );
};

/**
 * Scenario 2: Single retry - fails mid-stream, retry succeeds
 *
 * Attempt 0: token1, token2, FAIL on token3
 * Attempt 1: token1, token2, token3 (all succeed)
 *
 * Expected output: [token1, token2, token1, token2, token3]
 */
export const runSingleRetry = () => {
  const tokens = ["token1", "token2", "token3"];
  const config: RetryConfig = {
    maxAttempts: 3,
    failingTokens: new Map([
      [0, new Set(["token3"])], // token3 fails on attempt 0
    ]),
  };

  return pipe(
    createStreamWithRetry(() => tokens, config),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk))
  );
};

/**
 * Scenario 3: Multiple retries with different failing tokens
 *
 * Attempt 0: token1, FAIL on token2
 * Attempt 1: token1, token2, FAIL on token3
 * Attempt 2: token1, token2, token3 (all succeed)
 *
 * Expected output: [token1, token1, token2, token1, token2, token3]
 */
export const runMultipleRetries = () => {
  const tokens = ["token1", "token2", "token3"];
  const config: RetryConfig = {
    maxAttempts: 3,
    failingTokens: new Map([
      [0, new Set(["token2"])], // token2 fails on attempt 0
      [1, new Set(["token3"])], // token3 fails on attempt 1
    ]),
  };

  return pipe(
    createStreamWithRetry(() => tokens, config),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk))
  );
};

/**
 * Scenario 4: Max retries exceeded
 *
 * Attempt 0: FAIL on token1
 * Attempt 1: FAIL on token1
 * Attempt 2: FAIL on token1
 * -> MaxRetriesExceeded error
 */
export const runMaxRetriesExceeded = () => {
  const tokens = ["token1", "token2", "token3"];
  const config: RetryConfig = {
    maxAttempts: 3,
    failingTokens: new Map([
      [0, new Set(["token1"])],
      [1, new Set(["token1"])],
      [2, new Set(["token1"])],
    ]),
  };

  return pipe(
    createStreamWithRetry(() => tokens, config),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("MaxRetriesExceeded", (e) =>
      Effect.succeed([`ERROR: Max retries (${e.attempts}) exceeded`])
    )
  );
};

// ============================================================
// Main Program
// ============================================================

const program = Effect.gen(function* () {
  yield* Effect.log("=== Stream Retry Experiment ===\n");

  yield* Effect.log("--- Scenario 1: Happy Path ---");
  const result1 = yield* runHappyPath();
  yield* Effect.log(`Result: [${result1.join(", ")}]\n`);

  yield* Effect.log("--- Scenario 2: Single Retry ---");
  const result2 = yield* runSingleRetry();
  yield* Effect.log(`Result: [${result2.join(", ")}]\n`);

  yield* Effect.log("--- Scenario 3: Multiple Retries ---");
  const result3 = yield* runMultipleRetries();
  yield* Effect.log(`Result: [${result3.join(", ")}]\n`);

  yield* Effect.log("--- Scenario 4: Max Retries Exceeded ---");
  const result4 = yield* runMaxRetriesExceeded();
  yield* Effect.log(`Result: [${result4.join(", ")}]\n`);

  yield* Effect.log("=== Experiment Complete ===");
});

// Run with NodeRuntime
NodeRuntime.runMain(program);
