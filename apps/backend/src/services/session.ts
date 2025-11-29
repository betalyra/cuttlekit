import { DateTime, Effect, Random } from "effect";

export class SessionService extends Effect.Service<SessionService>()(
  "SessionService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const generateSessionId = () =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const timestamp = DateTime.toEpochMillis(now);
          const random = yield* Random.nextIntBetween(0, 2147483647);
          const randomStr = random.toString(36).substring(0, 7);
          return `session-${timestamp}-${randomStr}`;
        });

      return { generateSessionId };
    }),
  }
) {}
