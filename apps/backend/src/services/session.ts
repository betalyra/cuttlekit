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
    readonly getState: (
      sessionId: string
    ) => Effect.Effect<Record<string, unknown>, never, never>;
    readonly setState: (
      sessionId: string,
      state: Record<string, unknown>
    ) => Effect.Effect<void, never, never>;
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

    // Create a mutable reference to store application state
    // Maps session ID to application state
    const stateRef = yield* Ref.make(
      new Map<string, Record<string, unknown>>()
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

      getState: (sessionId: string) =>
        Effect.gen(function* () {
          const states = yield* Ref.get(stateRef);
          return states.get(sessionId) || {};
        }),

      setState: (sessionId: string, state: Record<string, unknown>) =>
        Effect.gen(function* () {
          yield* Ref.update(stateRef, (states) => {
            const newStates = new Map(states);
            newStates.set(sessionId, state);
            return newStates;
          });
        }),
    };
  })
);
