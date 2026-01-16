import { z } from "zod";
import type { GenerationError } from "./errors.js";

// ============================================================
// Zod Schemas
// ============================================================

export const PatchSchema = z.union([
  z.object({ selector: z.string(), text: z.string() }),
  z.object({
    selector: z.string(),
    attr: z.record(z.string(), z.string().nullable()),
  }),
  z.object({ selector: z.string(), append: z.string() }),
  z.object({ selector: z.string(), prepend: z.string() }),
  z.object({ selector: z.string(), html: z.string() }),
  z.object({ selector: z.string(), remove: z.literal(true) }),
]);

export const PatchArraySchema = z.array(PatchSchema);

export const UnifiedResponseSchema = z.union([
  z.object({
    type: z.literal("patches"),
    patches: PatchArraySchema,
  }),
  z.object({
    type: z.literal("full"),
    html: z.string(),
  }),
  z.object({
    type: z.literal("stats"),
    cacheRate: z.number(),
    tokensPerSecond: z.number(),
  }),
]);

// ============================================================
// Exported Types
// ============================================================

export type UnifiedResponse = z.infer<typeof UnifiedResponseSchema>;

export type UnifiedGenerateOptions = {
  sessionId: string;
  currentHtml?: string;
  prompt?: string;
  action?: string;
  actionData?: Record<string, unknown>;
};

// ============================================================
// Retry Types - Immutable state for functional retry loop
// ============================================================

export type Message = {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
};

// Result of a single stream attempt - either success or validation failure with partial results
export type AttemptResult =
  | { readonly _tag: "Success"; readonly responses: readonly UnifiedResponse[] }
  | {
      readonly _tag: "ValidationFailed";
      readonly validResponses: readonly UnifiedResponse[];
      readonly error: GenerationError;
    };

// Stream item during processing - error as data pattern
export type StreamItemResponse = {
  readonly _tag: "Response";
  readonly response: UnifiedResponse;
  readonly collected: readonly UnifiedResponse[];
};

export type StreamItemError = {
  readonly _tag: "Error";
  readonly error: GenerationError;
  readonly collected: readonly UnifiedResponse[];
};

export type StreamItem = StreamItemResponse | StreamItemError;

// State for retry loop
export type IterateState = {
  readonly attempt: number;
  readonly messages: readonly Message[];
  readonly allResponses: readonly UnifiedResponse[];
  readonly done: boolean;
  readonly lastError?: GenerationError;
  readonly usagePromises: readonly PromiseLike<unknown>[];
};

// Usage types for token aggregation
export type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number };
};

export type AggregatedUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
};
