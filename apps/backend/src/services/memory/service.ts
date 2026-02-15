import { Effect, Match, Queue } from "effect";
import { embed, generateText, Output } from "ai";
import { z } from "zod";
import type { Patch } from "@betalyra/generative-ui-common/client";
import {
  LanguageModelProvider,
  EmbeddingModelProvider,
} from "@betalyra/generative-ui-common/server";
import type { UserPrompt, UserAction } from "../../types/messages.js";
import { StoreService } from "./store.js";

// ============================================================
// Types
// ============================================================

export type MemoryChange =
  | { type: "patches"; patches: Patch[] }
  | { type: "full"; html: string };

export type MemoryOperation = {
  sessionId: string;
  prompts?: UserPrompt[];
  actions?: UserAction[];
  change: MemoryChange;
};

export type MemorySearchResult = {
  id: number;
  sessionId: string;
  prompts: string | null;
  promptSummary: string | null;
  actions: string | null;
  actionSummary: string | null;
  changeSummary: string;
  patchCount: number;
  createdAt: number;
  distance?: number;
};

// ============================================================
// Internal Schema for LLM Summary Generation
// ============================================================

const MemorySummariesSchema = z.object({
  promptSummary: z
    .string()
    .nullable()
    .describe("Summary of user prompts in one sentence, or null if no prompts"),
  actionSummary: z
    .string()
    .nullable()
    .describe("Summary of user actions in one sentence, or null if no actions"),
  changeSummary: z
    .string()
    .describe(
      "1-2 sentence summary of what changed visually/functionally, not technical details",
    ),
});

// ============================================================
// Patch Description
// ============================================================

const describePatch = (patch: Patch): string =>
  Match.value(patch).pipe(
    Match.when({ selector: Match.string, text: Match.string }, (p) => {
      const text = p.text;
      return `Set text in ${p.selector} to "${text.slice(0, 50)}${text.length > 50 ? "..." : ""}"`;
    }),
    Match.when(
      { selector: Match.string, attr: Match.defined },
      (p) =>
        `Updated attributes on ${p.selector}: ${Object.keys(p.attr).join(", ")}`,
    ),
    Match.when(
      { selector: Match.string, html: Match.string },
      (p) => `Replaced HTML in ${p.selector}`,
    ),
    Match.when(
      { selector: Match.string, append: Match.string },
      (p) => `Appended content to ${p.selector}`,
    ),
    Match.when(
      { selector: Match.string, prepend: Match.string },
      (p) => `Prepended content to ${p.selector}`,
    ),
    Match.when(
      { selector: Match.string, remove: Match.boolean },
      (p) => `Removed ${p.selector}`,
    ),
    Match.exhaustive,
  );

const describePatches = (patches: readonly Patch[]): string =>
  patches.map(describePatch).join("\n");

const describeChange = (change: MemoryChange): string =>
  Match.value(change).pipe(
    Match.when(
      { type: "patches" },
      (c) => `Patches applied:\n${describePatches(c.patches)}`,
    ),
    Match.when(
      { type: "full" },
      (c) => `Complete UI regeneration with new HTML:\n${c.html}`,
    ),
    Match.exhaustive,
  );

const getPatchCount = (change: MemoryChange): number =>
  change.type === "patches" ? change.patches.length : 1;

// ============================================================
// Memory Service
// ============================================================

