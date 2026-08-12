-- Named, ordered fallback chains of models for a kind of work.
--
-- Not the tier system: a tier is a coarse automatic guess from a model's
-- name; a list is curated by hand and named for a purpose, with a
-- description meant for whatever ends up choosing a model per task.
CREATE TABLE `model_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text,
	`owner_org_id` text,
	`name` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_lists_user_name_unique` ON `model_lists` (`owner_user_id`,`name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_lists_org_name_unique` ON `model_lists` (`owner_org_id`,`name`);
--> statement-breakpoint
CREATE INDEX `model_lists_org_idx` ON `model_lists` (`owner_org_id`);
--> statement-breakpoint
CREATE TABLE `model_list_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`model_id` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `model_lists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_list_entries_unique` ON `model_list_entries` (`list_id`,`model_id`);
--> statement-breakpoint
CREATE INDEX `model_list_entries_list_idx` ON `model_list_entries` (`list_id`);
