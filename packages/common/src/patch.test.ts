import { describe, expect, it } from "@effect/vitest";
import { Window } from "happy-dom";
import {
  applyPatch,
  applyPatches,
  getPatchHtmlContent,
  type Patch,
} from "./patch.js";

const createDoc = (html: string): Document => {
  const window = new Window();
  window.document.body.innerHTML = html;
  return window.document as unknown as Document;
};

describe("applyPatch", () => {
  describe("text patch", () => {
    it("sets text content", () => {
      const doc = createDoc('<div id="target">old text</div>');
      const patch: Patch = { selector: "#target", text: "new text" };

      const result = applyPatch(doc, patch);

      expect(result._tag).toBe("Success");
      expect(doc.querySelector("#target")?.textContent).toBe("new text");
    });

    it("replaces HTML with plain text", () => {
      const doc = createDoc('<div id="target"><span>nested</span></div>');
      const patch: Patch = { selector: "#target", text: "plain text" };

      applyPatch(doc, patch);

      expect(doc.querySelector("#target")?.innerHTML).toBe("plain text");
      expect(doc.querySelector("#target span")).toBeNull();
    });
  });

  describe("attr patch", () => {
    it("sets attributes", () => {
      const doc = createDoc('<div id="target">content</div>');
      const patch: Patch = {
        selector: "#target",
        attr: { class: "new-class", "data-id": "123" },
      };

      const result = applyPatch(doc, patch);

      expect(result._tag).toBe("Success");
      expect(doc.querySelector("#target")?.getAttribute("class")).toBe(
        "new-class"
      );
      expect(doc.querySelector("#target")?.getAttribute("data-id")).toBe("123");
    });

    it("removes attributes when value is null", () => {
      const doc = createDoc('<div id="target" class="old" data-remove="yes">content</div>');
      const patch: Patch = {
        selector: "#target",
        attr: { class: "updated", "data-remove": null },
      };

      applyPatch(doc, patch);

      expect(doc.querySelector("#target")?.getAttribute("class")).toBe(
        "updated"
      );
      expect(doc.querySelector("#target")?.hasAttribute("data-remove")).toBe(
        false
      );
    });
  });

  describe("html patch", () => {
    it("replaces innerHTML", () => {
      const doc = createDoc('<div id="target">old</div>');
      const patch: Patch = {
        selector: "#target",
        html: "<span>new</span><b>content</b>",
      };

      const result = applyPatch(doc, patch);

      expect(result._tag).toBe("Success");
      expect(doc.querySelector("#target")?.innerHTML).toBe(
        "<span>new</span><b>content</b>"
      );
    });

    it("can clear content with empty string", () => {
      const doc = createDoc('<div id="target">content</div>');
      const patch: Patch = { selector: "#target", html: "" };

      applyPatch(doc, patch);

      expect(doc.querySelector("#target")?.innerHTML).toBe("");
    });
  });

  describe("append patch", () => {
    it("appends HTML to end", () => {
      const doc = createDoc('<ul id="list"><li>first</li></ul>');
      const patch: Patch = { selector: "#list", append: "<li>second</li>" };

      const result = applyPatch(doc, patch);

      expect(result._tag).toBe("Success");
      expect(doc.querySelector("#list")?.innerHTML).toBe(
        "<li>first</li><li>second</li>"
      );
    });

    it("appends multiple elements", () => {
      const doc = createDoc('<div id="container"></div>');
      const patch: Patch = {
        selector: "#container",
        append: "<span>a</span><span>b</span>",
      };

      applyPatch(doc, patch);

      expect(doc.querySelectorAll("#container span").length).toBe(2);
    });
  });

  describe("prepend patch", () => {
    it("prepends HTML to start", () => {
      const doc = createDoc('<ul id="list"><li>second</li></ul>');
      const patch: Patch = { selector: "#list", prepend: "<li>first</li>" };

      const result = applyPatch(doc, patch);

      expect(result._tag).toBe("Success");
      expect(doc.querySelector("#list")?.innerHTML).toBe(
        "<li>first</li><li>second</li>"
      );
    });
  });

  describe("remove patch", () => {
    it("removes element from DOM", () => {
      const doc = createDoc(
        '<div id="container"><span id="target">remove me</span><span>keep</span></div>'
      );
      const patch: Patch = { selector: "#target", remove: true };

      const result = applyPatch(doc, patch);

      expect(result._tag).toBe("Success");
      expect(doc.querySelector("#target")).toBeNull();
      expect(doc.querySelector("#container span")?.textContent).toBe("keep");
    });
  });

  describe("error handling", () => {
    it("returns ElementNotFound when selector not found", () => {
      const doc = createDoc('<div id="other">content</div>');
      const patch: Patch = { selector: "#nonexistent", text: "new" };

      const result = applyPatch(doc, patch);

      expect(result._tag).toBe("ElementNotFound");
      if (result._tag === "ElementNotFound") {
        expect(result.selector).toBe("#nonexistent");
      }
    });

    it("handles IDs starting with a digit (UUIDs)", () => {
      const doc = createDoc(
        '<div id="65688b32-3739-4e4b-ad5c-656aed00b7fc">content</div>'
      );
      const patch: Patch = {
        selector: "#65688b32-3739-4e4b-ad5c-656aed00b7fc",
        text: "updated",
      };

      const result = applyPatch(doc, patch);

      expect(result._tag).toBe("Success");
      expect(
        doc.getElementById("65688b32-3739-4e4b-ad5c-656aed00b7fc")?.textContent
      ).toBe("updated");
    });

    it("handles complex selectors", () => {
      const doc = createDoc(
        '<div class="container"><span data-id="123">target</span></div>'
      );
      const patch: Patch = {
        selector: ".container span[data-id='123']",
        text: "found",
      };

      const result = applyPatch(doc, patch);

      expect(result._tag).toBe("Success");
      expect(doc.querySelector("span")?.textContent).toBe("found");
    });
  });
});

