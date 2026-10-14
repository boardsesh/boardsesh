ALTER TABLE "comments" ADD COLUMN "release_context" jsonb;--> statement-breakpoint
ALTER TABLE "qa_verdicts" ADD COLUMN "release_context" jsonb;--> statement-breakpoint
ALTER TABLE "spray_wall_reports" ADD COLUMN "release_context" jsonb;