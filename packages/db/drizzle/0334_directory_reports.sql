CREATE TYPE "public"."directory_report_reason" AS ENUM('wrong_setup', 'duplicate', 'gone', 'wrong_place', 'other', 'relist_request', 'closed', 'wrong_details', 'not_a_gym');--> statement-breakpoint
CREATE TYPE "public"."directory_report_recipient" AS ENUM('creator', 'gym_staff', 'admin');--> statement-breakpoint
CREATE TYPE "public"."directory_report_resolver_role" AS ENUM('creator', 'gym_staff', 'admin', 'auto');--> statement-breakpoint
CREATE TYPE "public"."directory_report_status" AS ENUM('open', 'escalated', 'fixed', 'removed', 'deleted', 'kept', 'merged');--> statement-breakpoint
CREATE TYPE "public"."directory_report_target_kind" AS ENUM('board', 'gym');--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'board_report_opened';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'board_report_resolved';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'board_removed_from_gym';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'board_deleted_by_staff';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'board_edited_by_staff';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'gym_report_opened';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'gym_report_resolved';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'gym_claimed_with_your_board';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'gym_claim_denied';--> statement-breakpoint
CREATE TABLE "admin_daily_digests" (
	"digest_date" date PRIMARY KEY NOT NULL,
	"window_start" timestamp NOT NULL,
	"window_end" timestamp NOT NULL,
	"status" text NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "admin_daily_digests_status_check" CHECK ("admin_daily_digests"."status" IN ('sending', 'sent', 'empty'))
);
--> statement-breakpoint
CREATE TABLE "directory_notification_context" (
	"notification_uuid" text PRIMARY KEY NOT NULL,
	"report_id" bigint,
	"board_id" bigint,
	"gym_id" bigint,
	"is_reminder" boolean DEFAULT false NOT NULL,
	"actor_role" "board_moderation_actor_role",
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directory_report_reporters" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"report_id" bigint NOT NULL,
	"reporter_id" text,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directory_reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"uuid" text NOT NULL,
	"target_kind" "directory_report_target_kind" NOT NULL,
	"board_id" bigint,
	"gym_id" bigint,
	"gym_id_at_report" bigint,
	"reason" "directory_report_reason" NOT NULL,
	"duplicate_of_board_id" bigint,
	"duplicate_of_gym_id" bigint,
	"status" "directory_report_status" DEFAULT 'open' NOT NULL,
	"routed_to" "directory_report_recipient"[] NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"reminded_at" timestamp,
	"escalated_at" timestamp,
	"resolved_at" timestamp,
	"resolved_by" text,
	"resolved_by_role" "directory_report_resolver_role",
	"resolution_note" text,
	CONSTRAINT "directory_reports_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "directory_reports_target_check" CHECK (("directory_reports"."target_kind" = 'board' AND "directory_reports"."board_id" IS NOT NULL AND "directory_reports"."gym_id" IS NULL)
        OR ("directory_reports"."target_kind" = 'gym' AND "directory_reports"."gym_id" IS NOT NULL AND "directory_reports"."board_id" IS NULL AND "directory_reports"."gym_id_at_report" IS NULL)),
	CONSTRAINT "directory_reports_resolution_check" CHECK (("directory_reports"."status" IN ('open', 'escalated')) = ("directory_reports"."resolved_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "directory_notification_context" ADD CONSTRAINT "directory_notification_context_notification_uuid_notifications_uuid_fk" FOREIGN KEY ("notification_uuid") REFERENCES "public"."notifications"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_notification_context" ADD CONSTRAINT "directory_notification_context_report_id_directory_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."directory_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_notification_context" ADD CONSTRAINT "directory_notification_context_board_id_user_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."user_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_notification_context" ADD CONSTRAINT "directory_notification_context_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_report_reporters" ADD CONSTRAINT "directory_report_reporters_report_id_directory_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."directory_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_report_reporters" ADD CONSTRAINT "directory_report_reporters_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_reports" ADD CONSTRAINT "directory_reports_board_id_user_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."user_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_reports" ADD CONSTRAINT "directory_reports_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_reports" ADD CONSTRAINT "directory_reports_gym_id_at_report_gyms_id_fk" FOREIGN KEY ("gym_id_at_report") REFERENCES "public"."gyms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_reports" ADD CONSTRAINT "directory_reports_duplicate_of_board_id_user_boards_id_fk" FOREIGN KEY ("duplicate_of_board_id") REFERENCES "public"."user_boards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_reports" ADD CONSTRAINT "directory_reports_duplicate_of_gym_id_gyms_id_fk" FOREIGN KEY ("duplicate_of_gym_id") REFERENCES "public"."gyms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_reports" ADD CONSTRAINT "directory_reports_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "directory_notification_context_report_idx" ON "directory_notification_context" USING btree ("report_id");--> statement-breakpoint
CREATE UNIQUE INDEX "directory_report_reporters_report_reporter_idx" ON "directory_report_reporters" USING btree ("report_id","reporter_id") WHERE "directory_report_reporters"."reporter_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "directory_report_reporters_reporter_idx" ON "directory_report_reporters" USING btree ("reporter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "directory_reports_open_board_reason_idx" ON "directory_reports" USING btree ("board_id","reason") WHERE "directory_reports"."board_id" IS NOT NULL AND "directory_reports"."status" IN ('open', 'escalated');--> statement-breakpoint
CREATE UNIQUE INDEX "directory_reports_open_gym_reason_idx" ON "directory_reports" USING btree ("gym_id","reason") WHERE "directory_reports"."gym_id" IS NOT NULL AND "directory_reports"."status" IN ('open', 'escalated');--> statement-breakpoint
CREATE INDEX "directory_reports_board_created_idx" ON "directory_reports" USING btree ("board_id","created_at") WHERE "directory_reports"."board_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "directory_reports_gym_created_idx" ON "directory_reports" USING btree ("gym_id","created_at") WHERE "directory_reports"."gym_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "directory_reports_gym_at_report_idx" ON "directory_reports" USING btree ("gym_id_at_report","created_at") WHERE "directory_reports"."gym_id_at_report" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "directory_reports_waiting_created_idx" ON "directory_reports" USING btree ("status","created_at") WHERE "directory_reports"."status" IN ('open', 'escalated');--> statement-breakpoint
CREATE INDEX "directory_reports_escalated_at_idx" ON "directory_reports" USING btree ("escalated_at") WHERE "directory_reports"."escalated_at" IS NOT NULL;