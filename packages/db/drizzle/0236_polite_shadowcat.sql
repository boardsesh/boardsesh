CREATE INDEX "user_boards_gym_filter_idx" ON "user_boards" USING btree ("gym_id","board_type","layout_id","size_id","angle") WHERE "user_boards"."deleted_at" IS NULL;
