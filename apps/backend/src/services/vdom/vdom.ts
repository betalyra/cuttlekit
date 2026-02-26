import { Array as A, Effect, pipe, Ref } from "effect"
import { Window, HTMLElement as HappyHTMLElement } from "happy-dom"
import {
  applyPatch,
  type Patch,
  type ApplyPatchResult,
} from "@betalyra/generative-ui-common/client"

export type { Patch }

// ============================================================
// Types
// ============================================================

export type ComponentSpec = {
  readonly tag: string
  readonly props: readonly string[]
  readonly template: string
  readonly version: number
}

export type Registry = Map<string, ComponentSpec>

export type ApplyPatchesResult = {
  applied: number
  total: number
  errors: string[]
  html: string
}

// ============================================================
// CE rendering helpers
// ============================================================

const interpolate = (template: string, props: readonly string[], el: HappyHTMLElement) =>
  props.reduce(
    (acc, prop) => acc.replaceAll(`{${prop}}`, el.getAttribute(prop) ?? ""),
    template
  )

const makeCEShell = (registry: Registry, tag: string) => {
  const props = registry.get(tag)?.props ?? []
  return class extends HappyHTMLElement {
    static observedAttributes = [...props]
    connectedCallback() {}
    attributeChangedCallback() { if (this.isConnected) (this as any).render() }
    render() {
      const spec = registry.get(tag)
      if (!spec) return
      const existing = this.querySelector("[data-children]")
      const children = [...(existing ?? this).children]
      this.innerHTML = interpolate(spec.template, spec.props, this)
      const container = this.querySelector("[data-children]")
      if (container) children.forEach((c) => container.appendChild(c))
    }
  }
}

const renderTree = (win: InstanceType<typeof Window>, registry: Registry) =>
  pipe(
    [...win.document.querySelectorAll("*")]
      .filter((el) => registry.has(el.tagName.toLowerCase())),
    Effect.forEach((el) => Effect.sync(() => (el as any).render()))
  )

// Exported for PatchValidator's validation context
export { makeCEShell, renderTree as renderCETree }

// ============================================================
// VdomService - Manages happy-dom instances + component registry per session
// ============================================================

