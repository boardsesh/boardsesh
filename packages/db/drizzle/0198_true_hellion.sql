ALTER TABLE "user_boards" ADD COLUMN "merged_into_board_uuid" text;--> statement-breakpoint
CREATE INDEX "user_boards_merged_slug_idx" ON "user_boards" USING btree ("slug") WHERE "user_boards"."merged_into_board_uuid" IS NOT NULL;
