ALTER TABLE `models` ADD `probed_at` integer;--> statement-breakpoint
ALTER TABLE `models` ADD `probe_ok` integer;--> statement-breakpoint
ALTER TABLE `models` ADD `probe_error` text;--> statement-breakpoint
ALTER TABLE `models` ADD `needs_reasoning_effort` integer DEFAULT false NOT NULL;