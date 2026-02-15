import { Effect } from "effect";
import { sql, eq, and, gt, desc, lt } from "drizzle-orm";
import { Database } from "../memory/database.js";
import { streamEvents, type StreamEventRow } from "../memory/schema.js";
import { DurableConfig, type StreamEvent } from "./types.js";

export class DurableEventLog extends Effect.Service<DurableEventLog>()(
  "DurableEventLog",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const { db } = yield* Database;

      const append = (
        sessionId: string,
        offset: number,
        event: StreamEvent
      ) =>
        Effect.promise(() =>
          db.insert(streamEvents).values({
            sessionId,
            offset,
            eventType: event.type,
            data: JSON.stringify(event),
            createdAt: Date.now(),
          })
        );

      const readFrom = (
        sessionId: string,
        fromOffset: number
      ): Effect.Effect<StreamEventRow[]> =>
        Effect.promise(() =>
          db
            .select()
            .from(streamEvents)
            .where(
              and(
                eq(streamEvents.sessionId, sessionId),
                gt(streamEvents.offset, fromOffset)
              )
            )
            .orderBy(streamEvents.offset)
        );

      const getLatestOffset = (sessionId: string) =>
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            db
              .select({
                maxOffset:
                  sql<number>`COALESCE(MAX(${streamEvents.offset}), -1)`,
              })
              .from(streamEvents)
              .where(eq(streamEvents.sessionId, sessionId))
          );
          return result[0]?.maxOffset ?? -1;
        });

      const getLastHtmlEvent = (sessionId: string) =>
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            db
              .select()
              .from(streamEvents)
              .where(
                and(
                  eq(streamEvents.sessionId, sessionId),
                  sql`${streamEvents.eventType} IN ('done', 'html')`
                )
              )
              .orderBy(desc(streamEvents.offset))
              .limit(1)
          );
          return result[0] ?? null;
        });

      const cleanup = Effect.gen(function* () {
        const cutoff = Date.now() - DurableConfig.EVENT_RETENTION_MS;
        const result = yield* Effect.promise(() =>
          db.delete(streamEvents).where(lt(streamEvents.createdAt, cutoff))
        );
        return result.rowsAffected ?? 0;
      });

      return {
        append,
        readFrom,
        getLatestOffset,
        getLastHtmlEvent,
        cleanup,
      } as const;
    }),
  }
) {}
