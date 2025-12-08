import { Effect, Stream } from "effect";
import { GenerateService, type UnifiedResponse } from "./generate.js";
import { SessionService } from "./session.js";
import { StorageService } from "./storage.js";
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
    const storageService = yield* StorageService;
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

        // Add user prompt to history
        if (prompt) {
          yield* storageService.addPrompt(sessionId, prompt);
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
        yield* storageService.addAction(sessionId, action, actionData);

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

    const generateStream = (request: UIRequest) =>
      Effect.gen(function* () {
        const { sessionId, currentHtml } = yield* resolveSession(request);
        const prompt =
          request.prompt || (request.actionData?.prompt as string | undefined);

        yield* Effect.log("UIService.generateStream", {
          action: request.action,
          prompt,
          hasCurrentHtml: !!currentHtml,
        });

        // Handle "reset" action - clear VDOM before generation
        const isResetAction = request.action === "reset";
        if (isResetAction) {
          yield* vdomService.deleteSession(sessionId);
          yield* Effect.log("Session reset, generating fresh UI");
        }

        // Get unified stream from GenerateService - AI decides patches vs full
        // Note: streamUnified stores prompt/action in its finalizer
        const unifiedStream = yield* generateService.streamUnified({
          sessionId,
          currentHtml: isResetAction ? undefined : (currentHtml ?? undefined),
          prompt,
          action: request.action,
          actionData: request.actionData,
        });

        // Start with session event
        const sessionEvent = Stream.make({ type: "session" as const, sessionId } as StreamEvent);

        // Transform unified responses to stream events, applying to VDOM
        let lastHtml = currentHtml || "";

        const handlePatchResponse = (patches: Patch[]): Effect.Effect<StreamEvent[], never, never> =>
          Effect.forEach(patches, (patch) =>
            Effect.gen(function* () {
              const result = yield* vdomService.applyPatches(sessionId, [patch]);
              if (result.errors.length > 0) {
                yield* Effect.log("Patch error", { error: result.errors[0] });
              }
              lastHtml = result.html;
              return { type: "patch" as const, patch } as StreamEvent;
            })
          );

        const handleFullResponse = (html: string): Effect.Effect<StreamEvent[], never, never> =>
          Effect.gen(function* () {
            yield* vdomService.setHtml(sessionId, html);
            lastHtml = html;
            return [{ type: "html" as const, html } as StreamEvent];
          });

        const contentEvents = unifiedStream.pipe(
          Stream.mapEffect((response: UnifiedResponse) =>
            response.mode === "patches"
              ? handlePatchResponse(response.patches)
              : handleFullResponse(response.html)
          ),
          Stream.flatMap((events) => Stream.fromIterable(events))
        );

        // End with done event
        const doneEvent = Stream.fromEffect(
          Effect.gen(function* () {
            const finalHtml = yield* vdomService.getHtml(sessionId);
            lastHtml = finalHtml || lastHtml;
            return { type: "done" as const, html: lastHtml } as StreamEvent;
          })
        );

        return Stream.concat(sessionEvent, Stream.concat(contentEvents, doneEvent));
      });

    return { generate, generateStream, resolveSession, generateFullPage, applyPatches };
  }),
}) {}

export type { Patch };
