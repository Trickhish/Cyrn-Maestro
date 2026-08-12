-- Model groups: one alias standing in for several ids of the same model.
--
-- Many providers and proxies re-publish the same underlying model under a
-- different id — a dated snapshot, a routing alias, a per-vendor rename.
-- "Claude Opus" can easily be a dozen ids across a real fleet. A group names
-- that: tried in the group's own order, so a list is built from "Claude
-- Opus" once instead of every variant of it individually.
CREATE TABLE `model_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text,
	`owner_org_id` text,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_groups_user_name_unique` ON `model_groups` (`owner_user_id`,`name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_groups_org_name_unique` ON `model_groups` (`owner_org_id`,`name`);
--> statement-breakpoint
CREATE INDEX `model_groups_org_idx` ON `model_groups` (`owner_org_id`);
--> statement-breakpoint
CREATE TABLE `model_group_members` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`model_id` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `model_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_group_members_unique` ON `model_group_members` (`group_id`,`model_id`);
--> statement-breakpoint
CREATE INDEX `model_group_members_group_idx` ON `model_group_members` (`group_id`);
--> statement-breakpoint
-- model_list_entries becomes polymorphic: model_id or group_id, one of the
-- two. SQLite cannot ALTER a column to nullable in place, so the table is
-- rebuilt — existing rows keep their model_id and get a null group_id, which
-- is exactly what they already meant.
CREATE TABLE `model_list_entries_new` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`model_id` text,
	`group_id` text,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `model_lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `model_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `model_list_entries_new` (`id`, `list_id`, `model_id`, `group_id`, `position`, `created_at`)
SELECT `id`, `list_id`, `model_id`, NULL, `position`, `created_at` FROM `model_list_entries`;
--> statement-breakpoint
DROP TABLE `model_list_entries`;
--> statement-breakpoint
ALTER TABLE `model_list_entries_new` RENAME TO `model_list_entries`;
--> statement-breakpoint
CREATE UNIQUE INDEX `model_list_entries_model_unique` ON `model_list_entries` (`list_id`,`model_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_list_entries_group_unique` ON `model_list_entries` (`list_id`,`group_id`);
--> statement-breakpoint
CREATE INDEX `model_list_entries_list_idx` ON `model_list_entries` (`list_id`);
