CREATE TABLE `code_modules` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`volume_slug` text NOT NULL,
	`path` text NOT NULL,
	`description` text NOT NULL,
	`exports` text NOT NULL,
	`usage` text NOT NULL,
	`embedding` F32_BLOB(768),
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`volume_slug`) REFERENCES `session_volumes`(`volume_slug`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `code_modules_session_idx` ON `code_modules` (`session_id`);--> statement-breakpoint
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
CREATE TABLE `session_volumes` (
	`session_id` text PRIMARY KEY NOT NULL,
	`volume_slug` text NOT NULL,
	`region` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_accessed_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_volumes_volume_slug_unique` ON `session_volumes` (`volume_slug`);