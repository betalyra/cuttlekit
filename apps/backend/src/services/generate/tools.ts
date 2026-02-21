import { Effect, Option, Runtime, DateTime, Duration } from "effect";
import { tool, stepCountIs } from "ai";
import { z } from "zod";
import { DocSearchService } from "../doc-search/service.js";
import { SandboxService } from "../sandbox/service.js";
import type { SandboxContext } from "../sandbox/manager.js";
import { SandboxError } from "../sandbox/types.js";
import type { SandboxHandle } from "../sandbox/types.js";

// ============================================================
// Types
// ============================================================

export type ToolContext = {
  readonly sessionId: string;
  readonly sandboxCtx: SandboxContext;
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
      const { manager: sandboxOption } = yield* SandboxService;

      // ----------------------------------------------------------
      // search_docs tool factory
      // ----------------------------------------------------------

      const makeSearchDocsTool = (ctx: ToolContext) =>
        tool({
          description:
            "Search SDK documentation. Always call this BEFORE writing code to understand the API.",
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
            const program = docSearch.search(query, { package: pkg });
            return Runtime.runPromise(ctx.runtime)(program);
          },
        });

      // ----------------------------------------------------------
      // Shared: get sandbox handle
      // ----------------------------------------------------------

      const withSandbox = (
        ctx: ToolContext,
      ): Effect.Effect<SandboxHandle, SandboxError> =>
        Effect.gen(function* () {
          if (Option.isNone(sandboxOption)) {
            return yield* new SandboxError({ message: "Sandbox not configured" });
          }

          const manager = sandboxOption.value;
          return yield* manager.getOrCreateSandbox(ctx.sessionId, ctx.sandboxCtx);
        });

      // ----------------------------------------------------------
      // run_code
      // ----------------------------------------------------------

      const makeRunCodeTool = (ctx: ToolContext) =>
        tool({
          description: "Execute TypeScript in the sandbox REPL. Variables/imports persist across calls. Last expression is the return value.",
          inputSchema: z.object({
            code: z.string().describe("TypeScript code to execute"),
            description: z.string().describe("What this code does"),
          }),
          execute: async ({ code, description }) => {
            const program = Effect.gen(function* () {
              const startTime = yield* DateTime.now;
              yield* Effect.logDebug("run_code:start", { description, codePreview: code.slice(0, 300) });

              const handle = yield* withSandbox(ctx);
              const result = yield* handle.eval(code);

              const elapsed = Duration.toMillis(DateTime.distanceDuration(startTime, yield* DateTime.now));
              yield* Effect.logDebug("run_code:done", { description, elapsed: `${elapsed}ms`, success: result.success });
              return result;
            }).pipe(
              Effect.catchAll(() =>
                Effect.succeed({ success: false as const, error: "Sandbox not configured", stdout: "" }),
              ),
            );
            return Runtime.runPromise(ctx.runtime)(program);
          },
        });

      // ----------------------------------------------------------
      // write_file
      // ----------------------------------------------------------

      const makeWriteFileTool = (ctx: ToolContext) =>
        tool({
          description: "Write a file to the sandbox filesystem.",
          inputSchema: z.object({
            path: z.string().describe("Absolute path, e.g. /home/user/lib/client.ts"),
            content: z.string().describe("File content"),
          }),
          execute: async ({ path, content }) => {
            const program = Effect.gen(function* () {
              const handle = yield* withSandbox(ctx);
              yield* handle.writeTextFile(path, content);
              return { success: true as const, path };
            }).pipe(
              Effect.catchAll((e) => Effect.succeed({ success: false as const, error: String(e) })),
            );
            return Runtime.runPromise(ctx.runtime)(program);
          },
        });

      // ----------------------------------------------------------
      // read_file
      // ----------------------------------------------------------

      const makeReadFileTool = (ctx: ToolContext) =>
        tool({
          description: "Read a file from the sandbox filesystem.",
          inputSchema: z.object({
            path: z.string().describe("Absolute path, e.g. /home/user/lib/client.ts"),
          }),
          execute: async ({ path }) => {
            const program = Effect.gen(function* () {
              const handle = yield* withSandbox(ctx);
              const content = yield* handle.readTextFile(path);
              return { success: true as const, content };
            }).pipe(
              Effect.catchAll((e) => Effect.succeed({ success: false as const, error: String(e), content: "" })),
            );
            return Runtime.runPromise(ctx.runtime)(program);
          },
        });

      // ----------------------------------------------------------
      // sh
      // ----------------------------------------------------------

      const makeShTool = (ctx: ToolContext) =>
        tool({
          description: "Run a shell command in the sandbox.",
          inputSchema: z.object({
            command: z.string().describe("Shell command, e.g. 'ls -la'"),
          }),
          execute: async ({ command }) => {
            const program = Effect.gen(function* () {
              const handle = yield* withSandbox(ctx);
              const result = yield* handle.sh(command);
              return { success: true as const, ...result };
            }).pipe(
              Effect.catchAll((e) => Effect.succeed({ success: false as const, error: String(e), stdout: "", stderr: "", exitCode: -1 })),
            );
            return Runtime.runPromise(ctx.runtime)(program);
          },
        });

      // ----------------------------------------------------------
      // Public API
      // ----------------------------------------------------------

      const makeTools = (ctx: ToolContext) => ({
        search_docs: makeSearchDocsTool(ctx),
        run_code: makeRunCodeTool(ctx),
        write_file: makeWriteFileTool(ctx),
        read_file: makeReadFileTool(ctx),
        sh: makeShTool(ctx),
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
