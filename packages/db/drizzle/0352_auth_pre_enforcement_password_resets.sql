CREATE TABLE "auth_pre_enforcement_password_reset_events" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"previous_generation" integer NOT NULL,
	"generation" integer NOT NULL,
	"kind" text NOT NULL,
	"domains" text[] NOT NULL,
	"context_phase" text NOT NULL,
	"prepared_projection_id" text,
	"prepared_writer_epoch" integer,
	"revoked_through" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_pre_enforcement_password_reset_events_generation" CHECK ("auth_pre_enforcement_password_reset_events"."previous_generation" >= 0 AND "auth_pre_enforcement_password_reset_events"."generation" = "auth_pre_enforcement_password_reset_events"."previous_generation" + 1),
	CONSTRAINT "auth_pre_enforcement_password_reset_events_kind" CHECK ("auth_pre_enforcement_password_reset_events"."kind" = 'password-reset'),
	CONSTRAINT "auth_pre_enforcement_password_reset_events_domains" CHECK ("auth_pre_enforcement_password_reset_events"."domains" = ARRAY['first-party', 'partner']::text[]),
	CONSTRAINT "auth_pre_enforcement_password_reset_events_context" CHECK (("auth_pre_enforcement_password_reset_events"."context_phase" = 'absent' AND "auth_pre_enforcement_password_reset_events"."prepared_projection_id" IS NULL AND "auth_pre_enforcement_password_reset_events"."prepared_writer_epoch" IS NULL) OR ("auth_pre_enforcement_password_reset_events"."context_phase" = 'prepared' AND "auth_pre_enforcement_password_reset_events"."prepared_projection_id" IS NOT NULL AND length("auth_pre_enforcement_password_reset_events"."prepared_projection_id") > 0 AND "auth_pre_enforcement_password_reset_events"."prepared_writer_epoch" IS NOT NULL AND "auth_pre_enforcement_password_reset_events"."prepared_writer_epoch" > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_pre_enforcement_password_reset_events_generation_idx" ON "auth_pre_enforcement_password_reset_events" USING btree ("user_id","generation");