export class MemoryService extends Effect.Service<MemoryService>()(
  "MemoryService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const store = yield* StoreService;
      const { model: languageModel } = yield* LanguageModelProvider;
      const { model: embeddingModel, providerOptions } =
        yield* EmbeddingModelProvider;

      // Queue for async memory operations
      const queue = yield* Queue.unbounded<MemoryOperation>();

      // ============================================================
      // Generate All Summaries at Once
      // ============================================================

      const generateSummaries = (op: MemoryOperation) =>
        Effect.gen(function* () {
          const changeDescription = describeChange(op.change);

          const promptContext = op.prompts?.length
            ? `User prompts:\n${op.prompts.map((p, i) => `${i + 1}. "${p}"`).join("\n")}`
            : "No user prompts.";

          const actionContext = op.actions?.length
            ? `User actions:\n${op.actions.map((a, i) => `${i + 1}. ${a.action}${a.data ? ` (data: ${JSON.stringify(a.data)})` : ""}`).join("\n")}`
            : "No user actions.";

          const prompt = `Analyze these UI changes and generate summaries.

${promptContext}

${actionContext}

${changeDescription}

Generate:
1. promptSummary: If there are prompts, summarize them in one sentence. Otherwise null.
2. actionSummary: If there are actions, summarize them in one sentence. Otherwise null.
3. changeSummary: Describe what changed visually/functionally in 1-2 sentences.`;

          const result = yield* Effect.promise(() =>
            generateText({
              model: languageModel,
              output: Output.object({
                schema: MemorySummariesSchema,
              }),
              prompt,
            }),
          );

          return yield* Effect.fromNullable(result.output);
        });

      // ============================================================
      // Process a Memory Operation
      // ============================================================

      const processOperation = (op: MemoryOperation) =>
        Effect.gen(function* () {
          yield* Effect.log("Processing memory operation", {
            sessionId: op.sessionId,
            promptCount: op.prompts?.length ?? 0,
            actionCount: op.actions?.length ?? 0,
            changeType: op.change.type,
            patchCount: getPatchCount(op.change),
          });

          // 1. Generate all summaries at once using LLM
          const { promptSummary, actionSummary, changeSummary } =
            yield* generateSummaries(op);

          // 2. Build text for embedding
          const inputDescription = promptSummary
            ? `User: ${promptSummary}`
            : actionSummary
              ? `Action: ${actionSummary}`
              : "Unknown input";
          const textToEmbed = `${inputDescription}. Changes: ${changeSummary}`;

          // 3. Generate embedding
          const { embedding } = yield* Effect.promise(() =>
            embed({
              model: embeddingModel,
              value: textToEmbed,
              providerOptions,
            }),
          );

          // 4. Store in database
          yield* store.insertMemoryEntry({
            sessionId: op.sessionId,
            prompts: op.prompts ? JSON.stringify(op.prompts) : null,
            promptSummary,
            actions: op.actions ? JSON.stringify(op.actions) : null,
            actionSummary,
            changeSummary,
            patchCount: getPatchCount(op.change),
            embedding,
            createdAt: Date.now(),
          });

          // 5. Update session last accessed
          yield* store.updateSessionLastAccessed(op.sessionId);

          yield* Effect.log("Memory operation completed", {
            sessionId: op.sessionId,
            changeSummary,
          });
        });

      // ============================================================
      // Background Queue Processor
      // ============================================================

      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            const operation = yield* Queue.take(queue);
            yield* processOperation(operation).pipe(
              Effect.catchAllCause((cause) =>
                Effect.logError("Memory operation failed", {
                  cause: cause.toString(),
                  sessionId: operation.sessionId,
                }),
              ),
            );
          }),
        ),
      );

      yield* Effect.log("MemoryService initialized with background queue");

      // ============================================================
      // Public API
      // ============================================================

      const saveMemory = (op: MemoryOperation) =>
        Effect.gen(function* () {
          // Skip if patches change type with no patches
          if (op.change.type === "patches" && op.change.patches.length === 0) {
            yield* Effect.log("Skipping memory save - no changes");
            return;
          }
          yield* Queue.offer(queue, op);
          yield* Effect.log("Memory operation enqueued", {
            sessionId: op.sessionId,
            changeType: op.change.type,
          });
        });

      const search = (
        sessionId: string,
        query: string,
        limit: number,
      ): Effect.Effect<MemorySearchResult[]> =>
        Effect.gen(function* () {
          const { embedding } = yield* Effect.promise(() =>
            embed({ model: embeddingModel, value: query, providerOptions }),
          );
          return yield* store.searchByVector(sessionId, embedding, limit);
        });

      const getRecent = (
        sessionId: string,
        count: number,
      ): Effect.Effect<MemorySearchResult[]> =>
        store.getRecentEntries(sessionId, count).pipe(
          Effect.map((entries) =>
            entries.map((e) => ({
              id: e.id,
              sessionId: e.sessionId,
              prompts: e.prompts as string | null,
              promptSummary: e.promptSummary,
              actions: e.actions as string | null,
              actionSummary: e.actionSummary,
              changeSummary: e.changeSummary,
              patchCount: e.patchCount,
              createdAt: e.createdAt,
            })),
          ),
        );

      return {
        saveMemory,
        search,
        getRecent,
        describePatch,
        describePatches,
      };
    }),
  },
) {}
