/**
 * Patch types for DOM manipulation.
 * Used by both frontend (browser DOM) and backend (happy-dom).
 */
export type Patch =
  | { selector: string; text: string }
  | { selector: string; attr: Record<string, string | null> }
  | { selector: string; append: string }
  | { selector: string; prepend: string }
  | { selector: string; html: string }
  | { selector: string; remove: true };

export type ApplyPatchResult =
  | { _tag: "Success" }
  | { _tag: "ElementNotFound"; selector: string }
  | { _tag: "Error"; selector: string; error: string };

/**
 * Apply a single patch to a document.
 * Works with both browser DOM and happy-dom.
 *
 * @param doc - Document or DocumentFragment to apply patch to
 * @param patch - The patch to apply
 * @returns Result indicating success or failure
 */
export const applyPatch = (
  doc: Document | DocumentFragment,
  patch: Patch
): ApplyPatchResult => {
  const el =
    "querySelector" in doc
      ? doc.querySelector(patch.selector)
      : (doc as Document).querySelector(patch.selector);

  if (!el) {
    return { _tag: "ElementNotFound", selector: patch.selector };
  }

  try {
    if ("text" in patch) {
      el.textContent = patch.text;
    } else if ("attr" in patch) {
      Object.entries(patch.attr).forEach(([key, value]) => {
        if (value === null) {
          el.removeAttribute(key);
        } else {
          el.setAttribute(key, value);
        }
      });
    } else if ("append" in patch) {
      el.insertAdjacentHTML("beforeend", patch.append);
    } else if ("prepend" in patch) {
      el.insertAdjacentHTML("afterbegin", patch.prepend);
    } else if ("html" in patch) {
      el.innerHTML = patch.html;
    } else if ("remove" in patch) {
      el.remove();
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
 *
 * @param doc - Document to apply patches to
 * @param patches - Array of patches to apply
 * @returns Summary of applied patches
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
  if ("html" in patch) return patch.html;
  if ("append" in patch) return patch.append;
  if ("prepend" in patch) return patch.prepend;
  return null;
};
