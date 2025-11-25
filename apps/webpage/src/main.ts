import "./style.css";
import Alpine from "alpinejs";

window.Alpine = Alpine;

type GenerateRequest = {
  type: "generate";
  prompt?: string;
  sessionId?: string;
  action?: string;
  actionData?: Record<string, unknown>;
};

type FullPageResponse = {
  type: "full-page";
  html: string;
  sessionId: string;
};

type PartialUpdateResponse = {
  type: "partial-update";
  operations: Array<{
    action: "replace" | "append" | "remove";
    selector: string;
    html?: string;
  }>;
  sessionId: string;
};

type MessageResponse = {
  type: "message";
  message: string;
  sessionId: string;
};

type Response = FullPageResponse | PartialUpdateResponse | MessageResponse;

Alpine.data("generativeUI", () => ({
  content: "",
  loading: true,
  error: null as string | null,
  sessionId: null as string | null,

  async sendRequest(request: GenerateRequest) {
    try {
      this.loading = true;
      this.error = null;

      const requestWithSession = {
        ...request,
        sessionId: this.sessionId || undefined,
      };

      const response = await fetch("http://localhost:34512/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestWithSession),
      });

      if (!response.ok) {
        throw new Error("Failed to generate content");
      }

      const data = (await response.json()) as Response;

      // Update session ID
      this.sessionId = data.sessionId;

      // Handle different response types
      if (data.type === "full-page") {
        this.content = data.html;
      } else if (data.type === "partial-update") {
        this.applyOperations(data.operations);
      } else if (data.type === "message") {
        console.log("Chat message:", data.message);
        // For now, just log chat messages - we can add a chat UI later
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
  },

  applyOperations(
    operations: Array<{
      action: "replace" | "append" | "remove";
      selector: string;
      html?: string;
    }>
  ) {
    operations.forEach((op) => {
      const element = document.querySelector(op.selector);
      if (!element) {
        console.warn(`Element not found: ${op.selector}`);
        return;
      }

      if (op.action === "replace" && op.html) {
        element.outerHTML = op.html;
      } else if (op.action === "append" && op.html) {
        element.insertAdjacentHTML("beforeend", op.html);
      } else if (op.action === "remove") {
        element.remove();
      }
    });
  },

  regenerate(prompt: string) {
    if (prompt && prompt.trim()) {
      this.sendRequest({
        type: "generate",
        prompt: prompt,
      });
    }
  },

  init() {
    // Helper function to trigger action
    const triggerAction = (actionElement: Element) => {
      const action = actionElement.getAttribute('data-action');
      const actionDataAttr = actionElement.getAttribute('data-action-data');

      // Collect all form input values from the page
      const formData: Record<string, unknown> = {};
      document.querySelectorAll('input, textarea, select').forEach((input) => {
        const htmlInput = input as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        const id = htmlInput.id;
        const name = htmlInput.name;
        const key = id || name;

        if (key) {
          if (htmlInput instanceof HTMLInputElement && htmlInput.type === 'checkbox') {
            formData[key] = htmlInput.checked;
          } else if (htmlInput instanceof HTMLInputElement && htmlInput.type === 'radio') {
            if (htmlInput.checked) {
              formData[key] = htmlInput.value;
            }
          } else {
            formData[key] = htmlInput.value;
          }
        }
      });

      // Merge action data with form data
      const actionData = actionDataAttr ? JSON.parse(actionDataAttr) : {};
      const mergedData = { ...formData, ...actionData };

      this.sendRequest({
        type: "generate",
        action: action || undefined,
        actionData: Object.keys(mergedData).length > 0 ? mergedData : undefined
      });
    };

    // Intercept all clicks on [data-action] elements
    document.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest('[data-action]');
      if (el) {
        e.preventDefault();
        triggerAction(el);
      }
    });

    // Intercept Enter key presses in input/textarea elements
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        // Don't trigger on textareas unless Ctrl/Cmd+Enter
        if (e.target instanceof HTMLTextAreaElement && !e.ctrlKey && !e.metaKey) {
          return;
        }

        e.preventDefault();

        // Check if the input itself has a data-action attribute
        if (e.target.hasAttribute('data-action')) {
          triggerAction(e.target);
          return;
        }

        // Otherwise, find the nearest [data-action] button in the same container
        const container = e.target.closest('div, form, section') || document.body;
        const actionButton = container.querySelector('[data-action]');

        if (actionButton) {
          triggerAction(actionButton);
        }
      }
    });

    // Initial load
    this.sendRequest({
      type: "generate",
    });
  },
}));

Alpine.start();
