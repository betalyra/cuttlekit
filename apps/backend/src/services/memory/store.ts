import { Effect } from "effect";
import { eq, desc } from "drizzle-orm";
import { Database } from "./database.js";
import {
  sessions,
  sessionMemoryEntries,
  type NewSession,
  type NewSessionMemoryEntry,
} from "./schema.js";

export class StoreService extends Effect.Service<StoreService>()(
  "StoreService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const { db, client } = yield* Database;

      // ============ SESSIONS ============

      const insertSession = (data: Omit<NewSession, "id">) =>
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            db.insert(sessions).values(data).returning()
          );
          return result[0];
        });

      const getSession = (sessionId: string) =>
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            db.select().from(sessions).where(eq(sessions.id, sessionId))
          );
          return result[0] ?? null;
        });

      const updateSessionLastAccessed = (sessionId: string) =>
        Effect.promise(() =>
          db
            .update(sessions)
            .set({ lastAccessedAt: Date.now() })
            .where(eq(sessions.id, sessionId))
        );

      const updateSessionName = (sessionId: string, name: string) =>
        Effect.promise(() =>
          db.update(sessions).set({ name }).where(eq(sessions.id, sessionId))
        );

      const listSessionsByUser = (userId: string) =>
        Effect.promise(() =>
          db
            .select()
            .from(sessions)
            .where(eq(sessions.userId, userId))
            .orderBy(desc(sessions.lastAccessedAt))
        );

      const deleteSession = (sessionId: string) =>
        Effect.promise(() =>
          db.delete(sessions).where(eq(sessions.id, sessionId))
        );

      // ============ MEMORY ENTRIES ============

      const insertMemoryEntry = (data: Omit<NewSessionMemoryEntry, "id">) =>
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            db.insert(sessionMemoryEntries).values(data).returning()
          );
          return result[0];
        });

      const getRecentEntries = (sessionId: string, count: number) =>
        Effect.promise(() =>
          db
            .select()
            .from(sessionMemoryEntries)
            .where(eq(sessionMemoryEntries.sessionId, sessionId))
            .orderBy(desc(sessionMemoryEntries.createdAt))
            .limit(count)
        );

      const searchByVector = (
        sessionId: string,
        embedding: number[],
        limit: number
      ) =>
        Effect.gen(function* () {
          const vectorJson = JSON.stringify(embedding);

          const result = yield* Effect.promise(() =>
            client.execute({
              sql: `
                SELECT
                  sme.id,
                  sme.session_id as sessionId,
                  sme.prompts,
                  sme.prompt_summary as promptSummary,
                  sme.actions,
                  sme.action_summary as actionSummary,
                  sme.change_summary as changeSummary,
                  sme.patch_count as patchCount,
                  sme.created_at as createdAt,
                  vector_distance_cos(sme.embedding, vector32(?)) as distance
                FROM vector_top_k('session_memory_entries_embedding_idx', vector32(?), ?) AS vt
                JOIN session_memory_entries sme ON sme.rowid = vt.id
                WHERE sme.session_id = ?
                ORDER BY distance ASC
              `,
              args: [vectorJson, vectorJson, limit * 2, sessionId],
            })
          );

          return result.rows.slice(0, limit).map((row) => ({
            id: row.id as number,
            sessionId: row.sessionId as string,
            prompts: row.prompts as string | null,
            promptSummary: row.promptSummary as string | null,
            actions: row.actions as string | null,
            actionSummary: row.actionSummary as string | null,
            changeSummary: row.changeSummary as string,
            patchCount: row.patchCount as number,
            createdAt: row.createdAt as number,
            distance: row.distance as number,
          }));
        });

      return {
        // Sessions
        insertSession,
        getSession,
        updateSessionLastAccessed,
        updateSessionName,
        listSessionsByUser,
        deleteSession,
        // Memory entries
        insertMemoryEntry,
        getRecentEntries,
        searchByVector,
      };
    }),
  }
) {}
