import { Effect, Data } from "effect";
import { Window } from "happy-dom";
import { applyPatch, type Patch } from "@betalyra/generative-ui-common/client";

export type { Patch };

export type PatchValidationErrorReason =
  | "selector_not_found"
  | "empty_selector"
  | "apply_error";

export class PatchValidationError extends Data.TaggedError(
  "PatchValidationError"
)<{
  patch: Patch;
  reason: PatchValidationErrorReason;
  message: string;
}> {}

export class PatchValidator extends Effect.Service<PatchValidator>()(
  "PatchValidator",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      /**
       * Validate a patch by actually applying it to the document.
       * Returns the patch if valid, fails with PatchValidationError if invalid.
       */
      const validate = (doc: Document, patch: Patch) =>
        Effect.gen(function* () {
          // Check for empty selector
          if (!patch.selector || patch.selector.trim() === "") {
            yield* new PatchValidationError({
              patch,
              reason: "empty_selector",
              message: "Patch selector is empty",
            });
          }

          // Apply the patch and check the result
          const result = applyPatch(doc, patch);

          if (result._tag === "ElementNotFound") {
            yield* new PatchValidationError({
              patch,
              reason: "selector_not_found",
              message: `Element not found: ${result.selector}`,
            });
          }

          if (result._tag === "Error") {
            yield* new PatchValidationError({
              patch,
              reason: "apply_error",
              message: `Failed to apply patch: ${result.error}`,
            });
          }

          return patch;
        });

      /**
       * Validate multiple patches against a document.
       * Applies patches sequentially, fails on the first invalid patch.
       */
      const validateAll = (doc: Document, patches: readonly Patch[]) =>
        Effect.forEach(patches, (patch) => validate(doc, patch));

      /**
       * Create a temporary document for validation without affecting any session.
       */
      const createValidationDocument = (html: string) =>
        Effect.sync(() => {
          const window = new Window();
          window.document.body.innerHTML = html;
          return window.document as unknown as Document;
        });

      return { validate, validateAll, createValidationDocument };
    }),
  }
) {}
