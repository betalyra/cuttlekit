import "./style.css"

type GenerateRequest = {
  type: "generate"
  prompt?: string
  sessionId?: string
  action?: string
  actionData?: Record<string, unknown>
}

type Response = {
  type: "full-page" | "partial-update" | "message"
  html?: string
  message?: string
  sessionId: string
}

const app = {
  sessionId: null as string | null,
  loading: false,

  getElements() {
    return {
      app: document.getElementById("app")!,
      loadingEl: document.getElementById("loading")!,
      errorEl: document.getElementById("error")!,
      contentEl: document.getElementById("content")!,
    }
  },

  setLoading(loading: boolean, isInitial = false) {
    this.loading = loading
    const { loadingEl, contentEl } = this.getElements()

    // Only show full loading screen on initial load (no content yet)
    // For subsequent requests, keep content visible (smoother UX)
    if (isInitial) {
      loadingEl.style.display = loading ? "flex" : "none"
      contentEl.style.display = loading ? "none" : "block"
    } else {
      loadingEl.style.display = "none"
      contentEl.style.display = "block"
      // Could add a subtle loading indicator here (e.g., opacity, spinner overlay)
      contentEl.style.opacity = loading ? "0.7" : "1"
    }
  },

  setError(error: string | null) {
    const { errorEl, contentEl } = this.getElements()
    if (error) {
      errorEl.style.display = "flex"
      errorEl.querySelector("span")!.textContent = error
      contentEl.style.display = "none"
    } else {
      errorEl.style.display = "none"
    }
  },

  async sendRequest(request: GenerateRequest, isInitial = false) {
    try {
      this.setLoading(true, isInitial)
      this.setError(null)

      const requestWithSession = {
        ...request,
        sessionId: this.sessionId || undefined,
      }

      const response = await fetch("http://localhost:34512/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestWithSession),
      })

      if (!response.ok) {
        throw new Error("Failed to generate content")
      }

      const data = (await response.json()) as Response
      this.sessionId = data.sessionId

      if (data.type === "full-page" && data.html) {
        this.getElements().contentEl.innerHTML = data.html
      }
    } catch (err) {
      this.setError(err instanceof Error ? err.message : String(err))
    } finally {
      this.setLoading(false, isInitial)
    }
  },

  collectFormData(): Record<string, unknown> {
    const formData: Record<string, unknown> = {}

    document.querySelectorAll("input, textarea, select").forEach((input) => {
      const el = input as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      const key = el.id || el.name
      if (!key) return

      if (el instanceof HTMLInputElement && el.type === "checkbox") {
        formData[key] = el.checked
      } else if (el instanceof HTMLInputElement && el.type === "radio") {
        if (el.checked) formData[key] = el.value
      } else {
        formData[key] = el.value
      }
    })

    return formData
  },

  triggerAction(actionElement: Element) {
    const action = actionElement.getAttribute("data-action")
    const actionDataAttr = actionElement.getAttribute("data-action-data")

    const formData = this.collectFormData()
    const actionData = actionDataAttr ? JSON.parse(actionDataAttr) : {}
    const mergedData = { ...formData, ...actionData }

    this.sendRequest({
      type: "generate",
      action: action || undefined,
      actionData: Object.keys(mergedData).length > 0 ? mergedData : undefined,
    })
  },

  init() {
    // Click handler for data-action elements
    document.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-action]")
      if (el) {
        e.preventDefault()
        this.triggerAction(el)
      }
    })

    // Enter key handler
    document.addEventListener("keydown", (e) => {
      const target = e.target as HTMLElement
      const isInput = target instanceof HTMLInputElement
      const isTextarea = target instanceof HTMLTextAreaElement

      if (e.key === "Enter" && (isInput || isTextarea)) {
        // Textarea needs Ctrl/Cmd+Enter
        if (isTextarea && !e.ctrlKey && !e.metaKey) return

        e.preventDefault()

        // Check if input itself has data-action
        if (target.hasAttribute("data-action")) {
          this.triggerAction(target)
          return
        }

        // Find nearest action button in container
        const container = target.closest("div, form, section") || document.body
        const actionButton = container.querySelector("[data-action]")
        if (actionButton) {
          this.triggerAction(actionButton)
        }
      }
    })

    // Initial load
    this.sendRequest({ type: "generate" }, true)
  },
}

// Start the app
app.init()
