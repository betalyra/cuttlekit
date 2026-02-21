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
// Manager instance — created once at startup per config
// ============================================================

export type SandboxManagerInstance = {
  /** Ensure base snapshot exists (call at app startup) */
  readonly ensureSnapshot: Effect.Effect<SnapshotRef, SandboxError>;

  /** Get or create sandbox for a session (no Scope required — manager owns lifecycle) */
  readonly getOrCreateSandbox: (
    sessionId: string,
    sandboxRef: Ref.Ref<Option.Option<ManagedSandbox>>,
    volumeSlug: string | undefined,
  ) => Effect.Effect<SandboxHandle, SandboxError>;

  /** Release a session's sandbox (closes its scope) */
  readonly releaseSandbox: (
    sandboxRef: Ref.Ref<Option.Option<ManagedSandbox>>,
  ) => Effect.Effect<void>;

  /** Check if a volume exists */
  readonly volumeExists: (
    volumeSlug: string,
  ) => Effect.Effect<boolean, SandboxError>;

  /** Create a volume for a session */
  readonly createVolume: (
    sessionId: string,
  ) => Effect.Effect<string, SandboxError>;

  /** Delete a volume */
  readonly deleteVolume: (slug: string) => Effect.Effect<void, SandboxError>;

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

    const ensureSnapshot: Effect.Effect<SnapshotRef, SandboxError> =
      Effect.gen(function* () {
        const existing = yield* Ref.get(snapshotRef);
        if (Option.isSome(existing)) return existing.value;

        // Check if snapshot already exists (from previous startup)
        const exists = yield* provider.snapshotExists(snapSlug);
        if (exists) {
          const ref: SnapshotRef = { slug: snapSlug };
          yield* Ref.set(snapshotRef, Option.some(ref));
          yield* Effect.log("Using existing snapshot", { slug: snapSlug });
          return ref;
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
        return ref;
      });

    const getOrCreateSandbox = (
      sessionId: string,
      sandboxRef: Ref.Ref<Option.Option<ManagedSandbox>>,
      volumeSlug: string | undefined,
    ): Effect.Effect<SandboxHandle, SandboxError> =>
      Effect.gen(function* () {
        const existing = yield* Ref.get(sandboxRef);
        if (Option.isSome(existing)) return existing.value.handle;

        // Ensure snapshot is ready
        const snapshot = yield* ensureSnapshot;

        yield* Effect.log("Creating session sandbox", {
          sessionId,
          snapshot: snapshot.slug,
          volume: volumeSlug,
        });

        const volume = volumeSlug
          ? { slug: volumeSlug, region: config.region }
          : undefined;

        // Create a scope owned by the manager — caller doesn't need one
        const scope = yield* Scope.make();
        const handle = yield* provider
          .createSandbox({
            snapshot,
            volume,
            secrets,
            region: config.region,
          })
          .pipe(Scope.extend(scope));

        yield* Ref.set(
          sandboxRef,
          Option.some({ handle, scope }),
        );
        return handle;
      });

    const releaseSandbox = (
      sandboxRef: Ref.Ref<Option.Option<ManagedSandbox>>,
    ) =>
      Effect.gen(function* () {
        const existing = yield* Ref.get(sandboxRef);
        if (Option.isSome(existing)) {
          yield* Scope.close(existing.value.scope, Exit.void);
          yield* Ref.set(sandboxRef, Option.none());
        }
      });

    const volumeExists = (volumeSlug: string) =>
      provider.volumeExists(volumeSlug);

    const createVolume = (sessionId: string) =>
      Effect.gen(function* () {
        const slug = `gv-${sessionId}`;
        yield* provider.createVolume(slug, config.region);
        return slug;
      });

    const deleteVolume = (slug: string) => provider.deleteVolume(slug);

    return {
      ensureSnapshot,
      getOrCreateSandbox,
      releaseSandbox,
      volumeExists,
      createVolume,
      deleteVolume,
      config,
    } satisfies SandboxManagerInstance;
  });
