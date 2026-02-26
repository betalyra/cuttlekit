import { DateTime, Effect } from "effect";
import { StoreService, type SessionSnapshot } from "./memory/index.js";

const DEFAULT_USER_ID = "default-user";

export class SessionService extends Effect.Service<SessionService>()(
  "SessionService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const store = yield* StoreService;

      const createSession = (userId: string = DEFAULT_USER_ID) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const timestamp = DateTime.toEpochMillis(now);

          // Store handles ID generation via cuid2, returns the new session
          const session = yield* store.insertSession({
            userId,
            createdAt: timestamp,
            lastAccessedAt: timestamp,
          });

          return session;
        });

      const getSession = (sessionId: string) => store.getSession(sessionId);

      const getOrCreateSession = (sessionId?: string, userId?: string) =>
        Effect.gen(function* () {
          if (sessionId) {
            const session = yield* getSession(sessionId);
            if (session) {
              yield* store.updateSessionLastAccessed(sessionId);
              return session;
            }
          }
          return yield* createSession(userId);
        });

      const listSessions = (userId: string = DEFAULT_USER_ID) =>
        store.listSessionsByUser(userId);

      const renameSession = (sessionId: string, name: string) =>
        store.updateSessionName(sessionId, name);

      const deleteSession = (sessionId: string) =>
        store.deleteSession(sessionId);

      const saveSnapshot = (sessionId: string, snapshot: SessionSnapshot) =>
        store.saveSnapshot(sessionId, snapshot);

      const getSnapshot = (sessionId: string) =>
        store.getSnapshot(sessionId);

      return {
        createSession,
        getSession,
        getOrCreateSession,
        listSessions,
        renameSession,
        deleteSession,
        saveSnapshot,
        getSnapshot,
      };
    }),
  }
) {}
