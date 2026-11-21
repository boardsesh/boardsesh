ALTER TYPE "public"."notification_type" ADD VALUE 'app_feedback_reply' BEFORE 'new_follower';--> statement-breakpoint
CREATE TABLE "app_feedback_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"report_id" bigint NOT NULL,
	"author_id" text,
	"author_role" text NOT NULL,
	"body" text NOT NULL,
	"submitted_body_hash" text,
	"client_mutation_id" text NOT NULL,
	"notification_uuid" text NOT NULL,
	"github_comment_id" text,
	"withdrawn_at" timestamp,
	"delivery_status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_feedback_messages_notification_uuid_unique" UNIQUE("notification_uuid"),
	CONSTRAINT "app_feedback_messages_github_comment_id_unique" UNIQUE("github_comment_id")
);
--> statement-breakpoint
ALTER TABLE "app_feedback" ADD COLUMN "github_issue_state" text;--> statement-breakpoint
ALTER TABLE "app_feedback" ADD COLUMN "github_issue_state_reason" text;--> statement-breakpoint
ALTER TABLE "app_feedback" ADD COLUMN "last_message_at" timestamp;--> statement-breakpoint
ALTER TABLE "app_feedback" ADD COLUMN "last_message_preview" text;--> statement-breakpoint
ALTER TABLE "app_feedback" ADD COLUMN "needs_reply" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app_feedback_messages" ADD CONSTRAINT "app_feedback_messages_report_id_app_feedback_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."app_feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_feedback_messages" ADD CONSTRAINT "app_feedback_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_feedback_messages_report_idx" ON "app_feedback_messages" USING btree ("report_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_feedback_messages_mutation_idx" ON "app_feedback_messages" USING btree ("author_id","client_mutation_id");