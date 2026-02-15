/**
 * Shared stream protocol types for the generative UI engine.
 * Used by both frontend (browser) and backend (Effect services).
 */
import { Schema } from "effect";
import type { Patch } from "./patch.js";

// ============================================================
// Action — submitted by the client, processed by the backend
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
// Stream Events — emitted over SSE from backend to client
// ============================================================

export const SessionEventSchema = Schema.Struct({
  type: Schema.Literal("session"),
  sessionId: Schema.String,
});

export const PatchEventSchema = Schema.Struct({
  type: Schema.Literal("patch"),
  patch: Schema.Unknown, // Patch type validated elsewhere
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

export const StreamEventSchema = Schema.Union(
  SessionEventSchema,
  PatchEventSchema,
  HtmlEventSchema,
  StatsEventSchema,
  DoneEventSchema,
);

export type StreamEvent = typeof StreamEventSchema.Type;

export type StreamEventWithOffset = StreamEvent & {
  readonly offset: number;
};

// ============================================================
// Typed stream event helpers (for frontend consumption)
// ============================================================

export type SessionEvent = typeof SessionEventSchema.Type & {
  offset: number;
};
export type PatchStreamEvent = typeof PatchEventSchema.Type & {
  patch: Patch;
  offset: number;
};
export type HtmlEvent = typeof HtmlEventSchema.Type & { offset: number };
export type StatsEvent = typeof StatsEventSchema.Type & { offset: number };
export type DoneEvent = typeof DoneEventSchema.Type & { offset: number };
