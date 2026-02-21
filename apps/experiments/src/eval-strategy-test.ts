/**
 * Eval Strategy Benchmark (Effect version with retries)
 *
 * Each benchmark creates a fresh sandbox per test group.
 * On ConnectionClosedError, the sandbox is recreated and the iteration retried.
 * Reports median/min/max/p95 across N iterations.
 *
 * Benchmarks:
 *   1. Fresh REPL creation
 *   2. Simple inline eval (hot path)
 *   3. Simple file-first (write + import)
 *   4. Simple subsequent request (import pre-written file)
 *   5. Complex inline eval (hot path)
 *   6. Complex file-first sequential (write 2 files + import)
 *   7. Complex file-first parallel (write 2 files || + import)
 *   8. Complex subsequent request (import pre-written files)
 *   9-11. Isolated file write benchmarks
 */

import { Config, Data, Effect, Redacted } from "effect";
import { Sandbox } from "@deno/sandbox";

const ITERATIONS = 20;
const BATCH_SIZE = 5;
const MAX_RETRIES = 3;

// ============================================================
// Error types
// ============================================================

class SandboxConnectionError extends Data.TaggedError(
  "SandboxConnectionError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

class BenchmarkError extends Data.TaggedError("BenchmarkError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// ============================================================
// Stats helpers
// ============================================================

type Stats = {
  median: number;
  min: number;
  max: number;
  p95: number;
  avg: number;
  samples: number[];
};

const computeStats = (samples: number[]): Stats => {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const p95Idx = Math.floor(sorted.length * 0.95);
  return {
    median:
      sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p95: sorted[Math.min(p95Idx, sorted.length - 1)],
    avg: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    samples: sorted,
  };
};

const fmt = (ms: number) => `${Math.round(ms)}ms`;

const printStats = (label: string, stats: Stats) => {
  console.log(
    `  ${label.padEnd(40)} median=${fmt(stats.median).padStart(6)}  min=${fmt(stats.min).padStart(6)}  max=${fmt(stats.max).padStart(6)}  p95=${fmt(stats.p95).padStart(6)}  avg=${fmt(stats.avg).padStart(6)}  [${stats.samples.map((s) => fmt(s)).join(", ")}]`,
  );
};

// ============================================================
// Sandbox helpers (Effect-based)
// ============================================================

const isConnectionError = (e: unknown): boolean => {
  if (e instanceof Error) {
    const name = e.constructor.name;
    return (
      name === "ConnectionClosedError" ||
      name === "ConnectionEstablishmentError" ||
      e.message.includes("Connection") ||
      e.message.includes("closed")
    );
  }
  return String(e).includes("Connection");
};

const makeSandbox = (token: string) =>
  Effect.tryPromise({
    try: async () => {
      const sb = await Sandbox.create({
        token,
        // timeout: "120s",
        region: "ams",
      });
      await sb.fs.mkdir("lib", { recursive: true });
      return sb;
    },
    catch: (e) =>
      isConnectionError(e)
        ? new SandboxConnectionError({
            message: `Failed to create sandbox: ${e}`,
            cause: e,
          })
        : new BenchmarkError({
            message: `Failed to create sandbox: ${e}`,
            cause: e,
          }),
  });

// Force-kill sandbox — works even when connection is already dead
const killSandbox = (sb: Sandbox) =>
  Effect.tryPromise({
    try: () => sb.kill(),
    catch: () =>
      new BenchmarkError({ message: "Failed to kill sandbox (non-fatal)" }),
  }).pipe(Effect.catchAll(() => Effect.void));

const measure = <E>(fn: Effect.Effect<unknown, E>): Effect.Effect<number, E> =>
  Effect.gen(function* () {
    const start = performance.now();
    yield* fn;
    return performance.now() - start;
  });

// Wrap a sandbox operation, tagging connection errors for retry
const sandboxOp = <A>(
  label: string,
  fn: () => Promise<A>,
): Effect.Effect<A, SandboxConnectionError | BenchmarkError> =>
  Effect.tryPromise({
    try: fn,
    catch: (e) =>
      isConnectionError(e)
        ? new SandboxConnectionError({
            message: `${label}: ${e}`,
            cause: e,
          })
        : new BenchmarkError({ message: `${label}: ${e}`, cause: e }),
  });

// ============================================================
// Code snippets
// ============================================================

const SIMPLE_INLINE = `
const fibonacci = (n) => {
  if (n <= 1) return n;
  let a = 0, b = 1;
  for (let i = 2; i <= n; i++) { [a, b] = [b, a + b]; }
  return b;
};
const results = Array.from({ length: 20 }, (_, i) => fibonacci(i));
({ results, sum: results.reduce((a, b) => a + b, 0) });
`;

const SIMPLE_FILE_CONTENT = `
export const fibonacci = (n: number): number => {
  if (n <= 1) return n;
  let a = 0, b = 1;
  for (let i = 2; i <= n; i++) { [a, b] = [b, a + b]; }
  return b;
};
`;

const SIMPLE_IMPORT_AND_RUN = `
import { fibonacci } from "./lib/math.ts";
const results = Array.from({ length: 20 }, (_, i) => fibonacci(i));
({ results, sum: results.reduce((a, b) => a + b, 0) });
`;

const COMPLEX_TYPES_FILE = `
export type Issue = {
  id: string;
  title: string;
  priority: number;
  status: string;
  createdAt: string;
};

export type IssueStats = {
  total: number;
  byPriority: Record<string, number>;
  byStatus: Record<string, number>;
  recentCount: number;
};
`;

const COMPLEX_UTILS_FILE = `
import type { Issue, IssueStats } from "./types.ts";

export const computeStats = (issues: Issue[]): IssueStats => {
  const byPriority: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  for (const issue of issues) {
    const pKey = \`P\${issue.priority}\`;
    byPriority[pKey] = (byPriority[pKey] ?? 0) + 1;
    byStatus[issue.status] = (byStatus[issue.status] ?? 0) + 1;
  }

  const recentCount = issues.filter(
    (i) => new Date(i.createdAt).getTime() > oneWeekAgo
  ).length;

  return { total: issues.length, byPriority, byStatus, recentCount };
};

export const formatReport = (stats: IssueStats): string => {
  const lines = [
    \`Total issues: \${stats.total}\`,
    \`Recent (7d): \${stats.recentCount}\`,
    "Priority breakdown:",
    ...Object.entries(stats.byPriority).map(([k, v]) => \`  \${k}: \${v}\`),
    "Status breakdown:",
    ...Object.entries(stats.byStatus).map(([k, v]) => \`  \${k}: \${v}\`),
  ];
  return lines.join("\\n");
};
`;

const COMPLEX_INLINE = `
const computeStats = (issues) => {
  const byPriority = {};
  const byStatus = {};
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const issue of issues) {
    const pKey = "P" + issue.priority;
    byPriority[pKey] = (byPriority[pKey] ?? 0) + 1;
    byStatus[issue.status] = (byStatus[issue.status] ?? 0) + 1;
  }
  const recentCount = issues.filter(
    (i) => new Date(i.createdAt).getTime() > oneWeekAgo
  ).length;
  return { total: issues.length, byPriority, byStatus, recentCount };
};

const formatReport = (stats) => {
  const lines = [
    "Total issues: " + stats.total,
    "Recent (7d): " + stats.recentCount,
    "Priority breakdown:",
    ...Object.entries(stats.byPriority).map(([k, v]) => "  " + k + ": " + v),
    "Status breakdown:",
    ...Object.entries(stats.byStatus).map(([k, v]) => "  " + k + ": " + v),
  ];
  return lines.join("\\n");
};

const issues = Array.from({ length: 50 }, (_, i) => ({
  id: "ISS-" + i,
  title: "Issue " + i,
  priority: (i % 4) + 1,
  status: ["backlog", "todo", "in_progress", "done"][i % 4],
  createdAt: new Date(Date.now() - i * 12 * 60 * 60 * 1000).toISOString(),
}));

const stats = computeStats(issues);
const report = formatReport(stats);
({ stats, report });
`;

const COMPLEX_IMPORT_AND_RUN = `
import { computeStats, formatReport } from "./lib/utils.ts";

const issues = Array.from({ length: 50 }, (_, i) => ({
  id: "ISS-" + i,
  title: "Issue " + i,
  priority: (i % 4) + 1,
  status: ["backlog", "todo", "in_progress", "done"][i % 4],
  createdAt: new Date(Date.now() - i * 12 * 60 * 60 * 1000).toISOString(),
}));

const stats = computeStats(issues);
const report = formatReport(stats);
({ stats, report });
`;

// ============================================================
// Benchmark runner — Effect-based with retry on connection errors
// ============================================================

const globalStart = performance.now();
const elapsed = () => fmt(performance.now() - globalStart);

// Run a single batch of iterations on one sandbox
const runBatch = (
  token: string,
  count: number,
  fn: (
    sb: Sandbox,
  ) => Effect.Effect<unknown, SandboxConnectionError | BenchmarkError>,
  setup?: (
    sb: Sandbox,
  ) => Effect.Effect<void, SandboxConnectionError | BenchmarkError>,
): Effect.Effect<number[], SandboxConnectionError | BenchmarkError> =>
  Effect.acquireUseRelease(
    makeSandbox(token),
    (sb) =>
      Effect.gen(function* () {
        if (setup) yield* setup(sb);
        const samples: number[] = [];
        for (let i = 0; i < count; i++) {
          samples.push(yield* measure(fn(sb)));
        }
        return samples;
      }),
    (sb) => killSandbox(sb).pipe(Effect.orDie),
  );

const runBench = (
  token: string,
  label: string,
  fn: (
    sb: Sandbox,
  ) => Effect.Effect<unknown, SandboxConnectionError | BenchmarkError>,
  setup?: (
    sb: Sandbox,
  ) => Effect.Effect<void, SandboxConnectionError | BenchmarkError>,
) =>
  Effect.gen(function* () {
    const allSamples: number[] = [];
    let retries = 0;
    const totalBatches = Math.ceil(ITERATIONS / BATCH_SIZE);

    for (let batch = 0; batch < totalBatches; batch++) {
      const remaining = ITERATIONS - allSamples.length;
      const count = Math.min(BATCH_SIZE, remaining);

      const batchSamples = yield* runBatch(token, count, fn, setup).pipe(
        Effect.catchTag("SandboxConnectionError", (err) =>
          Effect.gen(function* () {
            retries++;
            if (retries > MAX_RETRIES) {
              return yield* Effect.fail(
                new BenchmarkError({
                  message: `Max retries exceeded for "${label}": ${err.message}`,
                }),
              );
            }
            yield* Effect.logWarning(
              `Connection error in batch ${batch + 1}/${totalBatches}, retrying batch (retry ${retries}/${MAX_RETRIES}): ${err.message}`,
            );
            yield* Effect.sleep("2 seconds");
            // Retry the entire batch with a fresh sandbox
            return yield* runBatch(token, count, fn, setup);
          }),
        ),
      );
      allSamples.push(...batchSamples);
    }

    printStats(label, computeStats(allSamples));
    if (retries > 0) {
      console.log(`  (elapsed: ${elapsed()}, retries: ${retries})\n`);
    } else {
      console.log(`  (elapsed: ${elapsed()})\n`);
    }
  });

// ============================================================
// Main program
// ============================================================

const program = Effect.gen(function* () {
  const apiKey = yield* Config.redacted("DENO_API_KEY");
  const token = Redacted.value(apiKey);

  yield* Effect.log(
    `Eval Strategy Benchmark (${ITERATIONS} iterations, fresh sandbox per test, max ${MAX_RETRIES} retries)`,
  );

  // 1. Fresh REPL creation
  yield* Effect.log("=== REPL Creation ===");
  yield* runBench(token, "Fresh REPL", (sb) =>
    sandboxOp("repl", () => sb.deno.repl()),
  );

  // 2. Simple: Inline Eval
  yield* Effect.log("=== Simple: Inline Eval (hot path) ===");
  yield* runBench(token, "Inline eval (fibonacci)", (sb) =>
    Effect.gen(function* () {
      const r = yield* sandboxOp("repl", () => sb.deno.repl());
      yield* sandboxOp("eval", () => r.eval(SIMPLE_INLINE));
    }),
  );

  // 3. Simple: File-First (write + import)
  yield* Effect.log("=== Simple: File-First (write + import) ===");
  yield* runBench(token, "Write file + import eval", (sb) =>
    Effect.gen(function* () {
      const r = yield* sandboxOp("repl", () => sb.deno.repl());
      yield* sandboxOp("write", () =>
        sb.fs.writeTextFile("lib/math.ts", SIMPLE_FILE_CONTENT),
      );
      yield* sandboxOp("eval", () => r.eval(SIMPLE_IMPORT_AND_RUN));
    }),
  );

  // 4. Simple: Subsequent Request (import pre-written file)
  yield* Effect.log(
    "=== Simple: Subsequent Request (import pre-written file) ===",
  );
  yield* runBench(
    token,
    "Import from existing file",
    (sb) =>
      Effect.gen(function* () {
        const r = yield* sandboxOp("repl", () => sb.deno.repl());
        yield* sandboxOp("eval", () => r.eval(SIMPLE_IMPORT_AND_RUN));
      }),
    (sb) =>
      sandboxOp("setup-write", () =>
        sb.fs.writeTextFile("lib/math.ts", SIMPLE_FILE_CONTENT),
      ).pipe(Effect.asVoid),
  );

  // 5. Complex: Inline Eval
  yield* Effect.log("=== Complex: Inline Eval (hot path) ===");
  yield* runBench(token, "Inline eval (multi-fn, 50 items)", (sb) =>
    Effect.gen(function* () {
      const r = yield* sandboxOp("repl", () => sb.deno.repl());
      yield* sandboxOp("eval", () => r.eval(COMPLEX_INLINE));
    }),
  );

  // 6. Complex: File-First Sequential
  yield* Effect.log(
    "=== Complex: File-First Sequential (write 2 + import) ===",
  );
  yield* runBench(token, "Write 2 files seq + import eval", (sb) =>
    Effect.gen(function* () {
      const r = yield* sandboxOp("repl", () => sb.deno.repl());
      yield* sandboxOp("write-types", () =>
        sb.fs.writeTextFile("lib/types.ts", COMPLEX_TYPES_FILE),
      );
      yield* sandboxOp("write-utils", () =>
        sb.fs.writeTextFile("lib/utils.ts", COMPLEX_UTILS_FILE),
      );
      yield* sandboxOp("eval", () => r.eval(COMPLEX_IMPORT_AND_RUN));
    }),
  );

  // 7. Complex: File-First Parallel
  yield* Effect.log(
    "=== Complex: File-First Parallel (write 2 || + import) ===",
  );
  yield* runBench(token, "Write 2 files parallel + import eval", (sb) =>
    Effect.gen(function* () {
      const r = yield* sandboxOp("repl", () => sb.deno.repl());
      yield* Effect.all(
        [
          sandboxOp("write-types", () =>
            sb.fs.writeTextFile("lib/types.ts", COMPLEX_TYPES_FILE),
          ),
          sandboxOp("write-utils", () =>
            sb.fs.writeTextFile("lib/utils.ts", COMPLEX_UTILS_FILE),
          ),
        ],
        { concurrency: "unbounded" },
      );
      yield* sandboxOp("eval", () => r.eval(COMPLEX_IMPORT_AND_RUN));
    }),
  );

  // 8. Complex: Subsequent Request (import pre-written files)
  yield* Effect.log(
    "=== Complex: Subsequent Request (import pre-written files) ===",
  );
  yield* runBench(
    token,
    "Import from existing files",
    (sb) =>
      Effect.gen(function* () {
        const r = yield* sandboxOp("repl", () => sb.deno.repl());
        yield* sandboxOp("eval", () => r.eval(COMPLEX_IMPORT_AND_RUN));
      }),
    (sb) =>
      Effect.all(
        [
          sandboxOp("setup-types", () =>
            sb.fs.writeTextFile("lib/types.ts", COMPLEX_TYPES_FILE),
          ),
          sandboxOp("setup-utils", () =>
            sb.fs.writeTextFile("lib/utils.ts", COMPLEX_UTILS_FILE),
          ),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.asVoid),
  );

  // 9-11. File write benchmarks (isolated)
  yield* Effect.log("=== File Writes: Sequential vs Parallel ===");
  yield* runBench(token, "Sequential: 2 file writes", (sb) =>
    Effect.gen(function* () {
      yield* sandboxOp("write-types", () =>
        sb.fs.writeTextFile("lib/types.ts", COMPLEX_TYPES_FILE),
      );
      yield* sandboxOp("write-utils", () =>
        sb.fs.writeTextFile("lib/utils.ts", COMPLEX_UTILS_FILE),
      );
    }),
  );

  yield* runBench(token, "Parallel: 2 file writes", (sb) =>
    Effect.all(
      [
        sandboxOp("write-types", () =>
          sb.fs.writeTextFile("lib/types.ts", COMPLEX_TYPES_FILE),
        ),
        sandboxOp("write-utils", () =>
          sb.fs.writeTextFile("lib/utils.ts", COMPLEX_UTILS_FILE),
        ),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.asVoid),
  );

  yield* runBench(token, "Single file write", (sb) =>
    sandboxOp("write", () =>
      sb.fs.writeTextFile("lib/math.ts", SIMPLE_FILE_CONTENT),
    ).pipe(Effect.asVoid),
  );

  yield* Effect.log(`Total benchmark time: ${elapsed()}`);
  yield* Effect.log("Done!");
});

// ============================================================
// Run
// ============================================================

Effect.runPromise(
  program.pipe(
    Effect.catchTag("BenchmarkError", (e) =>
      Effect.logError(`Benchmark failed: ${e.message}`),
    ),
    Effect.catchAll((e) => Effect.logError(`Unexpected error: ${e}`)),
  ),
);
