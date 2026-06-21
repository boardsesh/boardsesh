CREATE TABLE "board_climb_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_id" bigint NOT NULL,
	"board_type" text NOT NULL,
	"climb_uuid" text NOT NULL,
	"angle" integer NOT NULL,
	"user_id" text,
	"session_id" text,
	"seq" bigint NOT NULL,
	"frames" text,
	"name" text,
	"grade" text,
	"setter" text,
	"confirmed_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_climb_events" ADD CONSTRAINT "board_climb_events_board_id_user_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."user_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_climb_events" ADD CONSTRAINT "board_climb_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_climb_events" ADD CONSTRAINT "board_climb_events_session_id_board_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."board_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_climb_events_board_confirmed_at_idx" ON "board_climb_events" USING btree ("board_id","confirmed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "board_climb_events_board_seq_unique" ON "board_climb_events" USING btree ("board_id","seq");--> statement-breakpoint
CREATE INDEX "board_climb_events_session_idx" ON "board_climb_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "board_climb_events_board_climb_idx" ON "board_climb_events" USING btree ("board_id","climb_uuid");