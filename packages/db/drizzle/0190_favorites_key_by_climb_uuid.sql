-- Re-key user_favorites from (user_id, board_name, climb_uuid, angle) to
-- (user_id, climb_uuid). A climb is the same climb whichever board config or
-- angle you were on when you hearted it.
--
-- Statement order matters and is NOT drizzle's default:
--   1. drop the old indexes so the dedupe can run before the new unique index
--      exists (creating it first would fail on any account holding duplicates),
--   2. disable trg_favorites_delete so the dedupe emits ZERO sync_deletions
--      tombstones — an enabled trigger would tombstone climbs the user still
--      has favorited and offline clients would delete the surviving row,
--   3. archive the losing rows into user_favorites_dedup_backup_0190, then
--      delete them (reversible, in-database — no pg_dump-and-pray),
--   4. re-enable the trigger, create the new indexes,
--   5. replace log_deletion_favorites() so tombstones carry a 1-part record_id.
--
-- board_name / angle are kept as vestigial defaulted columns for one release:
-- syncFavorites still emits them, and a pre-OTA device's local SQLite declares
-- them NOT NULL. They get dropped in the follow-up release.
DROP INDEX "unique_user_favorite";--> statement-breakpoint
DROP INDEX "user_favorites_climb_idx";--> statement-breakpoint
ALTER TABLE "user_favorites" ALTER COLUMN "board_name" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "user_favorites" ALTER COLUMN "angle" SET DEFAULT 0;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_favorites_dedup_backup_0190" (
	"id" bigint PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"board_name" text NOT NULL,
	"climb_uuid" text NOT NULL,
	"angle" integer NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_favorites_delete' AND tgrelid = 'user_favorites'::regclass
  ) THEN
    EXECUTE 'ALTER TABLE user_favorites DISABLE TRIGGER trg_favorites_delete';
  END IF;
END $$;--> statement-breakpoint
INSERT INTO "user_favorites_dedup_backup_0190" ("id", "user_id", "board_name", "climb_uuid", "angle", "created_at", "updated_at")
SELECT "id", "user_id", "board_name", "climb_uuid", "angle", "created_at", "updated_at"
FROM (
  SELECT
    "id", "user_id", "board_name", "climb_uuid", "angle", "created_at", "updated_at",
    row_number() OVER (PARTITION BY "user_id", "climb_uuid" ORDER BY "created_at" DESC, "id" DESC) AS rn
  FROM "user_favorites"
) ranked
WHERE ranked.rn > 1
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
DELETE FROM "user_favorites" uf
USING "user_favorites_dedup_backup_0190" backup
WHERE uf."id" = backup."id";--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_favorites_delete' AND tgrelid = 'user_favorites'::regclass
  ) THEN
    EXECUTE 'ALTER TABLE user_favorites ENABLE TRIGGER trg_favorites_delete';
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "unique_user_favorite" ON "user_favorites" USING btree ("user_id","climb_uuid");--> statement-breakpoint
CREATE INDEX "user_favorites_climb_idx" ON "user_favorites" USING btree ("climb_uuid");--> statement-breakpoint
CREATE OR REPLACE FUNCTION log_deletion_favorites() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  VALUES (TG_TABLE_NAME, OLD.climb_uuid, OLD.user_id);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
