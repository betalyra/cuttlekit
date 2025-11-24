import "./style.css";
import Alpine from "alpinejs";

window.Alpine = Alpine;

Alpine.data("generativeUI", () => ({
  content: "",
  loading: true,
  error: null as string | null,
  async fetchContent(prompt?: string) {
    try {
      this.loading = true;
      this.error = null;
      const response = await fetch("http://localhost:34512/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: prompt || undefined,
        }),
      });
      if (!response.ok) {
        throw new Error("Failed to generate content");
      }
      const data = await response.json();
      this.content = data.html;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
  },
  regenerate(prompt: string) {
    if (prompt && prompt.trim()) {
      this.fetchContent(prompt);
    }
  },
  init() {
    this.fetchContent();
  },
}));

Alpine.start();
