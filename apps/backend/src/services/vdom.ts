import { Array as A, Effect, pipe, Ref } from "effect"
import { Window } from "happy-dom"

// ============================================================
// Patch Types - What the LLM generates
// ============================================================

export type Patch =
  | { selector: string; text: string }
  | { selector: string; attr: Record<string, string | null> }
  | { selector: string; append: string }
  | { selector: string; prepend: string }
  | { selector: string; html: string }
  | { selector: string; remove: true }

export type PatchResult =
  | { _tag: "Success" }
  | { _tag: "Error"; error: string }

export type ApplyPatchesResult = {
  applied: number
  total: number
  errors: string[]
  html: string
}

// ============================================================
// VdomService - Manages happy-dom instances per session
// ============================================================

export class VdomService extends Effect.Service<VdomService>()("VdomService", {
  accessors: true,
  effect: Effect.gen(function* () {
    // Store happy-dom Window instances per session
    const windowsRef = yield* Ref.make(new Map<string, Window>())

    const applyPatch = (doc: Document, patch: Patch): Effect.Effect<PatchResult> =>
      Effect.sync(() => {
        const el = doc.querySelector(patch.selector)
        if (!el) {
          return { _tag: "Error" as const, error: `Element not found: ${patch.selector}` }
        }

        try {
          if ("text" in patch) {
            el.textContent = patch.text
          } else if ("attr" in patch) {
            Object.entries(patch.attr).forEach(([key, value]) => {
              if (value === null) {
                el.removeAttribute(key)
              } else {
                el.setAttribute(key, value)
              }
            })
          } else if ("append" in patch) {
            el.insertAdjacentHTML("beforeend", patch.append)
          } else if ("prepend" in patch) {
            el.insertAdjacentHTML("afterbegin", patch.prepend)
          } else if ("html" in patch) {
            el.innerHTML = patch.html
          } else if ("remove" in patch) {
            el.remove()
          }
          return { _tag: "Success" as const }
        } catch (e) {
          return { _tag: "Error" as const, error: `Failed to apply patch: ${e}` }
        }
      })

    const createSession = (sessionId: string) =>
      Effect.gen(function* () {
        const window = yield* Effect.sync(() => new Window())
        yield* Ref.update(windowsRef, (windows) => {
          const newWindows = new Map(windows)
          newWindows.set(sessionId, window)
          return newWindows
        })
      })

    const getHtml = (sessionId: string) =>
      Effect.gen(function* () {
        const windows = yield* Ref.get(windowsRef)
        const window = windows.get(sessionId)
        return window ? window.document.body.innerHTML : null
      })

    const setHtml = (sessionId: string, html: string) =>
      Effect.gen(function* () {
        const windows = yield* Ref.get(windowsRef)
        const existingWindow = windows.get(sessionId)

        if (existingWindow) {
          yield* Effect.sync(() => {
            existingWindow.document.body.innerHTML = html
          })
        } else {
          const window = yield* Effect.sync(() => new Window())
          yield* Effect.sync(() => {
            window.document.body.innerHTML = html
          })
          yield* Ref.update(windowsRef, (w) => {
            const newWindows = new Map(w)
            newWindows.set(sessionId, window)
            return newWindows
          })
        }
      })

    const applyPatches = (sessionId: string, patches: Patch[]) =>
      Effect.gen(function* () {
        const windows = yield* Ref.get(windowsRef)
        const window = windows.get(sessionId)

        if (!window) {
          return {
            applied: 0,
            total: patches.length,
            errors: ["Session not found"],
            html: ""
          }
        }

        const results = yield* pipe(
          patches,
          Effect.forEach((patch) => applyPatch(window.document as unknown as Document, patch))
        )

        const errors = pipe(
          results,
          A.filter((r): r is { _tag: "Error"; error: string } => r._tag === "Error"),
          A.map((r) => r.error)
        )

        const applied = pipe(
          results,
          A.filter((r) => r._tag === "Success"),
          A.length
        )

        const html = yield* Effect.sync(() => window.document.body.innerHTML)

        return { applied, total: patches.length, errors, html }
      })

    const deleteSession = (sessionId: string) =>
      Ref.update(windowsRef, (windows) => {
        const window = windows.get(sessionId)
        if (window) {
          window.close()
        }
        const newWindows = new Map(windows)
        newWindows.delete(sessionId)
        return newWindows
      })

    return { createSession, getHtml, setHtml, applyPatches, deleteSession }
  }),
}) {}
