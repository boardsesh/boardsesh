CREATE TABLE "activity_push_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_push_tokens" ADD CONSTRAINT "activity_push_tokens_session_id_board_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."board_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_push_tokens_session_idx" ON "activity_push_tokens" USING btree ("session_id");