CREATE TABLE `doc_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`package` text NOT NULL,
	`heading` text NOT NULL,
	`content` text NOT NULL,
	`url` text NOT NULL,
	`content_hash` text NOT NULL,
	`embedding` F32_BLOB(768),
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `doc_chunks_package_idx` ON `doc_chunks` (`package`);--> statement-breakpoint
CREATE TABLE `session_memory_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`prompts` text,
	`prompt_summary` text,
	`actions` text,
	`action_summary` text,
	`change_summary` text NOT NULL,
	`patch_count` integer NOT NULL,
	`embedding` F32_BLOB(768),
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text,
	`snapshot` text,
	`created_at` integer NOT NULL,
	`last_accessed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stream_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`offset` integer NOT NULL,
	`event_type` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stream_events_session_offset_idx` ON `stream_events` (`session_id`,`offset`);--> statement-breakpoint
CREATE INDEX `stream_events_created_at_idx` ON `stream_events` (`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS session_memory_entries_embedding_idx
ON session_memory_entries(libsql_vector_idx(embedding));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS doc_chunks_embedding_idx
ON doc_chunks(libsql_vector_idx(embedding));