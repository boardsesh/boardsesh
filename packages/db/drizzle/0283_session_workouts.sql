CREATE TABLE "session_workouts" (
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"plan" jsonb NOT NULL,
	"tick_map" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_workouts" ADD CONSTRAINT "session_workouts_session_id_board_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."board_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_workouts" ADD CONSTRAINT "session_workouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_workouts_session_user_idx" ON "session_workouts" USING btree ("session_id","user_id");