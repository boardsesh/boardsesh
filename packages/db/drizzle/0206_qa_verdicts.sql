CREATE TYPE "public"."qa_verdict_kind" AS ENUM('approved', 'declined');--> statement-breakpoint
CREATE TABLE "qa_verdicts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text,
	"pr_number" integer NOT NULL,
	"branch" text NOT NULL,
	"head_sha" text,
	"head_committed_at" timestamp,
	"verdict" "qa_verdict_kind" NOT NULL,
	"comment" text,
	"platform" text NOT NULL,
	"app_version" text,
	"update_id" text,
	"runtime_version" text,
	"bundle_created_at" timestamp,
	"github_comment_id" bigint,
	"github_comment_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "qa_verdicts" ADD CONSTRAINT "qa_verdicts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "qa_verdicts_pr_created_idx" ON "qa_verdicts" USING btree ("pr_number","created_at");--> statement-breakpoint
CREATE INDEX "qa_verdicts_user_idx" ON "qa_verdicts" USING btree ("user_id");