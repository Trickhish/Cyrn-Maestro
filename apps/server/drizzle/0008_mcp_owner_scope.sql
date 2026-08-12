-- MCP servers move from project scope to owner scope.
--
-- A connection to GitHub or a database is a fact about the team, not about one
-- repository. Existing rows are carried over by taking the owner of the project
-- they belonged to, so nothing configured is silently lost.

CREATE TABLE `mcp_servers_new` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text,
	`owner_org_id` text,
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
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `mcp_servers_new`
SELECT
	m.`id`,
	p.`owner_user_id`,
	p.`owner_org_id`,
	m.`name`, m.`placement`, m.`transport`, m.`url`, m.`encrypted_headers`,
	m.`command`, m.`args`, m.`encrypted_env`, m.`enabled`, m.`tool_allowlist`,
	m.`approval`, m.`last_error`, m.`last_connected_at`, m.`created_at`
FROM `mcp_servers` m
JOIN `projects` p ON p.`id` = m.`project_id`;
--> statement-breakpoint
DROP TABLE `mcp_servers`;
--> statement-breakpoint
ALTER TABLE `mcp_servers_new` RENAME TO `mcp_servers`;
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_user_name_unique` ON `mcp_servers` (`owner_user_id`,`name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_org_name_unique` ON `mcp_servers` (`owner_org_id`,`name`);
--> statement-breakpoint
CREATE INDEX `mcp_owner_user_idx` ON `mcp_servers` (`owner_user_id`);
--> statement-breakpoint
CREATE INDEX `mcp_owner_org_idx` ON `mcp_servers` (`owner_org_id`);
