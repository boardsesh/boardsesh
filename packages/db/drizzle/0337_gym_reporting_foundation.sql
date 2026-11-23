CREATE TABLE "gym_reporting_board_aliases" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"gym_id" bigint NOT NULL,
	"board_id" bigint NOT NULL,
	"root_board_id" bigint NOT NULL,
	"verified_by" text,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_by" text,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "gym_reporting_alias_different_boards" CHECK ("gym_reporting_board_aliases"."board_id" <> "gym_reporting_board_aliases"."root_board_id")
);
--> statement-breakpoint
ALTER TABLE "gyms" ADD COLUMN "reporting_time_zone" text;--> statement-breakpoint
ALTER TABLE "boardsesh_ticks" ADD COLUMN "reporting_board_id" bigint;--> statement-breakpoint
ALTER TABLE "boardsesh_ticks" ADD COLUMN "reporting_gym_id" bigint;--> statement-breakpoint
ALTER TABLE "boardsesh_ticks" ADD COLUMN "reporting_attribution" text;--> statement-breakpoint
ALTER TABLE "boardsesh_ticks" ADD COLUMN "reporting_time_precision" text;--> statement-breakpoint
ALTER TABLE "boardsesh_ticks" ADD COLUMN "reporting_date" date;--> statement-breakpoint
ALTER TABLE "boardsesh_ticks" ADD COLUMN "reporting_date_time_zone" text;--> statement-breakpoint
ALTER TABLE "board_climb_events" ADD COLUMN "reporting_board_id" bigint;--> statement-breakpoint
ALTER TABLE "board_climb_events" ADD COLUMN "reporting_gym_id" bigint;--> statement-breakpoint
ALTER TABLE "board_climb_events" ADD COLUMN "reporting_mirrored" boolean;--> statement-breakpoint
ALTER TABLE "gym_reporting_board_aliases" ADD CONSTRAINT "gym_reporting_board_aliases_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_reporting_board_aliases" ADD CONSTRAINT "gym_reporting_board_aliases_board_id_user_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."user_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_reporting_board_aliases" ADD CONSTRAINT "gym_reporting_board_aliases_root_board_id_user_boards_id_fk" FOREIGN KEY ("root_board_id") REFERENCES "public"."user_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_reporting_board_aliases" ADD CONSTRAINT "gym_reporting_board_aliases_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_reporting_board_aliases" ADD CONSTRAINT "gym_reporting_board_aliases_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gym_reporting_alias_active_board_idx" ON "gym_reporting_board_aliases" USING btree ("board_id") WHERE "gym_reporting_board_aliases"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "gym_reporting_alias_active_root_idx" ON "gym_reporting_board_aliases" USING btree ("root_board_id") WHERE "gym_reporting_board_aliases"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "user_boards_merged_board_idx" ON "user_boards" USING btree ("merged_into_board_uuid") WHERE "user_boards"."merged_into_board_uuid" IS NOT NULL;