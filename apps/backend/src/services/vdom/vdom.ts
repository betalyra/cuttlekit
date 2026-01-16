import { Array as A, Effect, pipe, Ref } from "effect"
import { Window } from "happy-dom"
import {
  applyPatch,
  type Patch,
  type ApplyPatchResult,
} from "@betalyra/generative-ui-common/client"

export type { Patch }

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

        const doc = window.document as unknown as Document
        const results = patches.map((patch) => applyPatch(doc, patch))

        const errors = pipe(
          results,
          A.filter((r): r is ApplyPatchResult & { _tag: "ElementNotFound" | "Error" } =>
            r._tag === "ElementNotFound" || r._tag === "Error"
          ),
          A.map((r) =>
            r._tag === "ElementNotFound"
              ? `Element not found: ${r.selector}`
              : `Error: ${r.error}`
          )
        )

        const applied = pipe(
          results,
          A.filter((r) => r._tag === "Success"),
          A.length
        )

        const html = window.document.body.innerHTML

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
