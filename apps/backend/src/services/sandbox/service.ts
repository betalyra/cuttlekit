import { Effect, Option } from "effect";
import { loadAppConfig } from "../app-config.js";
import { makeDenoProvider } from "./providers/deno.js";
import {
  makeSandboxManager,
  type SandboxManagerInstance,
} from "./manager.js";

// ============================================================
// SandboxService — Effect.Service wrapping the manager
// ============================================================

export class SandboxService extends Effect.Service<SandboxService>()(
  "SandboxService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const { sandbox: sandboxOption } = yield* loadAppConfig;

      if (Option.isNone(sandboxOption)) {
        yield* Effect.log("Sandbox disabled");
        return { manager: Option.none<SandboxManagerInstance>() };
      }

      const sandboxConfig = sandboxOption.value;

      // Build provider (currently only Deno)
      const provider = yield* makeDenoProvider(sandboxConfig);
      const manager = yield* makeSandboxManager(sandboxConfig, provider);

      // Build snapshot at startup when enabled (one-time cost, skipped if hash matches)
      if (sandboxConfig.useSnapshots) {
        yield* Effect.log("Ensuring base snapshot exists...");
        yield* manager.ensureSnapshot;
      }

      yield* Effect.log("SandboxService initialized", {
        provider: sandboxConfig.provider,
        mode: sandboxConfig.mode,
        region: sandboxConfig.region,
        useSnapshots: sandboxConfig.useSnapshots,
        deps: sandboxConfig.dependencies.map((d) => d.package),
      });

      return { manager: Option.some(manager) };
    }),
  },
) {}

// Re-export manager type for convenience
export type { SandboxManagerInstance };
