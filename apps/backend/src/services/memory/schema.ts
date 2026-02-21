import { createId } from "@paralleldrive/cuid2";
import { sql } from "drizzle-orm";
import {
  sqliteTable,
  integer,
  text,
  index,
  customType,
} from "drizzle-orm/sqlite-core";

// Vector type definition for Turso/libSQL
export const EMBEDDING_DIMENSIONS = 768;

const float32Array = customType<{
  data: number[];
  config: { dimensions: number };
  configRequired: true;
  driverData: Buffer;
}>({
  dataType(config) {
    return `F32_BLOB(${config.dimensions})`;
  },
  fromDriver(value: Buffer) {
    return Array.from(new Float32Array(value.buffer));
  },
  toDriver(value: number[]) {
    return sql`vector32(${JSON.stringify(value)})`;
  },
});

// Sessions table - persistent "chats" that users can return to
export const sessions = sqliteTable("sessions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  userId: text("user_id").notNull(), // For future auth, default "default-user"

  name: text("name"), // Optional user-given name, e.g., "Landing Page"

  createdAt: integer("created_at").notNull(),
  lastAccessedAt: integer("last_accessed_at").notNull(),
});

// Session memory entries - unified entries (input + output) per request batch
export const sessionMemoryEntries = sqliteTable("session_memory_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),

  // Input - supports batched prompts/actions (e.g., user clicks 3 times quickly)
  prompts: text("prompts", { mode: "json" }), // JSON array of prompt objects
  promptSummary: text("prompt_summary"), // LLM-generated summary of all prompts

  actions: text("actions", { mode: "json" }), // JSON array of action objects
  actionSummary: text("action_summary"), // LLM-generated summary of all actions

  // Output
  changeSummary: text("change_summary").notNull(),
  patchCount: integer("patch_count").notNull(),

  // Semantic search
  embedding: float32Array("embedding", { dimensions: EMBEDDING_DIMENSIONS }),

  // Metadata
  createdAt: integer("created_at").notNull(),
});

// Stream events - durable event log for reconnectable streams
export const streamEvents = sqliteTable(
  "stream_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id").notNull(),
    offset: integer("offset").notNull(),
    eventType: text("event_type").notNull(),
    data: text("data").notNull(), // JSON-serialized StreamEvent
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("stream_events_session_offset_idx").on(
      table.sessionId,
      table.offset
    ),
    index("stream_events_created_at_idx").on(table.createdAt),
  ]
);

// ============================================================
// Sandbox: doc chunks
// ============================================================

// Doc chunks — SDK documentation stored with embeddings for vector search
export const docChunks = sqliteTable(
  "doc_chunks",
  {
    id: text("id").primaryKey(), // hash(package + heading)
    package: text("package").notNull(),
    heading: text("heading").notNull(),
    content: text("content").notNull(),
    url: text("url").notNull(),
    contentHash: text("content_hash").notNull(),
    embedding: float32Array("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("doc_chunks_package_idx").on(table.package)],
);

// Type exports
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type SessionMemoryEntry = typeof sessionMemoryEntries.$inferSelect;
export type NewSessionMemoryEntry = typeof sessionMemoryEntries.$inferInsert;
export type StreamEventRow = typeof streamEvents.$inferSelect;
export type NewStreamEventRow = typeof streamEvents.$inferInsert;
export type DocChunk = typeof docChunks.$inferSelect;
export type NewDocChunk = typeof docChunks.$inferInsert;
