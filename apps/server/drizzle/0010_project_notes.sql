-- What a project knows about itself, beyond code.
--
-- Directories beyond the workspace root, URLs, ports, and free-text memories,
-- so an agent told "the project already exists at this path" can write that
-- down once instead of the same context having to be re-supplied every task.
CREATE TABLE `project_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text,
	`value` text NOT NULL,
	`node_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `project_notes_project_idx` ON `project_notes` (`project_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_notes_label_unique` ON `project_notes` (`project_id`,`kind`,`label`);