describe("applyPatches", () => {
  it("applies multiple patches in order", () => {
    const doc = createDoc(
      '<div id="a">a</div><div id="b">b</div><div id="c">c</div>'
    );
    const patches: Patch[] = [
      { selector: "#a", text: "A" },
      { selector: "#b", attr: { class: "styled" } },
      { selector: "#c", html: "<span>C</span>" },
    ];

    const result = applyPatches(doc, patches);

    expect(result.applied).toBe(3);
    expect(result.total).toBe(3);
    expect(doc.querySelector("#a")?.textContent).toBe("A");
    expect(doc.querySelector("#b")?.getAttribute("class")).toBe("styled");
    expect(doc.querySelector("#c span")?.textContent).toBe("C");
  });

  it("continues after failed patches", () => {
    const doc = createDoc('<div id="a">a</div><div id="c">c</div>');
    const patches: Patch[] = [
      { selector: "#a", text: "A" },
      { selector: "#b", text: "B" }, // Will fail
      { selector: "#c", text: "C" },
    ];

    const result = applyPatches(doc, patches);

    expect(result.applied).toBe(2);
    expect(result.total).toBe(3);
    expect(result.results[1]._tag).toBe("ElementNotFound");
  });

  it("handles empty patches array", () => {
    const doc = createDoc("<div>content</div>");

    const result = applyPatches(doc, []);

    expect(result.applied).toBe(0);
    expect(result.total).toBe(0);
    expect(result.results).toEqual([]);
  });
});

describe("getPatchHtmlContent", () => {
  it("returns html content from html patch", () => {
    const patch: Patch = { selector: "#x", html: "<span>content</span>" };
    expect(getPatchHtmlContent(patch)).toBe("<span>content</span>");
  });

  it("returns html content from append patch", () => {
    const patch: Patch = { selector: "#x", append: "<li>item</li>" };
    expect(getPatchHtmlContent(patch)).toBe("<li>item</li>");
  });

  it("returns html content from prepend patch", () => {
    const patch: Patch = { selector: "#x", prepend: "<li>first</li>" };
    expect(getPatchHtmlContent(patch)).toBe("<li>first</li>");
  });

  it("returns null for text patch", () => {
    const patch: Patch = { selector: "#x", text: "plain text" };
    expect(getPatchHtmlContent(patch)).toBeNull();
  });

  it("returns null for attr patch", () => {
    const patch: Patch = { selector: "#x", attr: { class: "new" } };
    expect(getPatchHtmlContent(patch)).toBeNull();
  });

  it("returns null for remove patch", () => {
    const patch: Patch = { selector: "#x", remove: true };
    expect(getPatchHtmlContent(patch)).toBeNull();
  });
});
