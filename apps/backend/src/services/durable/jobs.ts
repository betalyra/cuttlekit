import { Effect, Option, Schedule, Duration, pipe } from "effect";
import { ProcessorRegistry } from "./registry.js";
import { DurableEventLog } from "./event-log.js";
import { DurableConfig } from "./types.js";

export const dormancyChecker = Effect.gen(function* () {
  const registry = yield* ProcessorRegistry;

  yield* pipe(
    Effect.gen(function* () {
      const now = Date.now();
      const sessionIds = yield* registry.getAllSessionIds;

      yield* Effect.forEach(sessionIds, (sessionId) =>
        Effect.gen(function* () {
          const lastActivity = yield* registry.getLastActivity(sessionId);
          if (
            Option.isSome(lastActivity) &&
            now - lastActivity.value > DurableConfig.DORMANCY_TIMEOUT_MS
          ) {
            yield* registry.release(sessionId);
          }
        })
      );
    }),
    Effect.catchAll((error) =>
      Effect.log(`Dormancy checker error: ${error}`)
    ),
    Effect.repeat(
      Schedule.spaced(Duration.millis(DurableConfig.DORMANCY_CHECK_INTERVAL_MS))
    )
  );
});

export const eventCleanup = Effect.gen(function* () {
  const eventLog = yield* DurableEventLog;

  yield* pipe(
    Effect.gen(function* () {
      const deleted = yield* eventLog.cleanup;
      if (deleted > 0) yield* Effect.log(`Cleaned up ${deleted} old events`);
    }),
    Effect.catchAll((error) =>
      Effect.log(`Event cleanup error: ${error}`)
    ),
    Effect.repeat(
      Schedule.spaced(Duration.millis(DurableConfig.CLEANUP_INTERVAL_MS))
    )
  );
});
