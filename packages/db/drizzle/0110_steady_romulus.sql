CREATE INDEX "user_favorites_sync_cursor_idx" ON "user_favorites" USING btree ("user_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "boardsesh_ticks_sync_cursor_idx" ON "boardsesh_ticks" USING btree ("user_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "playlist_climbs_sync_cursor_idx" ON "playlist_climbs" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "playlists_sync_cursor_idx" ON "playlists" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "playlist_follows_sync_cursor_idx" ON "playlist_follows" USING btree ("follower_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "setter_follows_sync_cursor_idx" ON "setter_follows" USING btree ("follower_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "user_follows_sync_cursor_idx" ON "user_follows" USING btree ("follower_id","updated_at","id");