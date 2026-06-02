-- Order matters: dedupe BEFORE dropping indexes. user_favorites_user_idx
-- and the old 4-column unique_user_favorite both give the self-join lookup
-- paths during DELETE. Dropping them first would force seq-scan +
-- nested-loop on a potentially large production table.
-- Dedupe rows that share (user_id, climb_uuid) across different
-- (board_name, angle), keeping the most recently created (tiebreak on id).
DELETE FROM "user_favorites" a
USING "user_favorites" b
WHERE a."user_id" = b."user_id"
  AND a."climb_uuid" = b."climb_uuid"
  AND (a."created_at" < b."created_at"
       OR (a."created_at" = b."created_at" AND a."id" < b."id"));--> statement-breakpoint
DROP INDEX "user_favorites_user_idx";--> statement-breakpoint
DROP INDEX "user_favorites_climb_idx";--> statement-breakpoint
DROP INDEX "unique_user_favorite";--> statement-breakpoint
CREATE UNIQUE INDEX "unique_user_favorite" ON "user_favorites" USING btree ("user_id","climb_uuid");--> statement-breakpoint
ALTER TABLE "user_favorites" DROP COLUMN "board_name";--> statement-breakpoint
ALTER TABLE "user_favorites" DROP COLUMN "angle";
