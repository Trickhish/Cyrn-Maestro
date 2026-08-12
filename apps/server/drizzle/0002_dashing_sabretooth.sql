CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`actor_user_id` text,
	`actor_email` text,
	`action` text NOT NULL,
	`target` text,
	`metadata` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_org_idx` ON `audit_log` (`org_id`);--> statement-breakpoint
CREATE INDEX `audit_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`invited_by` text,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `invitations_org_idx` ON `invitations` (`org_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_token_unique` ON `invitations` (`token_hash`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memberships_org_idx` ON `memberships` (`org_id`);--> statement-breakpoint
CREATE INDEX `memberships_user_idx` ON `memberships` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_user_org_unique` ON `memberships` (`user_id`,`org_id`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`require_2fa` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_slug_unique` ON `organizations` (`slug`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text,
	`owner_org_id` text,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`repo_url` text,
	`branch` text DEFAULT 'main',
	`instructions` text,
	`default_model_id` text,
	`spend_cap_usd` real,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_projects`("id", "owner_user_id", "owner_org_id", "name", "slug", "repo_url", "branch", "instructions", "default_model_id", "spend_cap_usd", "created_at") SELECT "id", "owner_user_id", "owner_org_id", "name", "slug", "repo_url", "branch", "instructions", "default_model_id", "spend_cap_usd", "created_at" FROM `projects`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `projects_org_idx` ON `projects` (`owner_org_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_owner_slug_unique` ON `projects` (`owner_user_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_org_slug_unique` ON `projects` (`owner_org_id`,`slug`);--> statement-breakpoint
CREATE TABLE `__new_enrollment_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text,
	`owner_org_id` text,
	`project_id` text,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_enrollment_tokens`("id", "owner_user_id", "owner_org_id", "project_id", "token_hash", "expires_at", "used_at", "created_at") SELECT "id", "owner_user_id", "owner_org_id", "project_id", "token_hash", "expires_at", "used_at", "created_at" FROM `enrollment_tokens`;--> statement-breakpoint
DROP TABLE `enrollment_tokens`;--> statement-breakpoint
ALTER TABLE `__new_enrollment_tokens` RENAME TO `enrollment_tokens`;--> statement-breakpoint
CREATE UNIQUE INDEX `enrollment_token_unique` ON `enrollment_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `__new_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text,
	`owner_org_id` text,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`status` text DEFAULT 'offline' NOT NULL,
	`os` text,
	`arch` text,
	`version` text,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`max_concurrent_tasks` integer DEFAULT 2 NOT NULL,
	`last_seen_at` integer,
	`load_percent` real,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_nodes`("id", "owner_user_id", "owner_org_id", "name", "token_hash", "status", "os", "arch", "version", "capabilities", "max_concurrent_tasks", "last_seen_at", "load_percent", "created_at") SELECT "id", "owner_user_id", "owner_org_id", "name", "token_hash", "status", "os", "arch", "version", "capabilities", "max_concurrent_tasks", "last_seen_at", "load_percent", "created_at" FROM `nodes`;--> statement-breakpoint
DROP TABLE `nodes`;--> statement-breakpoint
ALTER TABLE `__new_nodes` RENAME TO `nodes`;--> statement-breakpoint
CREATE INDEX `nodes_owner_idx` ON `nodes` (`owner_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_token_unique` ON `nodes` (`token_hash`);--> statement-breakpoint
CREATE TABLE `__new_provider_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text,
	`owner_org_id` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`base_url` text NOT NULL,
	`encrypted_key` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_health_at` integer,
	`last_health_ok` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_provider_connections`("id", "owner_user_id", "owner_org_id", "name", "kind", "base_url", "encrypted_key", "enabled", "last_health_at", "last_health_ok", "created_at") SELECT "id", "owner_user_id", "owner_org_id", "name", "kind", "base_url", "encrypted_key", "enabled", "last_health_at", "last_health_ok", "created_at" FROM `provider_connections`;--> statement-breakpoint
DROP TABLE `provider_connections`;--> statement-breakpoint
ALTER TABLE `__new_provider_connections` RENAME TO `provider_connections`;--> statement-breakpoint
CREATE INDEX `providers_owner_idx` ON `provider_connections` (`owner_user_id`);