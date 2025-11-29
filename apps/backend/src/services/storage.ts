import { KeyValueStore } from "@effect/platform";
import { PlatformError } from "@effect/platform/Error";
import { DateTime, Effect, Option, Schema, Data } from "effect";

// Effect Schema definitions
const StoredMessageSchema = Schema.Struct({
  role: Schema.Literal("user", "assistant"),
  content: Schema.String,
  timestamp: Schema.Number,
  embedding: Schema.optional(Schema.Array(Schema.Number)),
});

const SessionDataSchema = Schema.Struct({
  messages: Schema.Array(StoredMessageSchema),
  summary: Schema.optional(Schema.String),
  facts: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown })
  ),
  meta: Schema.optional(
    Schema.Struct({
      lastCompaction: Schema.optional(Schema.Number),
      totalTokensEstimate: Schema.optional(Schema.Number),
      messageCount: Schema.optional(Schema.Number),
    })
  ),
});

export type StoredMessage = typeof StoredMessageSchema.Type;
export type SessionData = typeof SessionDataSchema.Type;

export class StorageParseError extends Data.TaggedError("StorageParseError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const SESSION_PREFIX = "session:";

const sessionKey = (sessionId: string) => `${SESSION_PREFIX}${sessionId}`;

const decodeSessionData = Schema.decodeUnknown(SessionDataSchema);

const parseSessionData = (value: string) =>
  Effect.try({
    try: () => JSON.parse(value),
    catch: (error) =>
      new StorageParseError({
        message: "Failed to parse JSON",
        cause: error,
      }),
  }).pipe(
    Effect.flatMap((parsed) =>
      decodeSessionData(parsed).pipe(
        Effect.mapError(
          (error) =>
            new StorageParseError({
              message: "Invalid session data schema",
              cause: error,
            })
        )
      )
    )
  );

export class StorageService extends Effect.Service<StorageService>()(
  "StorageService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;

      const getSession = (
        sessionId: string
      ): Effect.Effect<
        Option.Option<SessionData>,
        PlatformError | StorageParseError
      > =>
        Effect.gen(function* () {
          const result = yield* kv.get(sessionKey(sessionId));
          return yield* Option.match(result, {
            onNone: () => Effect.succeed(Option.none()),
            onSome: (value) =>
              parseSessionData(value).pipe(Effect.map(Option.some)),
          });
        });

      const setSession = (
        sessionId: string,
        data: SessionData
      ): Effect.Effect<void, PlatformError> =>
        kv.set(sessionKey(sessionId), JSON.stringify(data));

      const deleteSession = (
        sessionId: string
      ): Effect.Effect<void, PlatformError> => kv.remove(sessionKey(sessionId));

      const updateSession = (
        sessionId: string,
        updater: (data: SessionData) => SessionData
      ): Effect.Effect<void, PlatformError | StorageParseError> =>
        Effect.gen(function* () {
          const existing = yield* getSession(sessionId);
          const current = Option.getOrElse(existing, () => ({ messages: [] }));
          const updated = updater(current);
          yield* setSession(sessionId, updated);
        });

      const addMessage = (
        sessionId: string,
        message: StoredMessage
      ): Effect.Effect<void, PlatformError | StorageParseError> =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const timestamp = DateTime.toEpochMillis(now);
          yield* updateSession(sessionId, (data) => ({
            ...data,
            messages: [...data.messages, { ...message, timestamp }],
            meta: {
              ...data.meta,
              messageCount:
                (data.meta?.messageCount ?? data.messages.length) + 1,
            },
          }));
        });

      const getMessages = (
        sessionId: string
      ): Effect.Effect<
        readonly StoredMessage[],
        PlatformError | StorageParseError
      > =>
        Effect.gen(function* () {
          const data = yield* getSession(sessionId);
          return Option.match(data, {
            onNone: () => [],
            onSome: (session) => session.messages,
          });
        });

      const setSummary = (
        sessionId: string,
        summary: string
      ): Effect.Effect<void, PlatformError | StorageParseError> =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const timestamp = DateTime.toEpochMillis(now);
          yield* updateSession(sessionId, (data) => ({
            ...data,
            summary,
            meta: {
              ...data.meta,
              lastCompaction: timestamp,
            },
          }));
        });

      const compactMessages = (
        sessionId: string,
        keepRecent: number,
        summary: string
      ): Effect.Effect<void, PlatformError | StorageParseError> =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const timestamp = DateTime.toEpochMillis(now);
          yield* updateSession(sessionId, (data) => ({
            ...data,
            messages: data.messages.slice(-keepRecent),
            summary,
            meta: {
              ...data.meta,
              lastCompaction: timestamp,
            },
          }));
        });

      return {
        getSession,
        setSession,
        deleteSession,
        updateSession,
        addMessage,
        getMessages,
        setSummary,
        compactMessages,
      };
    }),
  }
) {}
