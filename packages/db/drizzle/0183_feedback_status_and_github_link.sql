CREATE TYPE "public"."app_feedback_status" AS ENUM('new', 'in_progress', 'resolved', 'wont_fix');--> statement-breakpoint
ALTER TABLE "app_feedback" ADD COLUMN "status" "app_feedback_status" DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE "app_feedback" ADD COLUMN "resolved_at" timestamp;--> statement-breakpoint
ALTER TABLE "app_feedback" ADD COLUMN "resolved_by" text;--> statement-breakpoint
ALTER TABLE "app_feedback" ADD COLUMN "github_issue_number" integer;--> statement-breakpoint
ALTER TABLE "app_feedback" ADD COLUMN "github_issue_url" text;--> statement-breakpoint
ALTER TABLE "app_feedback" ADD CONSTRAINT "app_feedback_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_feedback_status_idx" ON "app_feedback" USING btree ("status");