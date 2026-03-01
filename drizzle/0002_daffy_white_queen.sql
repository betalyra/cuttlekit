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
CREATE INDEX `stream_events_created_at_idx` ON `stream_events` (`created_at`);