ALTER TABLE tasks ADD COLUMN conductor_actor_id TEXT REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN conductor_project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN conductor_followed_up INTEGER NOT NULL DEFAULT 0;
