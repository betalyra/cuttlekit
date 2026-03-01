import { Schema } from "effect";
import type { Queue, PubSub, Ref, Fiber, Scope } from "effect";
import type { Action, StreamEventWithOffset } from "@cuttlekit/common/client";
import type { SandboxContext } from "../sandbox/manager.js";

// Re-export shared types so existing imports keep working
export {
  ActionSchema,
  type Action,
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
// Action Payload Schema (for POST endpoint body — no `type` field)
// ============================================================

export const ActionPayloadSchema = Schema.Struct({
  prompt: Schema.optional(Schema.String),
  action: Schema.optional(Schema.String),
  actionData: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
  model: Schema.optional(Schema.String),
});

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
