import { Schema } from "effect";
import type { Queue, PubSub, Ref, Fiber, Scope } from "effect";

// ============================================================
// Action Schema (submitted via POST /stream/:sessionId)
// ============================================================

export const ActionSchema = Schema.Struct({
  type: Schema.Literal("prompt", "action"),
  prompt: Schema.optional(Schema.String),
  action: Schema.optional(Schema.String),
  actionData: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
  currentHtml: Schema.optional(Schema.String),
});

export type Action = typeof ActionSchema.Type;

// ============================================================
// Stream Event Schema (emitted to subscribers via GET SSE)
// ============================================================

export const PatchEventSchema = Schema.Struct({
  type: Schema.Literal("patch"),
  patch: Schema.Unknown, // Patch type from vdom -- validated elsewhere
});

export const HtmlEventSchema = Schema.Struct({
  type: Schema.Literal("html"),
  html: Schema.String,
});

export const StatsEventSchema = Schema.Struct({
  type: Schema.Literal("stats"),
  cacheRate: Schema.Number,
  tokensPerSecond: Schema.Number,
  mode: Schema.Literal("patches", "full"),
  patchCount: Schema.Number,
});

export const DoneEventSchema = Schema.Struct({
  type: Schema.Literal("done"),
  html: Schema.String,
});

export const SessionEventSchema = Schema.Struct({
  type: Schema.Literal("session"),
  sessionId: Schema.String,
});

export const StreamEventSchema = Schema.Union(
  SessionEventSchema,
  PatchEventSchema,
  HtmlEventSchema,
  StatsEventSchema,
  DoneEventSchema,
);

export type StreamEvent = typeof StreamEventSchema.Type;

export type StreamEventWithOffset = StreamEvent & { readonly offset: number };

// ============================================================
// Action Payload Schema (for POST endpoint body)
// ============================================================

export const ActionPayloadSchema = Schema.Struct({
  prompt: Schema.optional(Schema.String),
  action: Schema.optional(Schema.String),
  actionData: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
  currentHtml: Schema.optional(Schema.String),
});

export type ActionPayload = typeof ActionPayloadSchema.Type;

// ============================================================
// Processor State (runtime, not serialized)
// ============================================================

export type SessionProcessor = {
  readonly sessionId: string;
  readonly actionQueue: Queue.Queue<Action>;
  readonly eventPubSub: PubSub.PubSub<StreamEventWithOffset>;
  readonly lastActivity: Ref.Ref<number>;
  readonly fiber: Fiber.RuntimeFiber<void, never>;
  readonly scope: Scope.CloseableScope;
};

// ============================================================
// Configuration
// ============================================================

export const DurableConfig = {
  EVENT_RETENTION_MS: 10 * 60 * 1000, // 10 minutes
  DORMANCY_TIMEOUT_MS: 5 * 60 * 1000, // 5 minutes
  DORMANCY_CHECK_INTERVAL_MS: 60 * 1000, // 1 minute
  CLEANUP_INTERVAL_MS: 60 * 1000, // 1 minute
  MAX_BATCH_SIZE: 10,
} as const;
