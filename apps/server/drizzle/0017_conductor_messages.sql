CREATE TABLE `conductor_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`actor_user_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`model` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conductor_messages_thread_idx` ON `conductor_messages` (`actor_user_id`,`project_id`,`created_at`);
