/**
 * Patch type for DOM manipulation.
 * Single flat object — all operation fields optional, apply whichever are present.
 * Used by both frontend (browser DOM) and backend (happy-dom).
 */
export type Patch = {
  selector: string;
  text?: string;
  attr?: Record<string, string | null>;
  append?: string;
  prepend?: string;
  html?: string;
  remove?: true;
};

export type ApplyPatchResult =
  | { _tag: "Success" }
  | { _tag: "ElementNotFound"; selector: string }
  | { _tag: "Error"; selector: string; error: string };

// Bare #id selector — no CSS combinators, pseudo-classes, etc.
const isSimpleIdSelector = (s: string): boolean =>
  s.startsWith("#") && !/[\s>+~,:.[\]()]/.test(s.slice(1));

/**
 * Apply a single patch to a document.
 * Works with both browser DOM and happy-dom.
 * Applies all present fields — attr, then content mutations.
 */
export const applyPatch = (
  doc: Document | DocumentFragment,
  patch: Patch
): ApplyPatchResult => {
  // Use getElementById for bare #id selectors to avoid CSS parsing issues
  // with IDs that start with digits (e.g. UUIDs like #65688b32-...)
  let el: Element | null;
  try {
    el =
      isSimpleIdSelector(patch.selector) && "getElementById" in doc
        ? (doc as Document).getElementById(patch.selector.slice(1))
        : doc.querySelector(patch.selector);
  } catch (e) {
    return {
      _tag: "Error",
      selector: patch.selector,
      error: `Invalid selector: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (!el) {
    return { _tag: "ElementNotFound", selector: patch.selector };
  }

  try {
    if (patch.remove) {
      el.remove();
      return { _tag: "Success" };
    }
    if (patch.attr) {
      Object.entries(patch.attr).forEach(([key, value]) => {
        if (value === null) {
          el.removeAttribute(key);
        } else {
          el.setAttribute(key, value);
        }
      });
    }
    if (patch.text !== undefined) {
      el.textContent = patch.text;
    }
    if (patch.html !== undefined) {
      el.innerHTML = patch.html;
    }
    if (patch.append) {
      el.insertAdjacentHTML("beforeend", patch.append);
    }
    if (patch.prepend) {
      el.insertAdjacentHTML("afterbegin", patch.prepend);
    }
    return { _tag: "Success" };
  } catch (e) {
    return {
      _tag: "Error",
      selector: patch.selector,
      error: e instanceof Error ? e.message : String(e),
    };
  }
};

/**
 * Apply multiple patches to a document.
 */
export const applyPatches = (
  doc: Document | DocumentFragment,
  patches: readonly Patch[]
): {
  applied: number;
  total: number;
  results: ApplyPatchResult[];
} => {
  const results = patches.map((patch) => applyPatch(doc, patch));
  const applied = results.filter((r) => r._tag === "Success").length;

  return {
    applied,
    total: patches.length,
    results,
  };
};

/**
 * Extract HTML content from a patch if it contains any.
 * Useful for font/icon loading.
 */
export const getPatchHtmlContent = (patch: Patch): string | null => {
  if (patch.html) return patch.html;
  if (patch.append) return patch.append;
  if (patch.prepend) return patch.prepend;
  return null;
};
