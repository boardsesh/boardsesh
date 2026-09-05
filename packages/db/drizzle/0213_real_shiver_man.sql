CREATE TABLE "user_board_activity" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"board_uuid" text NOT NULL,
	"last_used_at" timestamp,
	"pinned_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_board_activity" ADD CONSTRAINT "user_board_activity_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_board_activity" ADD CONSTRAINT "user_board_activity_board_uuid_user_boards_uuid_fk" FOREIGN KEY ("board_uuid") REFERENCES "public"."user_boards"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_board_activity_unique_user_board" ON "user_board_activity" USING btree ("user_id","board_uuid");--> statement-breakpoint
CREATE INDEX "user_board_activity_user_idx" ON "user_board_activity" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_board_activity_board_uuid_idx" ON "user_board_activity" USING btree ("board_uuid");