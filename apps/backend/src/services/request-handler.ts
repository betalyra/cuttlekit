import { Effect } from "effect";
import { UIService } from "./ui.js";
import type { Request, Response } from "../types/messages.js";

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

      const handleRequest = (request: Request): Effect.Effect<Response, Error> =>
        Effect.gen(function* () {
          if (request.type === "generate") {
            const result = yield* uiService.generate({
              sessionId: request.sessionId,
              currentHtml: request.currentHtml,
              prompt: request.prompt,
              action: request.action,
              actionData: request.actionData,
            });

            return {
              type: "full-page" as const,
              html: result.html,
              sessionId: result.sessionId,
            };
          }

          if (request.type === "chat") {
            // Chat requests use generate with prompt
            const result = yield* uiService.generate({
              sessionId: request.sessionId,
              prompt: request.message,
            });

            return {
              type: "message" as const,
              message: result.html,
              sessionId: result.sessionId,
            };
          }

          // Update request
          const result = yield* uiService.generate({
            sessionId: request.sessionId,
            prompt: request.prompt,
          });

          return {
            type: "partial-update" as const,
            operations: [
              {
                action: "replace" as const,
                selector: request.target || "#app",
                html: result.html,
              },
            ],
            sessionId: result.sessionId,
          };
        });

      return { handleRequest };
    }),
  }
) {}
