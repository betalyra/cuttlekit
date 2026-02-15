import "./style.css";
import { loadFontsFromHTML } from "./fonts";
import { loadIconsFromHTML } from "./icons";
import type { Patch, StreamEventWithOffset } from "@betalyra/generative-ui-common/client";

const API_BASE = "http://localhost:34512";
const STORAGE_KEY = "generative-ui-stream";

type StreamEvent = StreamEventWithOffset;

type StreamState = {
  sessionId: string;
  lastOffset: number;
};

// Initial intro HTML
const INITIAL_HTML = `<div id="root" class="flex items-center justify-center min-h-[calc(100vh-4rem)]">
  <div class="text-center max-w-md px-4">
    <h1 class="text-2xl font-light text-[#0a0a0a] mb-4">Generative UI</h1>
    <p class="text-sm text-[#525252] leading-relaxed">
      Describe what you want to create. A dashboard, a form, a game — anything you can imagine.
    </p>
  </div>
</div>`;

const loadStreamState = (): StreamState | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StreamState) : null;
  } catch {
    return null;
  }
};

const app = {
  sessionId: null as string | null,
  eventSource: null as EventSource | null,
  lastOffset: -1,
  loading: false,
  stats: null as {
    cacheRate: number;
    tokensPerSecond: number;
    mode: "patches" | "full";
    patchCount: number;
  } | null,

  getElements() {
    return {
      app: document.getElementById("app")!,
      loadingEl: document.getElementById("loading")!,
      errorEl: document.getElementById("error")!,
      contentEl: document.getElementById("content")!,
      promptInput: document.getElementById("prompt-input") as HTMLInputElement,
      sendBtn: document.getElementById("send-btn")!,
      resetBtn: document.getElementById("reset-btn")!,
      statsEl: document.getElementById("footer-stats")!,
    };
  },

  setLoading(loading: boolean, isInitial = false) {
    this.loading = loading;
    const { loadingEl, contentEl } = this.getElements();

    if (isInitial) {
      loadingEl.style.display = loading ? "flex" : "none";
      contentEl.style.display = loading ? "none" : "block";
    } else {
      loadingEl.style.display = "none";
      contentEl.style.display = "block";
      contentEl.style.opacity = loading ? "0.7" : "1";
    }
  },

  setError(error: string | null) {
    const { errorEl, contentEl } = this.getElements();
    if (error) {
      errorEl.style.display = "flex";
      errorEl.querySelector("span")!.textContent = error;
      contentEl.style.display = "none";
    } else {
      errorEl.style.display = "none";
    }
  },

  extractPatchContent(patch: Patch): string | null {
    if ("html" in patch) return patch.html;
    if ("append" in patch) return patch.append;
    if ("prepend" in patch) return patch.prepend;
    if ("attr" in patch && patch.attr.style) return patch.attr.style;
    return null;
  },

  applyPatch(patch: Patch) {
    const el = document.querySelector(patch.selector);
    if (!el) {
      console.warn(`Patch target not found: ${patch.selector}`);
      return;
    }

    const content = this.extractPatchContent(patch);
    if (content) {
      loadFontsFromHTML(content);
      loadIconsFromHTML(content);
    }

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
  },

  updateStats() {
    const { statsEl } = this.getElements();
    if (this.stats) {
      const modeDisplay =
        this.stats.mode === "patches"
          ? `${this.stats.patchCount} patches`
          : "full";
      statsEl.innerHTML = `
        <span title="Generation mode">${modeDisplay}</span>
        <span class="text-[#a3a3a3]">·</span>
        <span title="Tokens per second">${this.stats.tokensPerSecond} tok/s</span>
        <span class="text-[#a3a3a3]">·</span>
        <span title="Cache hit rate">${this.stats.cacheRate}% cache</span>
      `;
      statsEl.style.display = "flex";
    } else {
      statsEl.style.display = "none";
    }
  },

  handleStreamEvent(event: StreamEvent) {
    switch (event.type) {
      case "session":
        // Stream session ID is informational once we already established one.
        // Keeping the existing ID avoids accidentally switching POSTs to a
        // different session while SSE is still attached to the current stream.
        if (!this.sessionId) {
          this.sessionId = event.sessionId;
        } else if (this.sessionId !== event.sessionId) {
          console.warn(
            `Ignoring mismatched session event. current=${this.sessionId} event=${event.sessionId}`,
          );
        }
        break;
      case "patch":
        this.applyPatch(event.patch as Patch);
        break;
      case "html":
        this.getElements().contentEl.innerHTML = event.html;
        loadFontsFromHTML(event.html);
        loadIconsFromHTML(event.html);
        break;
      case "stats":
        this.stats = {
          cacheRate: event.cacheRate,
          tokensPerSecond: event.tokensPerSecond,
          mode: event.mode,
          patchCount: event.patchCount,
        };
        this.updateStats();
        break;
      case "done":
        this.setLoading(false);
        loadFontsFromHTML(event.html);
        loadIconsFromHTML(event.html);
        break;
    }
  },

  saveStreamState() {
    if (this.sessionId) {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          sessionId: this.sessionId,
          lastOffset: this.lastOffset,
        }),
      );
    }
  },

  connectSSE(sessionId: string) {
    if (this.eventSource) this.eventSource.close();

    const params = new URLSearchParams();
    if (this.lastOffset >= 0) params.set("offset", String(this.lastOffset));

    const url = `${API_BASE}/stream/${sessionId}?${params}`;
    this.eventSource = new EventSource(url);

    for (const eventType of [
      "session",
      "patch",
      "html",
      "stats",
      "done",
    ] as const) {
      this.eventSource.addEventListener(eventType, (e) => {
        const event = JSON.parse((e as MessageEvent).data) as StreamEvent;
        this.lastOffset = event.offset;
        this.saveStreamState();
        this.handleStreamEvent(event);
      });
    }

    this.eventSource.onerror = () => {
      // EventSource auto-reconnects with Last-Event-ID
    };
  },

  async submitAction(request: {
    prompt?: string;
    action?: string;
    actionData?: Record<string, unknown>;
    currentHtml?: string;
  }) {
    this.setLoading(true);
    this.setError(null);

    const currentHtml = this.getElements().contentEl.innerHTML || undefined;

    try {
      await fetch(`${API_BASE}/stream/${this.sessionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...request,
          currentHtml:
            currentHtml && currentHtml.trim() ? currentHtml : undefined,
        }),
      });
      // Response is 202 — results arrive via SSE
    } catch (err) {
      this.setError(err instanceof Error ? err.message : String(err));
      this.setLoading(false);
    }
  },

  collectFormData(): Record<string, unknown> {
    const formData: Record<string, unknown> = {};

    document.querySelectorAll("input, textarea, select").forEach((input) => {
      const el = input as
        | HTMLInputElement
        | HTMLTextAreaElement
        | HTMLSelectElement;
      const key = el.id || el.name;
      if (!key) return;

      if (el instanceof HTMLInputElement && el.type === "checkbox") {
        formData[key] = el.checked;
      } else if (el instanceof HTMLInputElement && el.type === "radio") {
        if (el.checked) formData[key] = el.value;
      } else {
        formData[key] = el.value;
      }
    });

    return formData;
  },

  triggerAction(actionElement: Element) {
    const action = actionElement.getAttribute("data-action");
    const actionDataAttr = actionElement.getAttribute("data-action-data");

    const formData = this.collectFormData();
    const actionData = actionDataAttr ? JSON.parse(actionDataAttr) : {};
    const mergedData = { ...formData, ...actionData };

    this.submitAction({
      action: action || undefined,
      actionData: Object.keys(mergedData).length > 0 ? mergedData : undefined,
    });
  },

  sendPrompt() {
    const { promptInput } = this.getElements();
    const prompt = promptInput.value.trim();
    if (!prompt) return;

    promptInput.value = "";
    this.submitAction({ prompt });
  },

  resetSession() {
    if (this.eventSource) this.eventSource.close();
    this.eventSource = null;
    this.lastOffset = -1;
    this.stats = null;
    localStorage.removeItem(STORAGE_KEY);

    // Immediately create a fresh session with an open SSE connection
    this.sessionId = crypto.randomUUID();
    this.connectSSE(this.sessionId);

    this.getElements().contentEl.innerHTML = INITIAL_HTML;
    this.getElements().promptInput.value = "";
    this.updateStats();
    this.getElements().promptInput.focus();
  },

  init() {
    const { promptInput, sendBtn, resetBtn, contentEl } = this.getElements();

    // Restore or create a session, then open the SSE connection immediately
    // so it's already live when the first POST fires.
    const saved = loadStreamState();
    if (saved) {
      this.sessionId = saved.sessionId;
      this.lastOffset = saved.lastOffset;
      this.setLoading(true);
    } else {
      this.sessionId = crypto.randomUUID();
      contentEl.innerHTML = INITIAL_HTML;
      this.setLoading(false, true);
    }
    this.connectSSE(this.sessionId);

    // Footer: Send button
    sendBtn.addEventListener("click", () => this.sendPrompt());

    // Footer: Reset button
    resetBtn.addEventListener("click", () => this.resetSession());

    // Footer: Enter key in prompt input
    promptInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.sendPrompt();
      }
    });

    // Click handler for buttons/links with data-action (not form inputs)
    document.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.matches("input, select, textarea")) return;
      if (target.closest("#prompt-footer")) return;

      const el = target.closest("[data-action]");
      if (el && !el.matches("input, select, textarea")) {
        e.preventDefault();
        this.triggerAction(el);
      }
    });

    // Change handler for form inputs with data-action
    document.addEventListener("change", (e) => {
      const target = e.target as HTMLElement;
      if (
        target.matches(
          "input[data-action], select[data-action], textarea[data-action]",
        )
      ) {
        this.triggerAction(target);
      }
    });

    // Enter key handler for AI-generated inputs
    document.addEventListener("keydown", (e) => {
      const target = e.target as HTMLElement;
      if (target.id === "prompt-input") return;

      const isInput = target instanceof HTMLInputElement;
      const isTextarea = target instanceof HTMLTextAreaElement;

      if (e.key === "Enter" && (isInput || isTextarea)) {
        if (isTextarea && !e.ctrlKey && !e.metaKey) return;

        e.preventDefault();

        if (target.hasAttribute("data-action")) {
          this.triggerAction(target);
          return;
        }

        const container = target.closest("div, form, section") || document.body;
        const actionButton = container.querySelector("[data-action]");
        if (actionButton) {
          this.triggerAction(actionButton);
        }
      }
    });

    promptInput.focus();
  },
};

// Start the app
app.init();
