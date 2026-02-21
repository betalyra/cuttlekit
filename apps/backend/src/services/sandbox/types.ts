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
// Sandbox handle — provider-agnostic interface
// ============================================================

export type SandboxHandle = {
  readonly eval: (code: string) => Effect.Effect<SandboxResult, SandboxError>;
};

// ============================================================
// Volume / snapshot references
// ============================================================

export type VolumeRef = {
  readonly slug: string;
  readonly region: string;
};

export type SnapshotRef = {
  readonly slug: string;
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
  readonly volume?: VolumeRef;
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
