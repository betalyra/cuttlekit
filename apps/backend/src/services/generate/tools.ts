import { Effect, Option, Runtime, DateTime, Duration } from "effect";
import { tool, stepCountIs } from "ai";
import { z } from "zod";
import { DocSearchService } from "../doc-search/service.js";
import { SandboxService, type ManagedSandboxRef } from "../sandbox/service.js";
import { StoreService } from "../memory/store.js";

// ============================================================
// Types
// ============================================================

export type ToolContext = {
  readonly sessionId: string;
  readonly sandboxRef: ManagedSandboxRef;
  readonly runtime: Runtime.Runtime<never>;
};

// ============================================================
// ToolService — builds per-request tool sets
// ============================================================

export class ToolService extends Effect.Service<ToolService>()(
  "ToolService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const docSearch = yield* DocSearchService;
      const store = yield* StoreService;
      const { manager: sandboxOption } = yield* SandboxService;

      // ----------------------------------------------------------
      // search_docs tool factory
      // ----------------------------------------------------------

      const makeSearchDocsTool = (ctx: ToolContext) =>
        tool({
          description:
            "Search SDK documentation and saved code modules. Always call this BEFORE writing code to understand the API.",
          inputSchema: z.object({
            query: z
              .string()
              .describe(
                "What to search for (e.g., 'list issues', 'send message')",
              ),
            package: z
              .string()
              .optional()
              .describe(
                "Filter to a specific package (e.g., '@linear/sdk')",
              ),
          }),
          execute: async ({ query, package: pkg }) => {
            const program = Effect.gen(function* () {
              const volumeEntry = yield* store.getSessionVolume(ctx.sessionId);
              let volumeSlug: string | undefined;

              if (volumeEntry && Option.isSome(sandboxOption)) {
                const manager = sandboxOption.value;
                const alive = yield* manager.volumeExists(
                  volumeEntry.volumeSlug,
                );
                if (alive) {
                  volumeSlug = volumeEntry.volumeSlug;
                } else {
                  yield* store.deleteVolumeRegistry(ctx.sessionId);
                  yield* Effect.log("search_docs: stale volume cleaned up");
                }
              }

              return yield* docSearch.search(query, {
                package: pkg,
                sessionId: ctx.sessionId,
                volumeSlug,
              });
            });

            return Runtime.runPromise(ctx.runtime)(program);
          },
        });

      // ----------------------------------------------------------
      // run_code tool factory
      // ----------------------------------------------------------

      const makeRunCodeTool = (ctx: ToolContext) =>
        tool({
          description:
            "Execute TypeScript/JavaScript code in the sandbox. The last expression is the return value.",
          inputSchema: z.object({
            code: z.string().describe("The TypeScript code to execute"),
            description: z
              .string()
              .describe("Brief description of what this code does"),
          }),
          execute: async ({ code, description }) => {
            const program = Effect.gen(function* () {
              if (Option.isNone(sandboxOption)) {
                return {
                  success: false as const,
                  error: "Sandbox not configured",
                  stdout: "",
                };
              }

              const manager = sandboxOption.value;
              const startTime = yield* DateTime.now;
              yield* Effect.logDebug("run_code:start", {
                description,
                codeLength: code.length,
                codePreview: code.slice(0, 300),
              });

              // Ensure session has a volume
              let volumeEntry = yield* store.getSessionVolume(ctx.sessionId);
              if (!volumeEntry) {
                yield* Effect.logDebug("run_code:creating_volume");
                const slug = yield* manager.createVolume(ctx.sessionId);
                yield* store.registerVolume(
                  ctx.sessionId,
                  slug,
                  manager.config.region,
                );
                volumeEntry = yield* store.getSessionVolume(ctx.sessionId);
                const volumeTime = yield* DateTime.now;
                yield* Effect.logDebug("run_code:volume_created", {
                  elapsed: `${Duration.toMillis(DateTime.distanceDuration(startTime, volumeTime))}ms`,
                });
              }

              const volumeSlug = volumeEntry?.volumeSlug;

              // Get or create sandbox for this session
              const handle = yield* manager.getOrCreateSandbox(
                ctx.sessionId,
                ctx.sandboxRef,
                volumeSlug,
              );

              const sandboxTime = yield* DateTime.now;
              yield* Effect.logDebug("run_code:sandbox_ready", {
                elapsed: `${Duration.toMillis(DateTime.distanceDuration(startTime, sandboxTime))}ms`,
              });

              if (volumeSlug) {
                yield* store.touchVolume(ctx.sessionId);
              }

              const result = yield* handle.eval(code);

              const endTime = yield* DateTime.now;
              yield* Effect.logDebug("run_code:done", {
                description,
                elapsed: `${Duration.toMillis(DateTime.distanceDuration(startTime, endTime))}ms`,
                success: result.success,
                resultPreview: result.success
                  ? String(result.result).slice(0, 300)
                  : result.error.slice(0, 300),
              });

              return result;
            });

            return Runtime.runPromise(ctx.runtime)(program);
          },
        });

      // ----------------------------------------------------------
      // Public API: build tools for a specific request
      // ----------------------------------------------------------

      const makeTools = (ctx: ToolContext) => ({
        search_docs: makeSearchDocsTool(ctx),
        run_code: makeRunCodeTool(ctx),
      });

      const listPackages = () => docSearch.listPackages();
      const listPackageInfo = () => docSearch.listPackageInfo();

      yield* Effect.log("ToolService initialized", {
        sandboxEnabled: Option.isSome(sandboxOption),
        packages: docSearch.listPackages(),
      });

      return { makeTools, listPackages, listPackageInfo };
    }),
  },
) {}

export type SandboxTools = ReturnType<ToolService["makeTools"]>;

export const TOOL_STEP_LIMIT = stepCountIs(10);
