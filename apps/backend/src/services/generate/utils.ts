import type { LanguageModelMiddleware } from "ai";

// Logging middleware to inspect prompts sent to LLM
export const loggingMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v3",
  wrapStream: async ({ doStream, params }) => {
    console.log("=== LLM Request ===");
    console.log("Prompt:", JSON.stringify(params, null, 2));
    return doStream();
  },
};

// Wrap async iterable to handle AI SDK cleanup errors gracefully
export async function* safeAsyncIterable<T>(
  iterable: AsyncIterable<T>
): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    while (true) {
      const { done, value } = await iterator.next();
      if (done) return;
      yield value;
    }
  } finally {
    try {
      await iterator.return?.();
    } catch {
      // Ignore - AI SDK throws when reader is detached during cleanup
    }
  }
}
