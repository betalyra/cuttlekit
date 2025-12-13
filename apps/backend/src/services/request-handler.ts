import { Effect, Stream } from "effect";
import { UIService } from "./ui.js";
import type { Request } from "../types/messages.js";
import type { Patch } from "./vdom.js";

// Stream event types for SSE responses
export type StreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "patch"; patch: Patch }
  | { type: "html"; html: string }
  | { type: "done"; html: string };

/**
 * RequestHandlerService - HTTP request/response mapping layer
 *
 * Converts HTTP API types to domain types and back.
 * All business logic lives in UIService.
 */
export class RequestHandlerService extends Effect.Service<RequestHandlerService>()(
  "RequestHandlerService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const uiService = yield* UIService;

      const handleStreamRequest = (
        request: Request
      ): Effect.Effect<Stream.Stream<StreamEvent, Error>, Error> =>
        Effect.gen(function* () {
          const streamParams = {
            sessionId: request.sessionId,
            currentHtml: request.type === "generate" ? request.currentHtml : undefined,
            prompt:
              request.type === "generate"
                ? request.prompt
                : request.type === "update"
                  ? request.prompt
                  : undefined,
            action: request.type === "generate" ? request.action : undefined,
            actionData: request.type === "generate" ? request.actionData : undefined,
          };

          return yield* uiService.generateStream(streamParams);
        });

      return { handleStreamRequest };
    }),
  }
) {}
