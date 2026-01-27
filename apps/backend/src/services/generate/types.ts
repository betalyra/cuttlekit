import { z } from "zod";

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
    mode: z.enum(["patches", "full"]),
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
