import { Schema } from "effect";
import type { Queue, PubSub, Ref, Fiber, Scope } from "effect";
import { ActionDataSchema } from "@cuttlekit/common/client";
import type { Action, StreamEventWithOffset } from "@cuttlekit/common/client";
import type { SandboxContext } from "../sandbox/manager.js";

// Re-export shared types so existing imports keep working
export {
  ActionSchema,
  ActionDataSchema,
  ActionDataValueSchema,
  PromptActionSchema,
  UiActionSchema,
  type Action,
  type ActionData,
  type PromptAction,
  type UiAction,
  SessionEventSchema,
  DefineEventSchema,
  PatchEventSchema,
  HtmlEventSchema,
  StatsEventSchema,
  DoneEventSchema,
  StreamEventSchema,
  type StreamEvent,
  type StreamEventWithOffset,
} from "@cuttlekit/common/client";

// ============================================================
// Action Payload Schema (for POST endpoint body — mirrors ActionSchema)
// ============================================================

export const PromptPayloadSchema = Schema.Struct({
  type: Schema.Literal("prompt"),
  prompt: Schema.String,
  model: Schema.optional(Schema.String),
});

export const UiActionPayloadSchema = Schema.Struct({
  type: Schema.Literal("action"),
  action: Schema.String,
  actionData: Schema.optional(ActionDataSchema),
  elementId: Schema.optional(Schema.String),
  elementTag: Schema.optional(Schema.String),
  hostId: Schema.optional(Schema.String),
  hostTag: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
});

export const ActionPayloadSchema = Schema.Union(
  PromptPayloadSchema,
  UiActionPayloadSchema,
);

export type ActionPayload = typeof ActionPayloadSchema.Type;

// ============================================================
// Processor State (runtime, not serialized)
// ============================================================

export type SessionProcessor = {
  readonly sessionId: string;
  readonly userId: string;
  readonly actionQueue: Queue.Queue<Action>;
  readonly eventPubSub: PubSub.PubSub<StreamEventWithOffset>;
  readonly lastActivity: Ref.Ref<number>;
  readonly sandboxCtx: SandboxContext;
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
