import { Config, Effect, Redacted, Scope } from "effect";
import { Sandbox } from "@deno/sandbox";

export type SandboxSecret = {
  readonly hosts: string[];
  readonly value: Redacted.Redacted<string>;
};

export type SandboxOptions = {
  readonly name: string;
  readonly secrets?: Record<string, SandboxSecret>;
  readonly dependencies?: string[];
};

export type SandboxHandle = {
  readonly eval: (code: string) => Effect.Effect<unknown, Error>;
  readonly _sandbox: Sandbox;
};

// Sandbox service with acquireRelease for proper resource management
export class SandboxService extends Effect.Service<SandboxService>()(
  "SandboxService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const apiKey = yield* Config.redacted("DENO_API_KEY");

      const makeSandbox = (
        options: SandboxOptions
      ): Effect.Effect<SandboxHandle, Error, Scope.Scope> =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            yield* Effect.logInfo(`Creating Deno sandbox: ${options.name}`);

            // Convert secrets to the format expected by Sandbox.create
            const secrets = options.secrets
              ? Object.fromEntries(
                  Object.entries(options.secrets).map(([key, secret]) => [
                    key,
                    { hosts: secret.hosts, value: Redacted.value(secret.value) },
                  ])
                )
              : undefined;

            const sb = yield* Effect.tryPromise({
              try: () =>
                Sandbox.create({
                  token: Redacted.value(apiKey),
                  secrets,
                }),
              catch: (e) => new Error(`Failed to create sandbox: ${e}`),
            });

            // Install dependencies if provided
            if (options.dependencies && options.dependencies.length > 0) {
              yield* Effect.logInfo(
                `Installing dependencies: ${options.dependencies.join(", ")}`
              );

              // Write package.json with dependencies
              const packageJson = {
                name: options.name,
                private: true,
                type: "module",
                dependencies: Object.fromEntries(
                  options.dependencies.map((dep) => [dep, "latest"])
                ),
              };
              yield* Effect.tryPromise({
                try: () =>
                  sb.fs.writeTextFile(
                    "package.json",
                    JSON.stringify(packageJson, null, 2)
                  ),
                catch: (e) => new Error(`Failed to write package.json: ${e}`),
              });

              // Run deno install
              yield* Effect.tryPromise({
                try: async () => {
                  await sb.sh`deno install`;
                },
                catch: (e) => new Error(`Failed to install dependencies: ${e}`),
              });

              yield* Effect.logInfo("Dependencies installed");
            }

            const evalCode = (code: string) =>
              Effect.tryPromise({
                try: () => sb.deno.eval(code),
                catch: (e) => new Error(`Failed to eval code: ${e}`),
              });

            return {
              eval: evalCode,
              _sandbox: sb,
            } as const;
          }),
          (handle) =>
            Effect.gen(function* () {
              yield* Effect.logInfo(`Closing Deno sandbox`);
              yield* Effect.promise(() => handle._sandbox.close());
            }).pipe(Effect.orDie)
        );

      return { makeSandbox } as const;
    }),
  }
) {}
