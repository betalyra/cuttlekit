import { Context, Effect, Layer, Ref } from "effect";

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export class SessionService extends Context.Tag("SessionService")<
  SessionService,
  {
    readonly getHistory: (
      sessionId: string
    ) => Effect.Effect<ConversationMessage[], never, never>;
    readonly addMessage: (
      sessionId: string,
      message: ConversationMessage
    ) => Effect.Effect<void, never, never>;
    readonly generateSessionId: () => Effect.Effect<string, never, never>;
  }
>() {}

export const SessionServiceLive = Layer.effect(
  SessionService,
  Effect.gen(function* () {
    // Create a mutable reference to store conversation history
    // Maps session ID to array of messages
    const sessionsRef = yield* Ref.make(
      new Map<string, ConversationMessage[]>()
    );

    return {
      getHistory: (sessionId: string) =>
        Effect.gen(function* () {
          const sessions = yield* Ref.get(sessionsRef);
          return sessions.get(sessionId) || [];
        }),

      addMessage: (sessionId: string, message: ConversationMessage) =>
        Effect.gen(function* () {
          yield* Ref.update(sessionsRef, (sessions) => {
            const history = sessions.get(sessionId) || [];
            const updatedHistory = [...history, message];

            // Keep only last 10 messages
            const trimmedHistory = updatedHistory.slice(-10);

            // Update the map with new history
            const newSessions = new Map(sessions);
            newSessions.set(sessionId, trimmedHistory);
            return newSessions;
          });
        }),

      generateSessionId: () =>
        Effect.sync(
          () =>
            `session-${Date.now()}-${Math.random().toString(36).substring(7)}`
        ),
    };
  })
);
