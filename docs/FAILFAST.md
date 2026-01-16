# Fail-Fast Patch Validation with Retry

## Problem

Patch parsing can fail due to:
1. Invalid JSON from LLM (malformed, extra characters, non-minified)
2. Invalid patch structure (missing fields, wrong types)
3. Invalid patch target (selector doesn't exist in DOM)
4. Invalid patch content (malformed HTML)

These failures need to be detected **as they stream** to fail fast and retry with a corrective prompt.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         streamUnified()                          │
├─────────────────────────────────────────────────────────────────┤
│  1. Build messages from options                                  │
│  2. Create validation document (happy-dom)                       │
│  3. Call runWithRetry()                                         │
│  4. Stream collected responses + stats                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    runWithRetry() - Effect.iterate              │
├─────────────────────────────────────────────────────────────────┤
│  State: { attempt, messages, allResponses, done, usagePromises }│
│                                                                  │
│  while (!done && attempt < MAX_ATTEMPTS):                       │
│    1. Call runAttempt(messages, validationDoc)                  │
│    2. If success: done = true, collect responses                │
│    3. If failed: append corrective prompt, increment attempt    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                runAttempt() - Stream with mapAccumEffect        │
├─────────────────────────────────────────────────────────────────┤
│  1. Start LLM stream                                            │
│  2. Parse JSONL lines                                           │
│  3. Validate patches with mapAccumEffect:                       │
│     - Success: accumulate response, emit StreamItemResponse     │
│     - Failure: emit StreamItemError with collected responses    │
│  4. takeUntil error                                             │
│  5. Return AttemptResult (Success or ValidationFailed)          │
└─────────────────────────────────────────────────────────────────┘
```

## Design Principles

1. **Functional/Immutable State**: All state transitions are pure, no array mutation
2. **Error as Data**: Validation errors are captured as data, not thrown exceptions
3. **Effect.iterate**: Retry loop uses Effect's iterate for functional iteration
4. **Stream.mapAccumEffect**: Threading state through streams without mutation

## Implementation

### Key Types

```typescript
// Result of a single stream attempt
type AttemptResult =
  | { _tag: "Success"; responses: readonly UnifiedResponse[] }
  | { _tag: "ValidationFailed"; validResponses: readonly UnifiedResponse[]; error: PatchValidationError };

// Stream item during processing - error as data pattern
type StreamItem =
  | { _tag: "Response"; response: UnifiedResponse; collected: readonly UnifiedResponse[] }
  | { _tag: "Error"; error: PatchValidationError; collected: readonly UnifiedResponse[] };

// Immutable state for retry loop
type IterateState = {
  readonly attempt: number;
  readonly messages: readonly Message[];
  readonly allResponses: readonly UnifiedResponse[];
  readonly done: boolean;
  readonly lastError?: PatchValidationError;
  readonly usagePromises: readonly PromiseLike<unknown>[];
};
```

### Error as Data Pattern

Instead of failing the stream when validation fails, we emit the error as a data item:

```typescript
Stream.mapAccumEffect(
  [] as readonly UnifiedResponse[],
  (collected, response): Effect.Effect<readonly [readonly UnifiedResponse[], StreamItem], never, never> =>
    Effect.gen(function* () {
      if (response.type === "patches") {
        const validationResult = yield* patchValidator
          .validateAll(validationDoc, response.patches)
          .pipe(Effect.either);

        if (Either.isLeft(validationResult)) {
          // Emit error as data, don't fail the stream
          const item: StreamItem = { _tag: "Error", error: validationResult.left, collected };
          return [collected, item] as const;
        }
      }

      // Valid response - accumulate
      const newCollected = [...collected, response];
      const item: StreamItem = { _tag: "Response", response, collected: newCollected };
      return [newCollected, item] as const;
    })
)
```

This allows us to:
1. Capture partial results before the error
2. Continue processing in the retry loop
3. Maintain functional purity

### Retry Loop with Effect.iterate

```typescript
Effect.iterate(initialState, {
  while: (s): s is IterateState => !s.done && s.attempt < MAX_RETRY_ATTEMPTS,
  body: (state): Effect.Effect<IterateState, Error> =>
    Effect.gen(function* () {
      const result = yield* runAttempt(state.messages, validationDoc);

      if (result._tag === "Success") {
        return {
          ...state,
          allResponses: [...state.allResponses, ...result.responses],
          done: true,
          usagePromises: [...state.usagePromises, result.usagePromise],
        } satisfies IterateState;
      }

      // Retry with corrective prompt
      const correctiveMessage: Message = {
        role: "user",
        content: buildCorrectivePrompt(result.error),
      };

      return {
        attempt: state.attempt + 1,
        messages: [...state.messages, correctiveMessage],
        allResponses: [...state.allResponses, ...result.validResponses],
        done: false,
        lastError: result.error,
        usagePromises: [...state.usagePromises, result.usagePromise],
      } satisfies IterateState;
    }),
});
```

### Corrective Prompts

When validation fails, we append a corrective prompt:

```typescript
const buildCorrectivePrompt = (error: PatchValidationError): string =>
  `ERROR: Patch validation failed for selector "${error.patch.selector}": ${error.message}
Reason: ${error.reason}
Please fix the patch and continue. Remember:
- Selectors must exist in the current HTML
- If the element doesn't exist yet, create it first with a "full" response
- Use only #id selectors, not class or tag selectors`;
```

### Usage Aggregation

Since retries create multiple LLM calls, we aggregate token usage:

```typescript
const aggregatedUsage = (usages as Usage[]).reduce<AggregatedUsage>(
  (acc, usage) => ({
    inputTokens: acc.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: acc.outputTokens + (usage.outputTokens ?? 0),
    totalTokens: acc.totalTokens + (usage.totalTokens ?? 0),
    cachedTokens: acc.cachedTokens + (usage.inputTokenDetails?.cacheReadTokens ?? 0),
  }),
  initialUsage
);
```

## Components

### PatchValidator Service (`services/patch-validator.ts`)

Validates patches by **actually applying them** to a temporary happy-dom document:

```typescript
export class PatchValidator extends Effect.Service<PatchValidator>()("PatchValidator", {
  effect: Effect.gen(function* () {
    const validate = (doc: Document, patch: Patch) =>
      Effect.gen(function* () {
        const result = applyPatch(doc, patch);
        if (result._tag === "ElementNotFound") {
          yield* new PatchValidationError({ patch, reason: "selector_not_found", ... });
        }
        return patch;
      });

    const validateAll = (doc: Document, patches: readonly Patch[]) =>
      Effect.forEach(patches, (patch) => validate(doc, patch));

    const createValidationDocument = (html: string) =>
      Effect.sync(() => {
        const window = new Window();
        window.document.body.innerHTML = html;
        return window.document as unknown as Document;
      });

    return { validate, validateAll, createValidationDocument };
  }),
}) {}
```

### Error Types

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

## Trade-offs

### Current Implementation (Collect then Stream)

The current implementation collects all responses before streaming them to the client:

**Pros:**
- Simple, pure functional implementation
- Guaranteed valid responses only
- Easy to reason about

**Cons:**
- User waits for entire generation (including retries) before seeing any UI
- Higher latency for initial response

### Future: Processor Architecture

See [PROCESSOR.md](./PROCESSOR.md) for the planned durable stream architecture that will:
- Stream valid responses immediately
- Handle retries transparently via message queue
- Support page refresh resumability
