import "./style.css"
import { loadFontsFromHTML } from "./fonts"
import { loadIconsFromHTML } from "./icons"

type GenerateRequest = {
  type: "generate"
  prompt?: string
  sessionId?: string
  action?: string
  actionData?: Record<string, unknown>
  currentHtml?: string
}

type Response = {
  type: "full-page" | "partial-update" | "message"
  html?: string
  message?: string
  sessionId: string
}

// Patch types matching backend
type Patch =
  | { selector: string; text: string }
  | { selector: string; attr: Record<string, string | null> }
  | { selector: string; append: string }
  | { selector: string; prepend: string }
  | { selector: string; html: string }
  | { selector: string; remove: true }

// Stream event types
type StreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "patch"; patch: Patch }
  | { type: "html"; html: string }
  | { type: "done"; html: string }

// Initial intro HTML - sent as currentHtml on first request
const INITIAL_HTML = `<div class="flex items-center justify-center min-h-[calc(100vh-4rem)]">
  <div class="text-center max-w-md px-4">
    <h1 class="text-2xl font-light text-[#0a0a0a] mb-4">Generative UI</h1>
    <p class="text-sm text-[#525252] leading-relaxed">
      Describe what you want to create. A dashboard, a form, a game — anything you can imagine.
    </p>
  </div>
</div>`

const app = {
  sessionId: null as string | null,
  loading: false,

  getElements() {
    return {
      app: document.getElementById("app")!,
      loadingEl: document.getElementById("loading")!,
      errorEl: document.getElementById("error")!,
      contentEl: document.getElementById("content")!,
      promptInput: document.getElementById("prompt-input") as HTMLInputElement,
      sendBtn: document.getElementById("send-btn")!,
      resetBtn: document.getElementById("reset-btn")!,
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

  // Extract HTML content from a patch for font loading
  extractPatchContent(patch: Patch): string | null {
    if ("html" in patch) return patch.html
    if ("append" in patch) return patch.append
    if ("prepend" in patch) return patch.prepend
    if ("attr" in patch && patch.attr.style) return patch.attr.style
    return null
  },

  // Apply a single patch to the DOM
  applyPatch(patch: Patch) {
    const el = document.querySelector(patch.selector)
    if (!el) {
      console.warn(`Patch target not found: ${patch.selector}`)
      return
    }

    // Load fonts and icons from patch content
    const content = this.extractPatchContent(patch)
    if (content) {
      loadFontsFromHTML(content)
      loadIconsFromHTML(content)
    }

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
  },

  handleStreamEvent(event: StreamEvent) {
    switch (event.type) {
      case "session":
        this.sessionId = event.sessionId
        break
      case "patch":
        this.applyPatch(event.patch)
        break
      case "html":
        this.getElements().contentEl.innerHTML = event.html
        loadFontsFromHTML(event.html)
        loadIconsFromHTML(event.html)
        break
      case "done":
        // Final state - stream complete
        loadFontsFromHTML(event.html)
        loadIconsFromHTML(event.html)
        break
    }
  },

  // Stream request using SSE for real-time patch updates
  async sendStreamRequest(request: GenerateRequest) {
    try {
      this.setLoading(true, false)
      this.setError(null)

      const currentHtml = this.getElements().contentEl.innerHTML || undefined

      const requestWithSession = {
        ...request,
        sessionId: this.sessionId || undefined,
        currentHtml: currentHtml && currentHtml.trim() ? currentHtml : undefined,
      }

      const response = await fetch("http://localhost:34512/generate/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestWithSession),
      })

      if (!response.ok) {
        throw new Error("Failed to start stream")
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error("No response body")

      const decoder = new TextDecoder()
      let buffer = ""
      let currentEvent = ""
      let currentData = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Parse SSE events from buffer
        const lines = buffer.split("\n")
        buffer = lines.pop() || "" // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7)
          } else if (line.startsWith("data: ")) {
            currentData = line.slice(6)
          } else if (line === "" && currentEvent && currentData) {
            // End of event - process it
            try {
              const event = JSON.parse(currentData) as StreamEvent
              this.handleStreamEvent(event)
            } catch (e) {
              console.error("Failed to parse SSE event:", currentData)
            }
            currentEvent = ""
            currentData = ""
          }
        }
      }
    } catch (err) {
      this.setError(err instanceof Error ? err.message : String(err))
    } finally {
      this.setLoading(false, false)
    }
  },

  async sendRequest(request: GenerateRequest, isInitial = false) {
    // Use streaming for action requests (when we have existing content)
    const hasAction = request.action && request.action !== "generate" && request.action !== "reset"
    const hasCurrentContent = !!this.getElements().contentEl.innerHTML?.trim()

    if (hasAction && hasCurrentContent && !isInitial) {
      return this.sendStreamRequest(request)
    }

    // Fall back to regular request for initial load, prompts, and special actions
    try {
      this.setLoading(true, isInitial)
      this.setError(null)

      const currentHtml = this.getElements().contentEl.innerHTML || undefined

      const requestWithSession = {
        ...request,
        sessionId: this.sessionId || undefined,
        currentHtml: currentHtml && currentHtml.trim() ? currentHtml : undefined,
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
        loadFontsFromHTML(data.html)
        loadIconsFromHTML(data.html)
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

  // Send prompt from the fixed footer
  sendPrompt() {
    const { promptInput } = this.getElements()
    const prompt = promptInput.value.trim()
    if (!prompt) return

    promptInput.value = ""
    this.sendRequest({
      type: "generate",
      prompt,
    })
  },

  // Reset session and start fresh
  resetSession() {
    this.sessionId = null
    this.getElements().contentEl.innerHTML = INITIAL_HTML
    this.getElements().promptInput.value = ""
    this.getElements().promptInput.focus()
  },

  init() {
    const { promptInput, sendBtn, resetBtn, contentEl } = this.getElements()

    // Show initial intro HTML immediately (no AI request needed)
    contentEl.innerHTML = INITIAL_HTML
    this.setLoading(false, true)

    // Footer: Send button
    sendBtn.addEventListener("click", () => this.sendPrompt())

    // Footer: Reset button
    resetBtn.addEventListener("click", () => this.resetSession())

    // Footer: Enter key in prompt input
    promptInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault()
        this.sendPrompt()
      }
    })

    // Click handler for buttons/links with data-action (not form inputs)
    document.addEventListener("click", (e) => {
      const target = e.target as HTMLElement
      // Skip if clicking on a form input or footer elements
      if (target.matches("input, select, textarea")) return
      if (target.closest("#prompt-footer")) return

      const el = target.closest("[data-action]")
      if (el && !el.matches("input, select, textarea")) {
        e.preventDefault()
        this.triggerAction(el)
      }
    })

    // Change handler for form inputs with data-action
    document.addEventListener("change", (e) => {
      const target = e.target as HTMLElement
      if (target.matches("input[data-action], select[data-action], textarea[data-action]")) {
        this.triggerAction(target)
      }
    })

    // Enter key handler for AI-generated inputs
    document.addEventListener("keydown", (e) => {
      const target = e.target as HTMLElement
      // Skip the fixed footer prompt input (handled separately)
      if (target.id === "prompt-input") return

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

    // Focus the prompt input on load
    promptInput.focus()
  },
}

// Start the app
app.init()
