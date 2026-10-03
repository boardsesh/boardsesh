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
--   3. archive the losing rows into user_favorites_dedup_backup_0194, then
--      delete them (reversible, in-database — no pg_dump-and-pray),
--   4. re-enable the trigger, create the new indexes,
--   5. retain composite tombstones for old apps, including archived variants
--      when the surviving favorite is eventually removed.
--
-- board_name / angle are kept as vestigial defaulted columns for one release:
-- syncFavorites still emits them, and a pre-OTA device's local SQLite declares
-- them NOT NULL. They get dropped in the follow-up release.
--
-- Keep the legacy index for the transition, tracked in the Drizzle schema.
-- It does not protect old targeted writers against the new UUID constraint.
-- Deploy the compatibility backend from docs/favorites-rollout.md completely
-- BEFORE applying this migration; it uses untargeted conflict handling.
DROP INDEX "unique_user_favorite";--> statement-breakpoint
DROP INDEX "user_favorites_climb_idx";--> statement-breakpoint
ALTER TABLE "user_favorites" ALTER COLUMN "board_name" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "user_favorites" ALTER COLUMN "angle" SET DEFAULT 0;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_favorites_dedup_backup_0194" (
	"id" bigint PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"board_name" text NOT NULL,
	"climb_uuid" text NOT NULL,
	"angle" integer NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);--> statement-breakpoint
CREATE INDEX "user_favorites_dedup_backup_0194_user_climb_idx" ON "user_favorites_dedup_backup_0194" ("user_id", "climb_uuid");--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_favorites_delete' AND tgrelid = 'user_favorites'::regclass
  ) THEN
    EXECUTE 'ALTER TABLE user_favorites DISABLE TRIGGER trg_favorites_delete';
  END IF;
END $$;--> statement-breakpoint
INSERT INTO "user_favorites_dedup_backup_0194" ("id", "user_id", "board_name", "climb_uuid", "angle", "created_at", "updated_at")
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
USING "user_favorites_dedup_backup_0194" backup
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
CREATE UNIQUE INDEX "unique_user_favorite_legacy" ON "user_favorites" USING btree ("user_id","board_name","climb_uuid","angle");--> statement-breakpoint
CREATE INDEX "user_favorites_climb_idx" ON "user_favorites" USING btree ("climb_uuid");--> statement-breakpoint
CREATE OR REPLACE FUNCTION log_deletion_favorites() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  SELECT TG_TABLE_NAME, variants.board_name || ':' || OLD.climb_uuid || ':' || variants.angle::text, OLD.user_id
  FROM (
    SELECT OLD.board_name AS board_name, OLD.angle AS angle
    UNION
    SELECT backup.board_name, backup.angle
    FROM user_favorites_dedup_backup_0194 backup
    WHERE backup.user_id = OLD.user_id AND backup.climb_uuid = OLD.climb_uuid
  ) variants;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_catalog;