export class VdomService extends Effect.Service<VdomService>()("VdomService", {
  accessors: true,
  effect: Effect.gen(function* () {
    const windowsRef = yield* Ref.make(new Map<string, Window>())
    const registriesRef = yield* Ref.make(new Map<string, Registry>())

    const getOrCreateWindow = (sessionId: string) =>
      Effect.gen(function* () {
        const windows = yield* Ref.get(windowsRef)
        const existing = windows.get(sessionId)
        if (existing) return existing

        const window = yield* Effect.sync(() => new Window())
        yield* Ref.update(windowsRef, (w) => {
          const newWindows = new Map(w)
          newWindows.set(sessionId, window)
          return newWindows
        })
        return window
      })

    const getOrCreateRegistry = (sessionId: string) =>
      Effect.gen(function* () {
        const registries = yield* Ref.get(registriesRef)
        const existing = registries.get(sessionId)
        if (existing) return existing

        const registry: Registry = new Map()
        yield* Ref.update(registriesRef, (r) => {
          const newRegistries = new Map(r)
          newRegistries.set(sessionId, registry)
          return newRegistries
        })
        return registry
      })

    const INITIAL_HTML = `<div id="root" class="min-h-screen bg-[#fafafa] text-[#0a0a0a] flex items-center justify-center"><div class="text-center"><h1 class="text-2xl font-bold uppercase tracking-tight mb-2">cuttlekit</h1><p class="text-sm text-[#525252]">Create any UI you like!</p></div></div>`

    const createSession = (sessionId: string) =>
      Effect.gen(function* () {
        const window = yield* Effect.sync(() => {
          const w = new Window()
          w.document.body.innerHTML = INITIAL_HTML
          return w
        })
        yield* Ref.update(windowsRef, (windows) => {
          const newWindows = new Map(windows)
          newWindows.set(sessionId, window)
          return newWindows
        })
        yield* Ref.update(registriesRef, (registries) => {
          const newRegistries = new Map(registries)
          newRegistries.set(sessionId, new Map())
          return newRegistries
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
        const window = yield* getOrCreateWindow(sessionId)
        yield* Effect.sync(() => {
          window.document.body.innerHTML = html
        })
      })

    const define = (
      sessionId: string,
      op: { tag: string; props: string[]; template: string }
    ) =>
      Effect.gen(function* () {
        const window = yield* getOrCreateWindow(sessionId)
        const registry = yield* getOrCreateRegistry(sessionId)

        const existing = registry.get(op.tag)
        const version = existing ? existing.version + 1 : 1
        registry.set(op.tag, {
          tag: op.tag,
          props: op.props,
          template: op.template,
          version,
        })

        if (!window.customElements.get(op.tag)) {
          window.customElements.define(
            op.tag,
            makeCEShell(registry, op.tag) as any
          )
        }

        // Re-render existing instances of this tag
        yield* pipe(
          [...window.document.querySelectorAll(op.tag)],
          Effect.forEach((el) => Effect.sync(() => (el as any).render()))
        )
      })

    const getRegistry = (sessionId: string) =>
      Effect.gen(function* () {
        const registries = yield* Ref.get(registriesRef)
        return registries.get(sessionId) ?? new Map<string, ComponentSpec>()
      })

    const getCatalog = (sessionId: string) =>
      Effect.gen(function* () {
        const registry = yield* getRegistry(sessionId)
        if (registry.size === 0) return null

        return pipe(
          [...registry.values()],
          A.map((spec) => {
            const propsStr = spec.props.length > 0
              ? spec.props.map((p) => `${p}:string`).join(" ")
              : "(no props)"
            const hasChildren = spec.template.includes("data-children")
            return `<${spec.tag} ${propsStr}> — ${hasChildren ? "container" : "leaf"}\n  template: ${spec.template}`
          }),
          (lines) => lines.join("\n")
        )
      })

    const restoreRegistry = (
      sessionId: string,
      specs: readonly ComponentSpec[]
    ) =>
      Effect.gen(function* () {
        const window = yield* getOrCreateWindow(sessionId)
        const registry = yield* getOrCreateRegistry(sessionId)

        yield* pipe(
          specs,
          Effect.forEach((spec) =>
            Effect.sync(() => {
              registry.set(spec.tag, spec)
              if (!window.customElements.get(spec.tag)) {
                window.customElements.define(
                  spec.tag,
                  makeCEShell(registry, spec.tag) as any
                )
              }
            })
          )
        )
      })

    const renderAllCEs = (sessionId: string) =>
      Effect.gen(function* () {
        const windows = yield* Ref.get(windowsRef)
        const window = windows.get(sessionId)
        if (!window) return

        const registry = yield* getRegistry(sessionId)
        if (registry.size === 0) return

        yield* renderTree(window, registry)
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

        // Render CEs after structural mutations
        const hasStructuralMutation = patches.some(
          (p) => "append" in p || "prepend" in p || "html" in p
        )
        if (hasStructuralMutation) {
          const registry = yield* getRegistry(sessionId)
          if (registry.size > 0) {
            yield* renderTree(window, registry)
          }
        }

        const html = window.document.body.innerHTML

        return { applied, total: patches.length, errors, html }
      })

    const getCompactHtml = (sessionId: string) =>
      Effect.gen(function* () {
        const windows = yield* Ref.get(windowsRef)
        const window = windows.get(sessionId)
        if (!window) return null

        const registry = yield* getRegistry(sessionId)
        if (registry.size === 0) return window.document.body.innerHTML

        // Clone to avoid mutating real VDOM
        const clone = yield* Effect.sync(() =>
          window.document.body.cloneNode(true) as unknown as HappyHTMLElement
        )

        // Strip rendered CE template content, keeping only data-children content
        yield* pipe(
          [...registry.keys()],
          Effect.forEach((tag) =>
            pipe(
              [...clone.querySelectorAll(tag)],
              Effect.forEach((el) =>
                Effect.sync(() => {
                  const childrenContainer = el.querySelector("[data-children]")
                  el.innerHTML = childrenContainer ? childrenContainer.innerHTML : ""
                }),
              ),
            ),
          ),
        )

        return clone.innerHTML
      })

    const deleteSession = (sessionId: string) =>
      Effect.gen(function* () {
        yield* Ref.update(windowsRef, (windows) => {
          const window = windows.get(sessionId)
          if (window) {
            window.close()
          }
          const newWindows = new Map(windows)
          newWindows.delete(sessionId)
          return newWindows
        })
        yield* Ref.update(registriesRef, (registries) => {
          const newRegistries = new Map(registries)
          newRegistries.delete(sessionId)
          return newRegistries
        })
      })

    return {
      createSession,
      getHtml,
      getCompactHtml,
      setHtml,
      define,
      getRegistry,
      getCatalog,
      restoreRegistry,
      renderTree: renderAllCEs,
      applyPatches,
      deleteSession,
    }
  }),
}) {}
