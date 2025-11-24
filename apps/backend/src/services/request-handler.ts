import { Context, Effect, Layer } from "effect";
import { GenerateService } from "./generate.js";
import { SessionService } from "./session.js";
import type { Request, Response } from "../types/messages.js";

export class RequestHandlerService extends Context.Tag("RequestHandlerService")<
  RequestHandlerService,
  {
    readonly handleRequest: (
      request: Request
    ) => Effect.Effect<Response, Error, never>;
  }
>() {}

export const RequestHandlerServiceLive = Layer.effect(
  RequestHandlerService,
  Effect.gen(function* () {
    const generateService = yield* GenerateService;
    const sessionService = yield* SessionService;

    return {
      handleRequest: (request: Request) =>
        Effect.gen(function* () {
          // Get or create session ID
          const sessionId =
            request.sessionId || (yield* sessionService.generateSessionId());

          // Get conversation history
          const history = yield* sessionService.getHistory(sessionId);

          // Process based on request type
          if (request.type === "generate") {
            // Add user message to history if prompt exists
            if (request.prompt) {
              yield* sessionService.addMessage(sessionId, {
                role: "user",
                content: request.prompt,
                timestamp: Date.now(),
              });
            }

            // Generate content
            const html = yield* generateService.generate({
              prompt: request.prompt,
              history,
              type: "full-page",
            });

            // Add assistant response to history
            yield* sessionService.addMessage(sessionId, {
              role: "assistant",
              content: html,
              timestamp: Date.now(),
            });

            return {
              type: "full-page" as const,
              html,
              sessionId,
            };
          } else if (request.type === "update") {
            // Add user message to history
            yield* sessionService.addMessage(sessionId, {
              role: "user",
              content: request.prompt,
              timestamp: Date.now(),
            });

            // Generate content
            const html = yield* generateService.generate({
              prompt: request.prompt,
              history,
              type: "partial-update",
              target: request.target,
            });

            // Add assistant response to history
            yield* sessionService.addMessage(sessionId, {
              role: "assistant",
              content: html,
              timestamp: Date.now(),
            });

            return {
              type: "partial-update" as const,
              operations: [
                {
                  action: "replace" as const,
                  selector: request.target || "#app",
                  html,
                },
              ],
              sessionId,
            };
          } else {
            // Chat request
            yield* sessionService.addMessage(sessionId, {
              role: "user",
              content: request.message,
              timestamp: Date.now(),
            });

            const response = yield* generateService.generate({
              prompt: request.message,
              history,
              type: "chat",
            });

            yield* sessionService.addMessage(sessionId, {
              role: "assistant",
              content: response,
              timestamp: Date.now(),
            });

            return {
              type: "message" as const,
              message: response,
              sessionId,
            };
          }
        }),
    };
  })
);
