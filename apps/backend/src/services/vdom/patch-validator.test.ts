import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import {
  PatchValidator,
  PatchValidationError,
  type Patch,
} from "./patch-validator.js";

describe("PatchValidator", () => {
  describe("validate", () => {
    it.effect("applies text patch and returns it", () =>
      Effect.gen(function* () {
        const validator = yield* PatchValidator;
        const doc = yield* validator.createValidationDocument(
          '<div id="target">old text</div>'
        );

        const patch: Patch = { selector: "#target", text: "new text" };
        const result = yield* validator.validate(doc, patch);

        expect(result).toEqual(patch);
        // Verify patch was actually applied
        expect(doc.querySelector("#target")?.textContent).toBe("new text");
      }).pipe(Effect.provide(PatchValidator.Default))
    );

    it.effect("applies attr patch and returns it", () =>
      Effect.gen(function* () {
        const validator = yield* PatchValidator;
        const doc = yield* validator.createValidationDocument(
          '<div id="target" class="old">content</div>'
        );

        const patch: Patch = {
          selector: "#target",
          attr: { class: "new-class", "data-test": "value" },
        };
        const result = yield* validator.validate(doc, patch);

        expect(result).toEqual(patch);
        expect(doc.querySelector("#target")?.getAttribute("class")).toBe(
          "new-class"
        );
        expect(doc.querySelector("#target")?.getAttribute("data-test")).toBe(
          "value"
        );
      }).pipe(Effect.provide(PatchValidator.Default))
    );

    it.effect("applies html patch and returns it", () =>
      Effect.gen(function* () {
        const validator = yield* PatchValidator;
        const doc = yield* validator.createValidationDocument(
          '<div id="target">old</div>'
        );

        const patch: Patch = {
          selector: "#target",
          html: "<span>new content</span>",
        };
        const result = yield* validator.validate(doc, patch);

        expect(result).toEqual(patch);
        expect(doc.querySelector("#target span")?.textContent).toBe(
          "new content"
        );
      }).pipe(Effect.provide(PatchValidator.Default))
    );

    it.effect("applies append patch and returns it", () =>
      Effect.gen(function* () {
        const validator = yield* PatchValidator;
        const doc = yield* validator.createValidationDocument(
          '<ul id="list"><li>first</li></ul>'
        );

        const patch: Patch = { selector: "#list", append: "<li>second</li>" };
        const result = yield* validator.validate(doc, patch);

        expect(result).toEqual(patch);
        expect(doc.querySelectorAll("#list li").length).toBe(2);
        expect(doc.querySelector("#list")?.innerHTML).toContain("second");
      }).pipe(Effect.provide(PatchValidator.Default))
    );

    it.effect("applies prepend patch and returns it", () =>
      Effect.gen(function* () {
        const validator = yield* PatchValidator;
        const doc = yield* validator.createValidationDocument(
          '<ul id="list"><li>second</li></ul>'
        );

        const patch: Patch = { selector: "#list", prepend: "<li>first</li>" };
        const result = yield* validator.validate(doc, patch);

        expect(result).toEqual(patch);
        expect(doc.querySelector("#list li")?.textContent).toBe("first");
      }).pipe(Effect.provide(PatchValidator.Default))
    );

    it.effect("applies remove patch and returns it", () =>
      Effect.gen(function* () {
        const validator = yield* PatchValidator;
        const doc = yield* validator.createValidationDocument(
          '<div id="container"><span id="target">remove me</span></div>'
        );

        const patch: Patch = { selector: "#target", remove: true };
        const result = yield* validator.validate(doc, patch);

        expect(result).toEqual(patch);
        expect(doc.querySelector("#target")).toBeNull();
      }).pipe(Effect.provide(PatchValidator.Default))
    );

    it.effect("fails when selector not found", () =>
      Effect.gen(function* () {
        const validator = yield* PatchValidator;
        const doc = yield* validator.createValidationDocument(
          '<div id="other">content</div>'
        );

        const patch: Patch = { selector: "#nonexistent", text: "new" };
        const exit = yield* Effect.exit(validator.validate(doc, patch));

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = exit.cause;
          expect(error._tag).toBe("Fail");
          if (error._tag === "Fail") {
            expect(error.error).toBeInstanceOf(PatchValidationError);
            expect(error.error.reason).toBe("selector_not_found");
            expect(error.error.message).toContain("#nonexistent");
          }
        }
      }).pipe(Effect.provide(PatchValidator.Default))
    );

    it.effect("fails when selector is empty", () =>
      Effect.gen(function* () {
        const validator = yield* PatchValidator;
        const doc = yield* validator.createValidationDocument(
          "<div>content</div>"
        );

        const patch: Patch = { selector: "", text: "new" };
        const exit = yield* Effect.exit(validator.validate(doc, patch));

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = exit.cause;
          if (error._tag === "Fail") {
            expect(error.error.reason).toBe("empty_selector");
          }
        }
      }).pipe(Effect.provide(PatchValidator.Default))
    );

    it.effect("fails when selector is whitespace only", () =>
      Effect.gen(function* () {
        const validator = yield* PatchValidator;
        const doc = yield* validator.createValidationDocument(
          "<div>content</div>"
        );

        const patch: Patch = { selector: "   ", text: "new" };
        const exit = yield* Effect.exit(validator.validate(doc, patch));

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = exit.cause;
          if (error._tag === "Fail") {
            expect(error.error.reason).toBe("empty_selector");
          }
        }
      }).pipe(Effect.provide(PatchValidator.Default))
    );
  });

  describe("validateAll", () => {
    it.effect("applies multiple patches in order", () =>
      Effect.gen(function* () {
        const validator = yield* PatchValidator;
        const doc = yield* validator.createValidationDocument(
          '<div id="a">a</div><div id="b">b</div><div id="c">c</div>'
        );

        const patches: Patch[] = [
          { selector: "#a", text: "A" },
          { selector: "#b", attr: { class: "styled" } },
          { selector: "#c", html: "<span>C</span>" },
        ];
        const result = yield* validator.validateAll(doc, patches);

        expect(result).toEqual(patches);
        // Verify all patches were applied
        expect(doc.querySelector("#a")?.textContent).toBe("A");
        expect(doc.querySelector("#b")?.getAttribute("class")).toBe("styled");
        expect(doc.querySelector("#c span")?.textContent).toBe("C");
      }).pipe(Effect.provide(PatchValidator.Default))
    );

    it.effect("fails on first invalid patch", () =>
      Effect.gen(function* () {
        const validator = yield* PatchValidator;
        const doc = yield* validator.createValidationDocument(
          '<div id="a">a</div><div id="c">c</div>'
        );

        const patches: Patch[] = [
          { selector: "#a", text: "A" },
          { selector: "#b", text: "B" }, // Will fail - element doesn't exist
          { selector: "#c", text: "C" },
        ];
        const exit = yield* Effect.exit(validator.validateAll(doc, patches));

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = exit.cause;
          if (error._tag === "Fail") {
            expect(error.error.reason).toBe("selector_not_found");
            expect(error.error.patch.selector).toBe("#b");
          }
        }
        // First patch should have been applied before failure
        expect(doc.querySelector("#a")?.textContent).toBe("A");
        // Third patch should NOT have been applied
        expect(doc.querySelector("#c")?.textContent).toBe("c");
      }).pipe(Effect.provide(PatchValidator.Default))
    );

    it.effect("succeeds for empty patches array", () =>
      Effect.gen(function* () {
        const validator = yield* PatchValidator;
        const doc = yield* validator.createValidationDocument("<div>x</div>");

        const result = yield* validator.validateAll(doc, []);

        expect(result).toEqual([]);
      }).pipe(Effect.provide(PatchValidator.Default))
    );

    it.effect("patches can build on previous patches", () =>
      Effect.gen(function* () {
        const validator = yield* PatchValidator;
        const doc = yield* validator.createValidationDocument(
          '<div id="container"></div>'
        );

        const patches: Patch[] = [
          { selector: "#container", html: '<span id="child">child</span>' },
          { selector: "#child", text: "updated child" }, // Targets element created by previous patch
        ];
        const result = yield* validator.validateAll(doc, patches);

        expect(result).toEqual(patches);
        expect(doc.querySelector("#child")?.textContent).toBe("updated child");
      }).pipe(Effect.provide(PatchValidator.Default))
    );
  });

  describe("createValidationDocument", () => {
    it.effect("creates document with provided HTML", () =>
      Effect.gen(function* () {
        const validator = yield* PatchValidator;
        const doc = yield* validator.createValidationDocument(
          '<div id="test">hello</div>'
        );

        const element = doc.querySelector("#test");
        expect(element).not.toBeNull();
        expect(element?.textContent).toBe("hello");
      }).pipe(Effect.provide(PatchValidator.Default))
    );

    it.effect("creates empty document for empty HTML", () =>
      Effect.gen(function* () {
        const validator = yield* PatchValidator;
        const doc = yield* validator.createValidationDocument("");

        expect(doc.body.innerHTML).toBe("");
      }).pipe(Effect.provide(PatchValidator.Default))
    );
  });
});
