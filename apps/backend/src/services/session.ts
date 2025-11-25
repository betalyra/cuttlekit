import { Effect, Ref } from "effect"

export type ConversationMessage = {
  role: "user" | "assistant"
  content: string
  timestamp: number
}

export class SessionService extends Effect.Service<SessionService>()("SessionService", {
  accessors: true,
  effect: Effect.gen(function* () {
    // Store conversation history per session
    const sessionsRef = yield* Ref.make(new Map<string, ConversationMessage[]>())

    const getHistory = (sessionId: string) =>
      Effect.gen(function* () {
        const sessions = yield* Ref.get(sessionsRef)
        return sessions.get(sessionId) || []
      })

    const addMessage = (sessionId: string, message: ConversationMessage) =>
      Ref.update(sessionsRef, (sessions) => {
        const history = sessions.get(sessionId) || []
        const updatedHistory = [...history, message]
        // Keep only last 10 messages
        const trimmedHistory = updatedHistory.slice(-10)
        const newSessions = new Map(sessions)
        newSessions.set(sessionId, trimmedHistory)
        return newSessions
      })

    const generateSessionId = () =>
      Effect.sync(() => `session-${Date.now()}-${Math.random().toString(36).substring(7)}`)

    return { getHistory, addMessage, generateSessionId }
  }),
}) {}
