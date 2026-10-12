CREATE TABLE "board_share_links" (
	"token" text PRIMARY KEY NOT NULL,
	"board_uuid" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "board_share_links" ADD CONSTRAINT "board_share_links_board_uuid_user_boards_uuid_fk" FOREIGN KEY ("board_uuid") REFERENCES "public"."user_boards"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_share_links" ADD CONSTRAINT "board_share_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "board_share_links_active_board_idx" ON "board_share_links" USING btree ("board_uuid") WHERE "board_share_links"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "board_share_links_board_idx" ON "board_share_links" USING btree ("board_uuid");