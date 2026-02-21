import { Schema } from "effect";
import type { Effect, Scope, Redacted } from "effect";

// ============================================================
// Sandbox result — structured output from eval
// ============================================================

export type SandboxResult =
  | { readonly success: true; readonly result: unknown; readonly stdout: string }
  | {
      readonly success: false;
      readonly error: string;
      readonly stdout: string;
    };

// ============================================================
// Shell result
// ============================================================

export type ShellResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

// ============================================================
// Sandbox handle — provider-agnostic interface
// ============================================================

export type SandboxHandle = {
  /** Initialise the REPL. Call AFTER dependencies are installed. */
  readonly initRepl: () => Effect.Effect<void, SandboxError>;
  readonly eval: (code: string) => Effect.Effect<SandboxResult, SandboxError>;
  readonly writeTextFile: (
    path: string,
    content: string,
  ) => Effect.Effect<void, SandboxError>;
  readonly readTextFile: (
    path: string,
  ) => Effect.Effect<string, SandboxError>;
  readonly sh: (
    command: string,
  ) => Effect.Effect<ShellResult, SandboxError>;
};

// ============================================================
// Snapshot references
// ============================================================

export type SnapshotRef = {
  readonly slug: string;
};

// ============================================================
// Volume references (kept for future use)
// ============================================================

export type VolumeRef = {
  readonly slug: string;
  readonly region: string;
};

// ============================================================
// Sandbox creation options
// ============================================================

export type SandboxSecret = {
  readonly envName: string;
  readonly value: Redacted.Redacted;
  readonly hosts: ReadonlyArray<string>;
};

export type CreateSandboxOptions = {
  readonly snapshot?: SnapshotRef;
  readonly secrets: ReadonlyArray<SandboxSecret>;
  readonly region: string;
};

export type CreateSnapshotOptions = {
  readonly dependencies: ReadonlyArray<string>;
  readonly region: string;
  readonly slug: string;
};

// ============================================================
// Errors
// ============================================================

export class SandboxError extends Schema.TaggedError<SandboxError>()(
  "SandboxError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class SandboxExecError extends Schema.TaggedError<SandboxExecError>()(
  "SandboxExecError",
  {
    message: Schema.String,
    stdout: Schema.optionalWith(Schema.String, { default: () => "" }),
  },
) {}

// ============================================================
// Provider interface
// ============================================================

export type SandboxProvider = {
  readonly createSandbox: (
    options: CreateSandboxOptions,
  ) => Effect.Effect<SandboxHandle, SandboxError, Scope.Scope>;

  readonly createSnapshot: (
    options: CreateSnapshotOptions,
  ) => Effect.Effect<SnapshotRef, SandboxError>;

  readonly snapshotExists: (
    slug: string,
  ) => Effect.Effect<boolean, SandboxError>;

  readonly createVolume: (
    slug: string,
    region: string,
  ) => Effect.Effect<VolumeRef, SandboxError>;

  readonly volumeExists: (
    slug: string,
  ) => Effect.Effect<boolean, SandboxError>;

  readonly deleteVolume: (slug: string) => Effect.Effect<void, SandboxError>;

  readonly deleteSnapshot: (slug: string) => Effect.Effect<void, SandboxError>;
};
