import { KeyValueStore } from "@effect/platform";
import { PlatformError } from "@effect/platform/Error";
import { DateTime, Effect, Option, Schema, Data, pipe } from "effect";

// Prompt schema - user descriptions of what to create/change
const StoredPromptSchema = Schema.Struct({
  content: Schema.String,
  timestamp: Schema.Number,
  embedding: Schema.optional(Schema.Array(Schema.Number)),
});

// Action schema - user interactions with the UI
const StoredActionSchema = Schema.Struct({
  action: Schema.String,
  data: Schema.optional(Schema.Unknown),
  timestamp: Schema.Number,
});

// Prompt list schema
const PromptListSchema = Schema.Struct({
  prompts: Schema.Array(StoredPromptSchema),
  summary: Schema.optional(Schema.String),
});

// Action list schema
const ActionListSchema = Schema.Struct({
  actions: Schema.Array(StoredActionSchema),
  summary: Schema.optional(Schema.String),
});

export type StoredPrompt = typeof StoredPromptSchema.Type;
export type StoredAction = typeof StoredActionSchema.Type;
export type PromptList = typeof PromptListSchema.Type;
export type ActionList = typeof ActionListSchema.Type;

export class StorageParseError extends Data.TaggedError("StorageParseError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// Key prefixes for separate storage
const PROMPTS_PREFIX = "prompts:";
const ACTIONS_PREFIX = "actions:";

const promptsKey = (sessionId: string) => `${PROMPTS_PREFIX}${sessionId}`;
const actionsKey = (sessionId: string) => `${ACTIONS_PREFIX}${sessionId}`;

const decodePromptList = Schema.decodeUnknown(PromptListSchema);
const decodeActionList = Schema.decodeUnknown(ActionListSchema);

const parseJson = <T>(value: string, decoder: (v: unknown) => Effect.Effect<T, unknown>) =>
  pipe(
    Effect.try({
      try: () => JSON.parse(value),
      catch: (error) =>
        new StorageParseError({
          message: "Failed to parse JSON",
          cause: error,
        }),
    }),
    Effect.flatMap((parsed) =>
      decoder(parsed).pipe(
        Effect.mapError(
          (error) =>
            new StorageParseError({
              message: "Invalid schema",
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

      // ============ PROMPTS ============

      const getPrompts = (
        sessionId: string
      ): Effect.Effect<PromptList, PlatformError | StorageParseError> =>
        Effect.gen(function* () {
          const result = yield* kv.get(promptsKey(sessionId));
          return yield* Option.match(result, {
            onNone: () => Effect.succeed({ prompts: [] }),
            onSome: (value) => parseJson(value, decodePromptList),
          });
        });

      const getRecentPrompts = (
        sessionId: string,
        count: number
      ): Effect.Effect<readonly StoredPrompt[], PlatformError | StorageParseError> =>
        Effect.gen(function* () {
          const data = yield* getPrompts(sessionId);
          return data.prompts.slice(-count);
        });

      const addPrompt = (
        sessionId: string,
        content: string
      ): Effect.Effect<void, PlatformError | StorageParseError> =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const timestamp = DateTime.toEpochMillis(now);
          const data = yield* getPrompts(sessionId);
          const updated: PromptList = {
            ...data,
            prompts: [...data.prompts, { content, timestamp }],
          };
          yield* kv.set(promptsKey(sessionId), JSON.stringify(updated));
        });

      const setPromptSummary = (
        sessionId: string,
        summary: string,
        keepRecent: number
      ): Effect.Effect<void, PlatformError | StorageParseError> =>
        Effect.gen(function* () {
          const data = yield* getPrompts(sessionId);
          const updated: PromptList = {
            prompts: data.prompts.slice(-keepRecent),
            summary,
          };
          yield* kv.set(promptsKey(sessionId), JSON.stringify(updated));
        });

      // ============ ACTIONS ============

      const getActions = (
        sessionId: string
      ): Effect.Effect<ActionList, PlatformError | StorageParseError> =>
        Effect.gen(function* () {
          const result = yield* kv.get(actionsKey(sessionId));
          return yield* Option.match(result, {
            onNone: () => Effect.succeed({ actions: [] }),
            onSome: (value) => parseJson(value, decodeActionList),
          });
        });

      const getRecentActions = (
        sessionId: string,
        count: number
      ): Effect.Effect<readonly StoredAction[], PlatformError | StorageParseError> =>
        Effect.gen(function* () {
          const data = yield* getActions(sessionId);
          return data.actions.slice(-count);
        });

      const addAction = (
        sessionId: string,
        action: string,
        data?: unknown
      ): Effect.Effect<void, PlatformError | StorageParseError> =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const timestamp = DateTime.toEpochMillis(now);
          const existing = yield* getActions(sessionId);
          const updated: ActionList = {
            ...existing,
            actions: [...existing.actions, { action, data, timestamp }],
          };
          yield* kv.set(actionsKey(sessionId), JSON.stringify(updated));
        });

      const setActionSummary = (
        sessionId: string,
        summary: string,
        keepRecent: number
      ): Effect.Effect<void, PlatformError | StorageParseError> =>
        Effect.gen(function* () {
          const data = yield* getActions(sessionId);
          const updated: ActionList = {
            actions: data.actions.slice(-keepRecent),
            summary,
          };
          yield* kv.set(actionsKey(sessionId), JSON.stringify(updated));
        });

      // ============ SESSION MANAGEMENT ============

      const deleteSession = (
        sessionId: string
      ): Effect.Effect<void, PlatformError> =>
        Effect.all([
          kv.remove(promptsKey(sessionId)),
          kv.remove(actionsKey(sessionId)),
        ]).pipe(Effect.asVoid);

      return {
        // Prompts
        getPrompts,
        getRecentPrompts,
        addPrompt,
        setPromptSummary,
        // Actions
        getActions,
        getRecentActions,
        addAction,
        setActionSummary,
        // Session
        deleteSession,
      };
    }),
  }
) {}
