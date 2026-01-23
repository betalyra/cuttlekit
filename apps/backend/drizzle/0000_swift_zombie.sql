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
	`created_at` integer NOT NULL,
	`last_accessed_at` integer NOT NULL
);
