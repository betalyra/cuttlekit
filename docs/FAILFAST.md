# Fail-Fast Patch Validation

## Problem

Currently, patch parsing can fail due to:
1. Invalid JSON from LLM (malformed, extra characters, non-minified)
2. Invalid patch structure (missing fields, wrong types)
3. Invalid patch target (selector doesn't exist in DOM)
4. Invalid patch content (malformed HTML)

These failures are detected late, after the full stream completes, wasting tokens and time.

## Goal

Validate patches **as they stream** and fail fast on the first invalid patch. Then retry with a corrective prompt.

## Architecture

```
┌─────────────┐    ┌──────────────┐    ┌───────────────┐    ┌─────────────┐
│ LLM Stream  │───▶│ Accumulate   │───▶│ Parse & Val.  │───▶│ Apply Patch │
│ (tokens)    │    │ Lines        │    │ (Zod + DOM)   │    │ (happy-dom) │
└─────────────┘    └──────────────┘    └───────────────┘    └─────────────┘
                                              │
                                              ▼ on error
                                       ┌─────────────┐
                                       │ Stop Stream │
                                       │ + Retry     │
                                       └─────────────┘
```

## Design Principles

1. **Functional / Immutable**: No array mutation. Use Effect's functional patterns.
2. **Composable**: Design for integration with future processor architecture (see PROCESSOR.md).
3. **Pure Functions**: Validation and retry logic as pure functions that can be tested in isolation.

## Implementation Status

### ✅ Completed

#### 1. Shared Patch Utilities (`@betalyra/generative-ui-common/client`)

```typescript
export type Patch = { selector: string; ... }
export type ApplyPatchResult = { _tag: "Success" } | { _tag: "ElementNotFound"; selector: string } | ...
export const applyPatch = (doc: Document, patch: Patch): ApplyPatchResult
```

#### 2. PatchValidator Service (`services/patch-validator.ts`)

Validates patches by **actually applying them** to a temporary happy-dom document.

#### 3. Stream Line Accumulation (`stream/utils.ts`)

Accumulates tokens into complete JSONL lines using `Stream.mapAccum`.

### 🚧 TODO: Functional Retry Loop

#### Retry State (Immutable)

```typescript
type RetryState = {
  readonly attempt: number;
  readonly appliedPatches: readonly Patch[];
  readonly validationDoc: Document;
  readonly previousError?: PatchValidationError;
};

const initialRetryState = (validationDoc: Document): RetryState => ({
  attempt: 1,
  appliedPatches: [],
  validationDoc,
  previousError: undefined,
});
```

#### Pure Functions for Retry Logic

```typescript
// Pure function: compute next state after successful patches
const addAppliedPatches = (
  state: RetryState,
  patches: readonly Patch[]
): RetryState => ({
  ...state,
  appliedPatches: [...state.appliedPatches, ...patches],
});

// Pure function: compute next state after failure
const nextAttempt = (
  state: RetryState,
  error: PatchValidationError
): RetryState => ({
  ...state,
  attempt: state.attempt + 1,
  previousError: error,
});

// Pure function: build corrective prompt from state
const buildCorrectivePrompt = (state: RetryState): string | null => {
  if (!state.previousError || state.attempt === 1) return null;
  // ... build prompt from state
};
```

#### Functional Stream Processing

Instead of mutating arrays, use `Stream.mapAccum` to thread state through the stream:

```typescript
// Process stream with immutable state threading
const processWithValidation = (
  stream: Stream<UnifiedResponse, Error>,
  initialState: RetryState
): Stream<{ response: UnifiedResponse; state: RetryState }, PatchValidationError> =>
  pipe(
    stream,
    Stream.mapAccum(initialState, (state, response) => {
      if (response.type === "patches") {
        // Validate and return new state
        const newState = addAppliedPatches(state, response.patches);
        return [newState, { response, state: newState }];
      }
      return [state, { response, state }];
    })
  );
```

#### Recursive Retry with Effect.iterate

Use `Effect.iterate` for functional retry without mutation:

```typescript
const generateWithRetry = (options: GenerateOptions) =>
  Effect.iterate(
    initialRetryState(validationDoc),
    {
      while: (state) => state.attempt <= MAX_ATTEMPTS,
      body: (state) =>
        pipe(
          createStream(options, state),
          Stream.runCollect,
          Effect.matchEffect({
            onSuccess: (responses) => Effect.succeed({ done: true, responses, state }),
            onFailure: (error) =>
              error instanceof PatchValidationError
                ? Effect.succeed({ done: false, state: nextAttempt(state, error) })
                : Effect.fail(error),
          })
        ),
    }
  );
```

## Integration with Processor Architecture

This validation logic will be used by the session processor (see PROCESSOR.md):

```
┌─────────────┐     ┌───────────────┐     ┌─────────────────┐
│ Message     │────▶│ Processor     │────▶│ Validate &      │
│ Queue       │     │ (batches msgs)│     │ Apply Patches   │
└─────────────┘     └───────────────┘     └─────────────────┘
```

The fail-fast validation becomes a **step** in the processor's message handling:
1. Processor dequeues batched messages (prompts + actions)
2. Processor calls LLM with batched context
3. **Validation step validates patches as they stream**
4. On failure, processor can retry with corrective context
5. Valid patches are applied to session vdom and sent to client

## Error Types

```typescript
export type PatchValidationErrorReason =
  | "selector_not_found"
  | "empty_selector"
  | "apply_error";

export class PatchValidationError extends Data.TaggedError("PatchValidationError")<{
  readonly patch: Patch;
  readonly reason: PatchValidationErrorReason;
  readonly message: string;
}> {}
```

## Considerations

### Validation Document Strategy
- Create a **copy** of the current session DOM for validation
- Apply patches to the copy first
- Only if all patches validate, apply to the real session DOM

### Functional State Management
- Use immutable state objects
- Thread state through streams with `mapAccum`
- Use `Effect.iterate` for retry loops instead of while loops with mutation

### Future: Processor Integration
- Validation logic should be a composable function
- Can be called by the processor for each LLM response batch
- State (applied patches, retry count) managed by processor, not globally
