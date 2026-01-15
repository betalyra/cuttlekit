import { Effect, Stream, Match, pipe } from "effect";
import { GenerateService, type UnifiedResponse } from "./generate.js";
import { SessionService } from "./session.js";
import { VdomService, type Patch } from "./vdom.js";

export type UIRequest = {
  sessionId?: string;
  currentHtml?: string;
  prompt?: string;
  action?: string;
  actionData?: Record<string, unknown>;
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

    // Streaming event types
    type StreamEvent =
      | { type: "session"; sessionId: string }
      | { type: "patch"; patch: Patch }
      | { type: "html"; html: string }
      | { type: "stats"; cacheRate: number; tokensPerSecond: number }
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
          currentHtml: isResetAction ? undefined : currentHtml ?? undefined,
          prompt,
          action: request.action,
          actionData: request.actionData,
        });

        // Start with session event
        const sessionEvent = Stream.make({
          type: "session" as const,
          sessionId,
        } as StreamEvent);

        // Transform unified responses to stream events, applying to VDOM
        let lastHtml = currentHtml || "";

        const handlePatchResponse = (
          patches: Patch[]
        ): Effect.Effect<StreamEvent[], never, never> =>
          Effect.forEach(patches, (patch) =>
            Effect.gen(function* () {
              const result = yield* vdomService.applyPatches(sessionId, [
                patch,
              ]);
              if (result.errors.length > 0) {
                yield* Effect.log("Patch error", { error: result.errors[0] });
              }
              lastHtml = result.html;
              return { type: "patch" as const, patch } as StreamEvent;
            })
          );

        const handleFullResponse = (
          html: string
        ): Effect.Effect<StreamEvent[], never, never> =>
          Effect.gen(function* () {
            yield* vdomService.setHtml(sessionId, html);
            lastHtml = html;
            return [{ type: "html" as const, html } as StreamEvent];
          });

        const handleResponse = (response: UnifiedResponse) =>
          pipe(
            Match.value(response),
            Match.when({ type: "patches" }, (r) =>
              handlePatchResponse(r.patches)
            ),
            Match.when({ type: "full" }, (r) => handleFullResponse(r.html)),
            Match.when({ type: "stats" }, (r) =>
              Effect.succeed([
                {
                  type: "stats" as const,
                  cacheRate: r.cacheRate,
                  tokensPerSecond: r.tokensPerSecond,
                } as StreamEvent,
              ])
            ),
            Match.exhaustive
          );

        const contentEvents = unifiedStream.pipe(
          Stream.mapEffect(handleResponse),
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

        return Stream.concat(
          sessionEvent,
          Stream.concat(contentEvents, doneEvent)
        );
      });

    return { generateStream, resolveSession };
  }),
}) {}

export type { Patch };
