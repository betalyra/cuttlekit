import { Effect, Redacted, Config, Ref, Option } from "effect";
import { Client, Sandbox, Volume } from "@deno/sandbox";
import type {
  SandboxProvider,
  SandboxHandle,
  SandboxResult,
  ShellResult,
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

type DenoRepl = Awaited<ReturnType<Sandbox["deno"]["repl"]>>;

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
            region: options.region,
          });

          // Build secrets map for Deno SDK
          const secrets = Object.fromEntries(
            options.secrets.map((s) => [
              s.envName,
              { hosts: [...s.hosts], value: Redacted.value(s.value) },
            ]),
          );

          const sb = yield* Effect.tryPromise({
            try: () =>
              Sandbox.create({
                token,
                region: options.region as "ord" | "ams",
                root: options.snapshot?.slug,
                secrets,
                timeout: `${sandboxConfig.timeoutSeconds}s` as `${number}s`,
                memory: `${sandboxConfig.memoryMb}MiB`,
              }),
            catch: (e) =>
              new SandboxError({
                message: `Failed to create sandbox: ${e}`,
                cause: e,
              }),
          });

          yield* Effect.log("Deno sandbox created", { id: sb.id });

          // REPL ref — created eagerly via initRepl(), but *after*
          // deps are installed so module resolution sees them.
          const replRef = yield* Ref.make<Option.Option<DenoRepl>>(
            Option.none(),
          );

          const initRepl = () =>
            Effect.gen(function* () {
              const repl = yield* Effect.tryPromise({
                try: () => sb.deno.repl(),
                catch: (e) =>
                  new SandboxError({
                    message: `Failed to create REPL: ${e}`,
                    cause: e,
                  }),
              });
              yield* Ref.set(replRef, Option.some(repl));
            });

          const evalCode = (
            code: string,
          ): Effect.Effect<SandboxResult, SandboxError> =>
            Effect.gen(function* () {
              const maybeRepl = yield* Ref.get(replRef);
              if (Option.isNone(maybeRepl)) {
                return {
                  success: false as const,
                  error: "REPL not initialised — call initRepl() first",
                  stdout: "",
                };
              }
              return yield* Effect.tryPromise({
                try: async () => {
                  const result = await maybeRepl.value.eval(code);
                  return { success: true as const, result, stdout: "" };
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
            });

          const writeTextFile = (path: string, content: string) =>
            Effect.tryPromise({
              try: () => sb.fs.writeTextFile(path, content),
              catch: (e) =>
                new SandboxError({
                  message: `writeTextFile failed: ${e}`,
                  cause: e,
                }),
            });

          const readTextFile = (path: string) =>
            Effect.tryPromise({
              try: () => sb.fs.readTextFile(path),
              catch: (e) =>
                new SandboxError({
                  message: `readTextFile failed: ${e}`,
                  cause: e,
                }),
            });

          const sh = (command: string) =>
            Effect.tryPromise({
              try: async () => {
                // Pass command as a raw template literal string part (not interpolated value)
                // to avoid shell-escaping the entire command as a single token.
                const tpl = Object.assign([command], { raw: [command] });
                const result = await sb
                  .sh(tpl as unknown as TemplateStringsArray)
                  .stdout("piped")
                  .stderr("piped")
                  .noThrow();
                return {
                  stdout: result.stdoutText ?? "",
                  stderr: result.stderrText ?? "",
                  exitCode: result.status.code,
                } satisfies ShellResult;
              },
              catch: (e) =>
                new SandboxError({
                  message: `sh failed: ${e}`,
                  cause: e,
                }),
            });

          return {
            initRepl,
            eval: evalCode,
            writeTextFile,
            readTextFile,
            sh,
            _sandbox: sb,
          } satisfies SandboxHandle & { _sandbox: Sandbox };
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
      Effect.tryPromise({
        try: () => client.snapshots.delete(slug),
        catch: (e) =>
          new SandboxError({
            message: `Failed to delete snapshot '${slug}': ${e}`,
            cause: e,
          }),
      });

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
