CREATE TABLE `instance_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`secret` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `password_resets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`requested_ip` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `password_reset_user_idx` ON `password_resets` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `password_reset_token_unique` ON `password_resets` (`token_hash`);