CREATE TABLE "board_session_sends" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"item" jsonb NOT NULL,
	"climb_uuid" text NOT NULL,
	"sent_by_user_id" text NOT NULL,
	"active_climber_user_id" text NOT NULL,
	"correlation_id" text,
	"sequence" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_session_queues" ADD COLUMN "picks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "board_session_queues" ADD COLUMN "active_climber_user_id" text;--> statement-breakpoint
ALTER TABLE "board_session_sends" ADD CONSTRAINT "board_session_sends_session_id_board_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."board_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_session_sends_session_created_idx" ON "board_session_sends" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "board_session_sends_session_climb_idx" ON "board_session_sends" USING btree ("session_id","climb_uuid");