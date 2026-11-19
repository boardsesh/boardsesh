CREATE TABLE `local_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`profile` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `logbook_states` (
	`account_id` text PRIMARY KEY NOT NULL,
	`active_version` text,
	`staging_version` text,
	`staging_owner` text,
	`cursor` text,
	`full_sync_required` integer DEFAULT true NOT NULL,
	`catching_up` integer DEFAULT false NOT NULL,
	`last_synced_at` text
);
--> statement-breakpoint
CREATE TABLE `logbook_ticks` (
	`account_id` text NOT NULL,
	`version` text NOT NULL,
	`tick_id` text NOT NULL,
	`climbed_at` integer NOT NULL,
	`board` text NOT NULL,
	`layout` text NOT NULL,
	`angle` integer NOT NULL,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`climb_id` text NOT NULL,
	`climb_name` text,
	`comment` text,
	`grade_label` text,
	`grade_v` integer,
	`grade_font` text,
	`tick` text NOT NULL,
	PRIMARY KEY(`account_id`, `version`, `tick_id`)
);
--> statement-breakpoint
CREATE INDEX `logbook_ticks_date` ON `logbook_ticks` (`account_id`,`version`,`climbed_at`,`tick_id`);--> statement-breakpoint
CREATE INDEX `logbook_ticks_board` ON `logbook_ticks` (`account_id`,`version`,`board`,`angle`,`status`);--> statement-breakpoint
CREATE INDEX `logbook_ticks_climb` ON `logbook_ticks` (`account_id`,`version`,`climb_id`);--> statement-breakpoint
CREATE TABLE `workout_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`generation` text NOT NULL,
	`body` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`expires_at` integer NOT NULL,
	`result` text
);
