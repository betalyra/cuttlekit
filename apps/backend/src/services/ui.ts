import { Effect, Stream } from "effect";
import { GenerateService } from "./generate.js";
import { SessionService } from "./session.js";
import { VdomService, type Patch } from "./vdom.js";

const MAX_PATCH_RETRIES = 2;

export type UIRequest = {
  sessionId?: string;
  currentHtml?: string;
  prompt?: string;
  action?: string;
  actionData?: Record<string, unknown>;
};

export type UIResponse = {
  html: string;
  sessionId: string;
};

export class UIService extends Effect.Service<UIService>()("UIService", {
  accessors: true,
  effect: Effect.gen(function* () {
    const generateService = yield* GenerateService;
    const sessionService = yield* SessionService;
    const vdomService = yield* VdomService;

    const resolveSession = (request: UIRequest) =>
      Effect.gen(function* () {
        const sessionId =
          request.sessionId || (yield* sessionService.generateSessionId());

        // Get current VDOM HTML (null if new session)
        // Fall back to client-provided HTML if server doesn't have VDOM (e.g., after restart)
        const serverHtml = yield* vdomService.getHtml(sessionId);
        const currentHtml = serverHtml ?? request.currentHtml ?? null;

        // If client provided HTML but server didn't have it, restore the VDOM
        if (!serverHtml && currentHtml) {
          yield* vdomService.setHtml(sessionId, currentHtml);
        }

        return { sessionId, currentHtml };
      });

    const generateFullPage = (
      sessionId: string,
      options: {
        prompt?: string;
        action?: string;
        actionData?: Record<string, unknown>;
        currentHtml?: string | null;
        isReset?: boolean;
      }
    ) =>
      Effect.gen(function* () {
        const { prompt, action, actionData, currentHtml, isReset } = options;

        // Add user message to history
        if (prompt) {
          yield* sessionService.addMessage(sessionId, {
            role: "user",
            content: prompt,
            timestamp: Date.now(),
          });
        }

        // Generate HTML
        const html = yield* generateService.generateFullHtml({
          prompt,
          action,
          actionData,
          currentHtml: isReset ? undefined : (currentHtml ?? undefined),
        });

        // Store in VDOM
        yield* vdomService.setHtml(sessionId, html);

        // Add to history
        yield* sessionService.addMessage(sessionId, {
          role: "assistant",
          content: `[Generated UI: ${html.slice(0, 100)}...]`,
          timestamp: Date.now(),
        });

        return html;
      });

    const applyPatches = (
      sessionId: string,
      options: {
        action: string;
        actionData?: Record<string, unknown>;
        currentHtml: string;
      }
    ) =>
      Effect.gen(function* () {
        const { action, actionData, currentHtml } = options;

        // Add action to history
        yield* sessionService.addMessage(sessionId, {
          role: "user",
          content: `[Action: ${action}] ${JSON.stringify(actionData || {})}`,
          timestamp: Date.now(),
        });

        // Try patch generation with retries
        let lastErrors: string[] = [];

        for (let attempt = 0; attempt <= MAX_PATCH_RETRIES; attempt++) {
          yield* Effect.log(`Patch attempt ${attempt + 1}/${MAX_PATCH_RETRIES + 1}`);

          const patches = yield* generateService.generatePatches({
            currentHtml,
            action,
            actionData,
            previousErrors: lastErrors,
          });

          yield* Effect.log("Generated patches", { count: patches.length });

          const result = yield* vdomService.applyPatches(sessionId, patches);

          if (result.errors.length === 0) {
            yield* Effect.log("Patches applied successfully");

            yield* sessionService.addMessage(sessionId, {
              role: "assistant",
              content: `[Applied ${result.applied} patches]`,
              timestamp: Date.now(),
            });

            return { success: true as const, html: result.html };
          }

          yield* Effect.log("Patch errors, will retry", { errors: result.errors });
          lastErrors = result.errors;
        }

        // Patches failed - return failure for caller to handle fallback
        return { success: false as const, errors: lastErrors };
      });

    const generate = (request: UIRequest): Effect.Effect<UIResponse, Error> =>
      Effect.gen(function* () {
        const { sessionId, currentHtml } = yield* resolveSession(request);
        const prompt =
          request.prompt || (request.actionData?.prompt as string | undefined);

        yield* Effect.log("UIService.generate", {
          action: request.action,
          prompt,
          hasCurrentHtml: !!currentHtml,
        });

        // Handle "reset" action - clear VDOM and start fresh
        if (request.action === "reset") {
          yield* vdomService.deleteSession(sessionId);
          yield* Effect.log("Session reset, generating fresh UI");
        }

        // Case 1: Need full HTML generation
        const isGenerateAction = request.action === "generate";
        const isResetAction = request.action === "reset";
        const shouldGenerateFullHtml =
          !currentHtml || prompt || isGenerateAction || isResetAction;

        if (shouldGenerateFullHtml) {
          yield* Effect.log("Generating full HTML", {
            reason: !currentHtml
              ? "no vdom"
              : prompt
                ? "has prompt"
                : "generate action",
          });

          const html = yield* generateFullPage(sessionId, {
            prompt,
            action: request.action,
            actionData: request.actionData,
            currentHtml,
            isReset: isResetAction,
          });

          return { html, sessionId };
        }

        // Case 2: VDOM exists and action triggered → try patches first
        if (request.action && currentHtml) {
          yield* Effect.log("Attempting patches for action", {
            action: request.action,
          });

          const patchResult = yield* applyPatches(sessionId, {
            action: request.action,
            actionData: request.actionData,
            currentHtml,
          });

          if (patchResult.success) {
            return { html: patchResult.html, sessionId };
          }

          // Fallback: regenerate full HTML
          yield* Effect.log(
            "Patch retries exhausted, falling back to full HTML generation"
          );

          const html = yield* generateFullPage(sessionId, {
            action: request.action,
            actionData: request.actionData,
            currentHtml,
          });

          yield* sessionService.addMessage(sessionId, {
            role: "assistant",
            content: `[Fallback: regenerated full UI]`,
            timestamp: Date.now(),
          });

          return { html, sessionId };
        }

        // Case 3: No action, just return current HTML
        return { html: currentHtml!, sessionId };
      });

    // Streaming event types
    type StreamEvent =
      | { type: "session"; sessionId: string }
      | { type: "patch"; patch: Patch }
      | { type: "html"; html: string }
      | { type: "done"; html: string };

    const generateStream = (
      request: UIRequest
    ): Effect.Effect<Stream.Stream<StreamEvent, Error>, Error> =>
      Effect.gen(function* () {
        const { sessionId, currentHtml } = yield* resolveSession(request);
        const prompt =
          request.prompt || (request.actionData?.prompt as string | undefined);

        yield* Effect.log("UIService.generateStream", {
          action: request.action,
          prompt,
          hasCurrentHtml: !!currentHtml,
        });

        // Handle "reset" action
        if (request.action === "reset") {
          yield* vdomService.deleteSession(sessionId);
          yield* Effect.log("Session reset, generating fresh UI");
        }

        // Determine if we need full HTML or can use patches
        const isGenerateAction = request.action === "generate";
        const isResetAction = request.action === "reset";
        const shouldGenerateFullHtml =
          !currentHtml || prompt || isGenerateAction || isResetAction;

        if (shouldGenerateFullHtml) {
          // For full HTML generation, we don't stream (yet) - return single event
          yield* Effect.log("Generating full HTML (non-streaming)");

          const html = yield* generateFullPage(sessionId, {
            prompt,
            action: request.action,
            actionData: request.actionData,
            currentHtml,
            isReset: isResetAction,
          });

          return Stream.make(
            { type: "session" as const, sessionId },
            { type: "html" as const, html },
            { type: "done" as const, html }
          );
        }

        // Stream patches for actions
        if (request.action && currentHtml) {
          yield* Effect.log("Streaming patches for action", {
            action: request.action,
          });

          // Add action to history
          yield* sessionService.addMessage(sessionId, {
            role: "user",
            content: `[Action: ${request.action}] ${JSON.stringify(request.actionData || {})}`,
            timestamp: Date.now(),
          });

          // Get the patch stream from GenerateService
          const patchStream = yield* generateService.streamPatches({
            currentHtml,
            action: request.action,
            actionData: request.actionData,
          });

          // Start with session event, then stream patches
          const sessionEvent = Stream.make({ type: "session" as const, sessionId });

          // Apply each patch to VDOM and emit
          const patchEvents = patchStream.pipe(
            Stream.mapEffect((patch) =>
              Effect.gen(function* () {
                // Apply patch to VDOM
                const result = yield* vdomService.applyPatches(sessionId, [patch]);
                if (result.errors.length > 0) {
                  yield* Effect.log("Patch error", { error: result.errors[0] });
                }
                return { type: "patch" as const, patch };
              })
            )
          );

          // End with done event containing final HTML
          const doneEvent = Stream.fromEffect(
            Effect.gen(function* () {
              const finalHtml = yield* vdomService.getHtml(sessionId);

              yield* sessionService.addMessage(sessionId, {
                role: "assistant",
                content: `[Streamed patches]`,
                timestamp: Date.now(),
              });

              return { type: "done" as const, html: finalHtml || currentHtml };
            })
          );

          return Stream.concat(sessionEvent, Stream.concat(patchEvents, doneEvent));
        }

        // No action, return current HTML
        return Stream.make(
          { type: "session" as const, sessionId },
          { type: "html" as const, html: currentHtml! },
          { type: "done" as const, html: currentHtml! }
        );
      });

    return { generate, generateStream, resolveSession, generateFullPage, applyPatches };
  }),
}) {}

export type { Patch };
