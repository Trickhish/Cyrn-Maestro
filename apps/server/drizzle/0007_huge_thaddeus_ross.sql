CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`placement` text NOT NULL,
	`transport` text NOT NULL,
	`url` text,
	`encrypted_headers` text,
	`command` text,
	`args` text,
	`encrypted_env` text,
	`enabled` integer DEFAULT true NOT NULL,
	`tool_allowlist` text DEFAULT '[]' NOT NULL,
	`approval` text DEFAULT 'ask' NOT NULL,
	`last_error` text,
	`last_connected_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mcp_project_idx` ON `mcp_servers` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_project_name_unique` ON `mcp_servers` (`project_id`,`name`);