CREATE TABLE `routing_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`owner_org_id` text,
	`owner_user_id` text,
	`name` text NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`match_text` text,
	`match_tier` text,
	`set_tier` text,
	`set_model_id` text,
	`set_node_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`set_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `routing_rules_project_idx` ON `routing_rules` (`project_id`);--> statement-breakpoint
CREATE INDEX `routing_rules_org_idx` ON `routing_rules` (`owner_org_id`);--> statement-breakpoint
ALTER TABLE `organizations` ADD `default_model_id` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `default_tier` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `spend_cap_usd` real;--> statement-breakpoint
ALTER TABLE `projects` ADD `default_tier` text;