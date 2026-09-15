CREATE TYPE "public"."spray_wall_report_reason" AS ENUM('inappropriate', 'not_a_wall', 'personal_info', 'other');--> statement-breakpoint
CREATE TABLE "spray_wall_reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"wall_id" bigint NOT NULL,
	"reporter_id" text,
	"reason" "spray_wall_report_reason" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"reviewed_at" timestamp,
	"reviewed_by" text
);
--> statement-breakpoint
ALTER TABLE "spray_walls" ADD COLUMN "hidden_at" timestamp;--> statement-breakpoint
ALTER TABLE "spray_walls" ADD COLUMN "hidden_by" text;--> statement-breakpoint
ALTER TABLE "spray_wall_reports" ADD CONSTRAINT "spray_wall_reports_wall_id_spray_walls_id_fk" FOREIGN KEY ("wall_id") REFERENCES "public"."spray_walls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spray_wall_reports" ADD CONSTRAINT "spray_wall_reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spray_wall_reports" ADD CONSTRAINT "spray_wall_reports_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "spray_wall_reports_wall_reporter_idx" ON "spray_wall_reports" USING btree ("wall_id","reporter_id");--> statement-breakpoint
CREATE INDEX "spray_wall_reports_pending_idx" ON "spray_wall_reports" USING btree ("created_at") WHERE "spray_wall_reports"."reviewed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "spray_walls" ADD CONSTRAINT "spray_walls_hidden_by_users_id_fk" FOREIGN KEY ("hidden_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;