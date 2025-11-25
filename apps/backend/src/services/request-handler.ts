import { Effect } from "effect"
import { GenerateService } from "./generate.js"
import { SessionService } from "./session.js"
import { VdomService } from "./vdom.js"
import type { Request, Response } from "../types/messages.js"

const MAX_PATCH_RETRIES = 2

export class RequestHandlerService extends Effect.Service<RequestHandlerService>()(
  "RequestHandlerService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const generateService = yield* GenerateService
      const sessionService = yield* SessionService
      const vdomService = yield* VdomService

      const handleRequest = (request: Request): Effect.Effect<Response, Error> =>
        Effect.gen(function* () {
          // Get or create session ID
          const sessionId = request.sessionId || (yield* sessionService.generateSessionId())

          // Get current VDOM HTML (null if new session)
          const currentHtml = yield* vdomService.getHtml(sessionId)

          // Get conversation history
          const history = yield* sessionService.getHistory(sessionId)

          // Handle based on request type
          if (request.type === "generate") {
            // Extract prompt from request or actionData (for "generate" action with prompt input)
            const prompt = request.prompt || (request.actionData?.prompt as string | undefined)

            yield* Effect.log("Request details", {
              action: request.action,
              prompt,
              hasCurrentHtml: !!currentHtml,
              actionData: request.actionData,
            })

            // Handle "reset" action - clear VDOM and start fresh
            if (request.action === "reset") {
              yield* vdomService.deleteSession(sessionId)
              yield* Effect.log("Session reset, generating fresh UI")
            }

            // Case 1: No VDOM yet, explicit prompt, "generate" action, or "reset" action → generate full HTML
            const isGenerateAction = request.action === "generate"
            const isResetAction = request.action === "reset"
            const shouldGenerateFullHtml = !currentHtml || prompt || isGenerateAction || isResetAction

            if (shouldGenerateFullHtml) {
              yield* Effect.log("Generating full HTML", { reason: !currentHtml ? "no vdom" : prompt ? "has prompt" : "generate action" })

              // Add user message to history
              if (prompt) {
                yield* sessionService.addMessage(sessionId, {
                  role: "user",
                  content: prompt,
                  timestamp: Date.now(),
                })
              }

              const html = yield* generateService.generateFullHtml({
                prompt,
                history,
                action: request.action,
                actionData: request.actionData,
              })

              // Store in VDOM
              yield* vdomService.setHtml(sessionId, html)

              // Add to history
              yield* sessionService.addMessage(sessionId, {
                role: "assistant",
                content: `[Generated UI: ${html.slice(0, 100)}...]`,
                timestamp: Date.now(),
              })

              return { type: "full-page" as const, html, sessionId }
            }

            // Case 2: VDOM exists and action triggered → generate patches
            if (request.action) {
              yield* Effect.log("Generating patches for action", { action: request.action })

              // Add action to history
              yield* sessionService.addMessage(sessionId, {
                role: "user",
                content: `[Action: ${request.action}] ${JSON.stringify(request.actionData || {})}`,
                timestamp: Date.now(),
              })

              // Try patch generation with retries
              let lastErrors: string[] = []

              for (let attempt = 0; attempt <= MAX_PATCH_RETRIES; attempt++) {
                yield* Effect.log(`Patch attempt ${attempt + 1}/${MAX_PATCH_RETRIES + 1}`)

                const patches = yield* generateService.generatePatches({
                  currentHtml,
                  action: request.action,
                  actionData: request.actionData,
                  previousErrors: lastErrors,
                })

                yield* Effect.log("Generated patches", { count: patches.length })

                const result = yield* vdomService.applyPatches(sessionId, patches)

                if (result.errors.length === 0) {
                  yield* Effect.log("Patches applied successfully")

                  // Add to history
                  yield* sessionService.addMessage(sessionId, {
                    role: "assistant",
                    content: `[Applied ${result.applied} patches]`,
                    timestamp: Date.now(),
                  })

                  return { type: "full-page" as const, html: result.html, sessionId }
                }

                yield* Effect.log("Patch errors, will retry", { errors: result.errors })
                lastErrors = result.errors
              }

              // Fallback: regenerate full HTML
              yield* Effect.log("Patch retries exhausted, falling back to full HTML generation")

              const html = yield* generateService.generateFullHtml({
                history,
                action: request.action,
                actionData: request.actionData,
              })

              yield* vdomService.setHtml(sessionId, html)

              yield* sessionService.addMessage(sessionId, {
                role: "assistant",
                content: `[Fallback: regenerated full UI]`,
                timestamp: Date.now(),
              })

              return { type: "full-page" as const, html, sessionId }
            }

            // Case 3: No action, just return current HTML
            return { type: "full-page" as const, html: currentHtml, sessionId }
          }

          // Handle chat/update requests (keep simple for now)
          if (request.type === "chat") {
            yield* sessionService.addMessage(sessionId, {
              role: "user",
              content: request.message,
              timestamp: Date.now(),
            })

            const response = yield* generateService.generateFullHtml({
              prompt: request.message,
              history,
            })

            yield* sessionService.addMessage(sessionId, {
              role: "assistant",
              content: response,
              timestamp: Date.now(),
            })

            return { type: "message" as const, message: response, sessionId }
          }

          // Update request
          yield* sessionService.addMessage(sessionId, {
            role: "user",
            content: request.prompt,
            timestamp: Date.now(),
          })

          const html = yield* generateService.generateFullHtml({
            prompt: request.prompt,
            history,
          })

          yield* vdomService.setHtml(sessionId, html)

          return {
            type: "partial-update" as const,
            operations: [{ action: "replace" as const, selector: request.target || "#app", html }],
            sessionId,
          }
        })

      return { handleRequest }
    }),
  }
) {}
