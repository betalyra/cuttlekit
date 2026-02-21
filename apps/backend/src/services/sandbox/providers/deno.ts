import { Effect, Redacted, Config } from "effect";
import { Client, Sandbox, Volume } from "@deno/sandbox";
import type {
  SandboxProvider,
  SandboxHandle,
  SandboxResult,
  CreateSandboxOptions,
  CreateSnapshotOptions,
  SnapshotRef,
  VolumeRef,
} from "../types.js";
import { SandboxError } from "../types.js";
import type { SandboxConfig } from "../../app-config.js";

// ============================================================
// Deno Sandbox Provider
// ============================================================

export const makeDenoProvider = (sandboxConfig: SandboxConfig) =>
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("DENO_API_KEY");
    const token = Redacted.value(apiKey);
    const client = new Client({ token });

    // ----------------------------------------------------------
    // createSandbox — acquireRelease for proper lifecycle
    // ----------------------------------------------------------
    const createSandbox = (options: CreateSandboxOptions) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          yield* Effect.log("Creating Deno sandbox", {
            snapshot: options.snapshot?.slug,
            volume: options.volume?.slug,
            region: options.region,
          });

          // Build secrets map for Deno SDK
          const secrets = Object.fromEntries(
            options.secrets.map((s) => [
              s.envName,
              { hosts: [...s.hosts], value: Redacted.value(s.value) },
            ]),
          );

          // Build volumes mount map
          const volumes = options.volume
            ? { "/workspace": options.volume.slug }
            : undefined;

          const sb = yield* Effect.tryPromise({
            try: () =>
              Sandbox.create({
                token,
                region: options.region as "ord" | "ams",
                root: options.snapshot?.slug,
                secrets,
                volumes,
                timeout: `${sandboxConfig.timeoutSeconds}s` as `${number}s`,
                memoryMb: sandboxConfig.memoryMb,
              }),
            catch: (e) =>
              new SandboxError({
                message: `Failed to create sandbox: ${e}`,
                cause: e,
              }),
          });

          yield* Effect.log("Deno sandbox created", { id: sb.id });

          // Create a REPL for stateful eval across calls
          const repl = yield* Effect.tryPromise({
            try: () => sb.deno.repl(),
            catch: (e) =>
              new SandboxError({
                message: `Failed to create REPL: ${e}`,
                cause: e,
              }),
          });

          const evalCode = (
            code: string,
          ): Effect.Effect<SandboxResult, SandboxError> =>
            Effect.tryPromise({
              try: async () => {
                const result = await repl.eval(code);

                return {
                  success: true as const,
                  result,
                  stdout: "",
                };
              },
              catch: (e) => {
                const errorMsg = e instanceof Error ? e.message : String(e);
                return new SandboxError({
                  message: `Sandbox eval failed: ${errorMsg}`,
                  cause: e,
                });
              },
            }).pipe(
              Effect.catchAll((error) =>
                Effect.succeed({
                  success: false as const,
                  error: error.message,
                  stdout: "",
                }),
              ),
            );

          return {
            eval: evalCode,
            _sandbox: sb,
            _repl: repl,
          } satisfies SandboxHandle & {
            _sandbox: Sandbox;
            _repl: Awaited<ReturnType<Sandbox["deno"]["repl"]>>;
          };
        }),
        (handle) =>
          Effect.gen(function* () {
            yield* Effect.log("Closing Deno sandbox");
            const h = handle as SandboxHandle & { _sandbox: Sandbox };
            yield* Effect.promise(() => h._sandbox.close());
          }).pipe(Effect.orDie),
      );

    // ----------------------------------------------------------
    // createSnapshot — bootable snapshot with pre-installed deps
    // Workflow (per Deno docs):
    //   1. Create bootable volume from builtin:debian-13
    //   2. Boot sandbox with volume as root
    //   3. Install deps (persists to volume)
    //   4. Close sandbox, snapshot the volume
    //   5. Clean up temp volume
    // ----------------------------------------------------------
    const createSnapshot = (options: CreateSnapshotOptions) =>
      Effect.gen(function* () {
        yield* Effect.log("Creating snapshot", {
          slug: options.slug,
          deps: options.dependencies,
        });

        const tmpSlug = `${options.slug}-tmp`;
        const region = options.region as "ord" | "ams";

        // 1. Create bootable volume from base image
        const volume = yield* Effect.tryPromise({
          try: () =>
            client.volumes.create({
              slug: tmpSlug,
              region,
              capacity:
                `${sandboxConfig.snapshotCapacityMb}MB` as `${number}MB`,
              from: "builtin:debian-13",
            }),
          catch: (e) =>
            new SandboxError({
              message: `Failed to create bootable volume: ${e}`,
              cause: e,
            }),
        });

        // 2. Boot sandbox with volume as root and install deps
        yield* Effect.acquireUseRelease(
          Effect.tryPromise({
            try: () =>
              Sandbox.create({
                token,
                region,
                root: volume.slug,
              }),
            catch: (e) =>
              new SandboxError({
                message: `Failed to create build sandbox: ${e}`,
                cause: e,
              }),
          }),
          (sb) =>
            Effect.gen(function* () {
              const packageJson = {
                name: "genui-snapshot",
                private: true,
                type: "module",
                dependencies: Object.fromEntries(
                  options.dependencies.map((dep) => [dep, "latest"]),
                ),
              };

              yield* Effect.tryPromise({
                try: () =>
                  sb.fs.writeTextFile(
                    "package.json",
                    JSON.stringify(packageJson, null, 2),
                  ),
                catch: (e) =>
                  new SandboxError({
                    message: `Failed to write package.json: ${e}`,
                    cause: e,
                  }),
              });

              yield* Effect.log("Installing dependencies for snapshot...");
              yield* Effect.tryPromise({
                try: () => sb.sh`deno install`,
                catch: (e) =>
                  new SandboxError({
                    message: `Failed to install deps: ${e}`,
                    cause: e,
                  }),
              });

              yield* Effect.log(
                "Dependencies installed, closing sandbox before snapshot...",
              );
              return undefined;
            }),
          // Release: close sandbox so volume is detached
          (sb) => Effect.promise(() => sb.close()).pipe(Effect.orDie),
        );

        // 3. Snapshot the volume (must be detached from sandbox first)
        const snapshot = yield* Effect.tryPromise({
          try: () => client.volumes.snapshot(volume.id, { slug: options.slug }),
          catch: (e) =>
            new SandboxError({
              message: `Failed to create snapshot: ${e}`,
              cause: e,
            }),
        });

        // 4. Clean up temp volume
        yield* Effect.tryPromise({
          try: () => client.volumes.delete(volume.id),
          catch: () =>
            new SandboxError({
              message: "Failed to delete temp volume (non-fatal)",
            }),
        }).pipe(Effect.catchAll((e) => Effect.log(`Warning: ${e.message}`)));

        yield* Effect.log("Snapshot created", { slug: options.slug });
        return { slug: snapshot.slug } satisfies SnapshotRef;
      });

    // ----------------------------------------------------------
    // snapshotExists
    // ----------------------------------------------------------
    const snapshotExists = (slug: string) =>
      Effect.tryPromise({
        try: async () => {
          const snap = await client.snapshots.get(slug);
          return snap !== null && snap.isBootable;
        },
        catch: (e) =>
          new SandboxError({
            message: `Failed to check snapshot: ${e}`,
            cause: e,
          }),
      });

    // ----------------------------------------------------------
    // Volume operations
    // ----------------------------------------------------------
    const createVolume = (slug: string, region: string) =>
      Effect.gen(function* () {
        // Check if volume already exists (e.g. from a previous failed attempt)
        const existing = yield* Effect.tryPromise({
          try: () => client.volumes.get(slug),
          catch: () =>
            new SandboxError({ message: "Failed to check existing volume" }),
        }).pipe(Effect.catchAll(() => Effect.succeed(null)));

        if (existing) {
          yield* Effect.log("Volume already exists, reusing", { slug });
          return { slug: existing.slug, region } satisfies VolumeRef;
        }

        const vol = yield* Effect.tryPromise({
          try: () =>
            client.volumes.create({
              slug,
              region: region as "ord" | "ams",
              capacity: `${sandboxConfig.volumeCapacityMb}MB` as `${number}MB`,
            }),
          catch: (e) =>
            new SandboxError({
              message: `Failed to create volume: ${e}`,
              cause: e,
            }),
        });
        return { slug: vol.slug, region } satisfies VolumeRef;
      });

    const volumeExists = (slug: string) =>
      Effect.tryPromise({
        try: async () => {
          const vol = await Volume.get(slug, { token });
          return vol !== null;
        },
        catch: (e) =>
          new SandboxError({
            message: `Failed to check volume: ${e}`,
            cause: e,
          }),
      });

    const deleteVolume = (slug: string) =>
      Effect.tryPromise({
        try: async () => {
          await client.volumes.delete(slug);
        },
        catch: (e) =>
          new SandboxError({
            message: `Failed to delete volume: ${e}`,
            cause: e,
          }),
      });

    const deleteSnapshot = (slug: string) =>
      Effect.logError(
        `Deno SDK does not support snapshot deletion. Please delete snapshot '${slug}' manually via the Deno dashboard.`,
      );

    return {
      createSandbox,
      createSnapshot,
      snapshotExists,
      createVolume,
      volumeExists,
      deleteVolume,
      deleteSnapshot,
    } satisfies SandboxProvider;
  });
