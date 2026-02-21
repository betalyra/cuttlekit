import { Effect, Ref, Option, Scope, Exit } from "effect";
import type {
  SandboxProvider,
  SandboxHandle,
  SnapshotRef,
  SandboxSecret,
} from "./types.js";
import { SandboxError } from "./types.js";
import type { SandboxConfig } from "../app-config.js";

// ============================================================
// Snapshot hash — changes when config dependencies change
// ============================================================

const computeConfigHash = async (config: SandboxConfig): Promise<string> => {
  const deps = [...config.dependencies]
    .map((d) => d.package)
    .sort()
    .join(",");
  const data = new TextEncoder().encode(deps);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
};

const snapshotSlug = (hash: string) => `genui-deps-${hash}`;

// ============================================================
// Managed sandbox — handle + its scope (for cleanup)
// ============================================================

export type ManagedSandbox = {
  readonly handle: SandboxHandle;
  readonly scope: Scope.CloseableScope;
};

// ============================================================
// Sandbox context — ref + lock for safe concurrent access
// ============================================================

export type SandboxContext = {
  readonly ref: Ref.Ref<Option.Option<ManagedSandbox>>;
  readonly lock: Effect.Semaphore;
};

// ============================================================
// Manager instance — created once at startup per config
// ============================================================

export type SandboxManagerInstance = {
  /** Ensure base snapshot exists. Returns None when useSnapshots=false. */
  readonly ensureSnapshot: Effect.Effect<Option.Option<SnapshotRef>, SandboxError>;

  /** Get or create sandbox for a session (no Scope required — manager owns lifecycle) */
  readonly getOrCreateSandbox: (
    sessionId: string,
    ctx: SandboxContext,
  ) => Effect.Effect<SandboxHandle, SandboxError>;

  /** Release a session's sandbox (closes its scope) */
  readonly releaseSandbox: (
    ctx: SandboxContext,
  ) => Effect.Effect<void>;

  /** The resolved sandbox config */
  readonly config: SandboxConfig;
};

export const makeSandboxManager = (
  config: SandboxConfig,
  provider: SandboxProvider,
): Effect.Effect<SandboxManagerInstance, SandboxError> =>
  Effect.gen(function* () {
    const configHash = yield* Effect.promise(() => computeConfigHash(config));
    const snapSlug = snapshotSlug(configHash);

    // Build secrets list from config dependencies
    const secrets: SandboxSecret[] = config.dependencies
      .filter((d) => d.secretValue !== undefined)
      .map((d) => ({
        envName: d.secretEnv!,
        value: d.secretValue!,
        hosts: [...d.hosts],
      }));

    // Snapshot ref — resolved lazily on first call to ensureSnapshot
    const snapshotRef = yield* Ref.make<Option.Option<SnapshotRef>>(
      Option.none(),
    );

    const ensureSnapshot: Effect.Effect<Option.Option<SnapshotRef>, SandboxError> =
      Effect.gen(function* () {
        if (!config.useSnapshots) return Option.none();

        const existing = yield* Ref.get(snapshotRef);
        if (Option.isSome(existing)) return existing;

        // Check if snapshot already exists (from previous startup)
        const exists = yield* provider.snapshotExists(snapSlug);
        if (exists) {
          const ref: SnapshotRef = { slug: snapSlug };
          yield* Ref.set(snapshotRef, Option.some(ref));
          yield* Effect.log("Using existing snapshot", { slug: snapSlug });
          return Option.some(ref);
        }

        // Clean up any stale snapshot/volume before rebuilding
        yield* provider.deleteSnapshot(snapSlug).pipe(
          Effect.catchAll(() => Effect.void),
        );
        yield* provider.deleteVolume(`${snapSlug}-tmp`).pipe(
          Effect.catchAll(() => Effect.void),
        );

        yield* Effect.log("Building base snapshot...", {
          deps: config.dependencies.map((d) => d.package),
        });
        const ref = yield* provider.createSnapshot({
          dependencies: config.dependencies.map((d) => d.package),
          region: config.region,
          slug: snapSlug,
        });
        yield* Ref.set(snapshotRef, Option.some(ref));
        return Option.some(ref);
      });

    const getOrCreateSandbox = (
      sessionId: string,
      ctx: SandboxContext,
    ): Effect.Effect<SandboxHandle, SandboxError> =>
      ctx.lock.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* Ref.get(ctx.ref);
          if (Option.isSome(existing)) return existing.value.handle;

          // Resolve snapshot (None when useSnapshots=false)
          const snapshot = yield* ensureSnapshot;

          yield* Effect.log("Creating session sandbox", {
            sessionId,
            snapshot: Option.map(snapshot, (s) => s.slug),
          });

          // Create a scope owned by the manager — caller doesn't need one
          const scope = yield* Scope.make();
          const handle = yield* provider
            .createSandbox({
              snapshot: Option.getOrUndefined(snapshot),
              secrets,
              region: config.region,
            })
            .pipe(Scope.extend(scope));

          // When no snapshot, install dependencies directly into the sandbox
          if (Option.isNone(snapshot) && config.dependencies.length > 0) {
            yield* Effect.log("Installing dependencies (no snapshot)", {
              sessionId,
              deps: config.dependencies.map((d) => d.package),
            });
            const packageJson = JSON.stringify({
              name: "genui-sandbox",
              private: true,
              type: "module",
              dependencies: Object.fromEntries(
                config.dependencies.map((d) => [d.package, "latest"]),
              ),
            }, null, 2);
            yield* handle.writeTextFile("package.json", packageJson);
            yield* handle.sh("deno install");
            yield* Effect.log("Dependencies installed", { sessionId });
          }

          // Init REPL after deps so module resolution sees them
          yield* handle.initRepl();

          yield* Ref.set(
            ctx.ref,
            Option.some({ handle, scope }),
          );
          return handle;
        }),
      );

    const releaseSandbox = (ctx: SandboxContext) =>
      Effect.gen(function* () {
        const existing = yield* Ref.get(ctx.ref);
        if (Option.isSome(existing)) {
          yield* Scope.close(existing.value.scope, Exit.void);
          yield* Ref.set(ctx.ref, Option.none());
        }
      });

    return {
      ensureSnapshot,
      getOrCreateSandbox,
      releaseSandbox,
      config,
    } satisfies SandboxManagerInstance;
  });
