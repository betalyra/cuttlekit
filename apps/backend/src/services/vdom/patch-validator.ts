import { Effect, Data, pipe } from "effect";
import { Window } from "happy-dom";
import { applyPatch, type Patch } from "@betalyra/generative-ui-common/client";
import { makeCEShell, renderCETree, type Registry } from "./vdom.js";

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

// CE-aware validation context — mirrors VdomService state for validation
export type ValidationContext = {
  readonly doc: Document;
  readonly window: InstanceType<typeof Window>;
  readonly registry: Registry;
};

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

      /**
       * Create a CE-aware validation context. Use this when validating streams
       * that include define and full ops alongside patches.
       */
      const createValidationContext = (html: string): Effect.Effect<ValidationContext> =>
        Effect.sync(() => {
          const window = new Window();
          window.document.body.innerHTML = html;
          return {
            doc: window.document as unknown as Document,
            window,
            registry: new Map() as Registry,
          };
        });

      /**
       * Register a component in the validation context so patches can target
       * elements inside CE templates.
       */
      const defineComponent = (
        ctx: ValidationContext,
        spec: { tag: string; props: string[]; template: string },
      ) =>
        Effect.gen(function* () {
          const existing = ctx.registry.get(spec.tag);
          const version = existing ? existing.version + 1 : 1;
          ctx.registry.set(spec.tag, {
            tag: spec.tag,
            props: spec.props,
            template: spec.template,
            version,
          });
          if (!ctx.window.customElements.get(spec.tag)) {
            ctx.window.customElements.define(
              spec.tag,
              makeCEShell(ctx.registry, spec.tag) as any,
            );
          }
          // Re-render existing instances of this tag
          yield* pipe(
            [...ctx.window.document.querySelectorAll(spec.tag)],
            Effect.forEach((el) => Effect.sync(() => (el as any).render())),
          );
        });

      /**
       * Update the validation context with full HTML and render CEs so
       * elements inside CE templates become available for subsequent patches.
       */
      const setFullHtml = (ctx: ValidationContext, html: string) =>
        Effect.gen(function* () {
          ctx.window.document.body.innerHTML = html;
          if (ctx.registry.size > 0) {
            yield* renderCETree(ctx.window, ctx.registry);
          }
        });

      return {
        validate,
        validateAll,
        createValidationDocument,
        createValidationContext,
        defineComponent,
        setFullHtml,
      };
    }),
  },
) {}
