CREATE TYPE "public"."board_history_source" AS ENUM('ble_send', 'manual', 'shared_queue_relay');--> statement-breakpoint
CREATE TABLE "board_climb_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"uuid" text NOT NULL,
	"board_serial" text NOT NULL,
	"board_id" bigint,
	"user_id" text NOT NULL,
	"climb_uuid" text NOT NULL,
	"board_type" text NOT NULL,
	"layout_id" bigint NOT NULL,
	"angle" integer NOT NULL,
	"is_mirror" boolean DEFAULT false NOT NULL,
	"frames" text,
	"source" "board_history_source" NOT NULL,
	"session_id" text,
	"shared_playlist_mode" boolean DEFAULT false NOT NULL,
	"tick_id" bigint,
	"sequence" bigint NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_climb_history_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
CREATE TABLE "board_history_sequences" (
	"board_serial" text PRIMARY KEY NOT NULL,
	"last_sequence" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_sessions" ADD COLUMN "shared_playlist_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Note: activity_push_tokens.user_id (and its FK + index) were added in 0098_mute_talos.sql
-- but the snapshot for 0098 wasn't regenerated, so drizzle-kit was picking them up here as
-- pending drift. They're already in production. The 0101 snapshot now captures the truth so
-- future generations won't re-emit them.
ALTER TABLE "board_climb_history" ADD CONSTRAINT "board_climb_history_board_id_user_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."user_boards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_climb_history" ADD CONSTRAINT "board_climb_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_climb_history" ADD CONSTRAINT "board_climb_history_session_id_board_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."board_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_climb_history" ADD CONSTRAINT "board_climb_history_tick_id_boardsesh_ticks_id_fk" FOREIGN KEY ("tick_id") REFERENCES "public"."boardsesh_ticks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_climb_history_serial_sent_at_idx" ON "board_climb_history" USING btree ("board_serial","sent_at" desc);--> statement-breakpoint
CREATE INDEX "board_climb_history_serial_sequence_idx" ON "board_climb_history" USING btree ("board_serial","sequence" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "board_climb_history_serial_sequence_unique" ON "board_climb_history" USING btree ("board_serial","sequence");--> statement-breakpoint
CREATE INDEX "board_climb_history_board_sent_at_idx" ON "board_climb_history" USING btree ("board_id","sent_at" desc) WHERE "board_climb_history"."board_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "board_climb_history_climb_sent_at_idx" ON "board_climb_history" USING btree ("climb_uuid","sent_at" desc);--> statement-breakpoint
CREATE INDEX "board_climb_history_user_sent_at_idx" ON "board_climb_history" USING btree ("user_id","sent_at" desc);