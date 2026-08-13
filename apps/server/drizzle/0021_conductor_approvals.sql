ALTER TABLE projects ADD COLUMN conductor_approves INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE approvals ADD COLUMN decided_by_conductor INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE approvals ADD COLUMN decision_reason TEXT;
