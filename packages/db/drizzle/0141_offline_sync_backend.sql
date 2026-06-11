-- Offline sync backend contract.
--
-- Drizzle generated the correct end-state for these columns/indexes, but the
-- board catalog tables are large enough that adding NOT NULL columns with
-- volatile defaults would rewrite too much data under an exclusive lock. Keep
-- the generated snapshot, but reach the same schema through nullable adds,
-- explicit sequences, batched backfills, and final NOT NULL/default changes.

CREATE TABLE "sync_deletions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"record_id" text NOT NULL,
	"user_id" text,
	"deleted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- board_climb_stats.updated_at / sync_seq ------------------------------------
ALTER TABLE "board_climb_stats" ADD COLUMN "updated_at" timestamp;
--> statement-breakpoint
ALTER TABLE "board_climb_stats" ADD COLUMN "sync_seq" bigint;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "board_climb_stats_sync_seq_seq" AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 NO MAXVALUE CACHE 1;
--> statement-breakpoint
ALTER SEQUENCE "board_climb_stats_sync_seq_seq" OWNED BY "board_climb_stats"."sync_seq";
--> statement-breakpoint
ALTER TABLE "board_climb_stats" ALTER COLUMN "sync_seq" SET DEFAULT nextval('board_climb_stats_sync_seq_seq');
--> statement-breakpoint
DO $$
DECLARE
  updated_rows integer;
BEGIN
  LOOP
    UPDATE "board_climb_stats" AS stats
    SET "sync_seq" = nextval('board_climb_stats_sync_seq_seq'),
        "updated_at" = now()
    FROM (
      SELECT "board_type", "climb_uuid", "angle"
      FROM "board_climb_stats"
      WHERE "sync_seq" IS NULL
      LIMIT 10000
      FOR UPDATE SKIP LOCKED
    ) AS batch
    WHERE stats."board_type" = batch."board_type"
      AND stats."climb_uuid" = batch."climb_uuid"
      AND stats."angle" = batch."angle";
    GET DIAGNOSTICS updated_rows = ROW_COUNT;
    EXIT WHEN updated_rows = 0;
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "board_climb_stats" ALTER COLUMN "updated_at" SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE "board_climb_stats" ALTER COLUMN "updated_at" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "board_climb_stats" ALTER COLUMN "sync_seq" SET NOT NULL;
--> statement-breakpoint

-- board_climbs.updated_at / sync_seq -----------------------------------------
ALTER TABLE "board_climbs" ADD COLUMN "updated_at" timestamp;
--> statement-breakpoint
ALTER TABLE "board_climbs" ADD COLUMN "sync_seq" bigint;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "board_climbs_sync_seq_seq" AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 NO MAXVALUE CACHE 1;
--> statement-breakpoint
ALTER SEQUENCE "board_climbs_sync_seq_seq" OWNED BY "board_climbs"."sync_seq";
--> statement-breakpoint
ALTER TABLE "board_climbs" ALTER COLUMN "sync_seq" SET DEFAULT nextval('board_climbs_sync_seq_seq');
--> statement-breakpoint
DO $$
DECLARE
  updated_rows integer;
BEGIN
  LOOP
    UPDATE "board_climbs"
    SET "sync_seq" = nextval('board_climbs_sync_seq_seq'),
        "updated_at" = now()
    WHERE "uuid" IN (
      SELECT "uuid"
      FROM "board_climbs"
      WHERE "sync_seq" IS NULL
      LIMIT 10000
      FOR UPDATE SKIP LOCKED
    );
    GET DIAGNOSTICS updated_rows = ROW_COUNT;
    EXIT WHEN updated_rows = 0;
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "board_climbs" ALTER COLUMN "updated_at" SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE "board_climbs" ALTER COLUMN "updated_at" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "board_climbs" ALTER COLUMN "sync_seq" SET NOT NULL;
--> statement-breakpoint

-- Smaller user-owned tables can be backfilled directly from their existing
-- creation timestamps. Avoid DEFAULT now() on add so the values preserve the
-- original order for first sync pulls.
ALTER TABLE "user_favorites" ADD COLUMN "updated_at" timestamp;
--> statement-breakpoint
UPDATE "user_favorites" SET "updated_at" = "created_at";
--> statement-breakpoint
ALTER TABLE "user_favorites" ALTER COLUMN "updated_at" SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE "user_favorites" ALTER COLUMN "updated_at" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "playlist_climbs" ADD COLUMN "updated_at" timestamp;
--> statement-breakpoint
UPDATE "playlist_climbs" SET "updated_at" = "added_at";
--> statement-breakpoint
ALTER TABLE "playlist_climbs" ALTER COLUMN "updated_at" SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE "playlist_climbs" ALTER COLUMN "updated_at" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "user_playlist_pins" ADD COLUMN "updated_at" timestamp;
--> statement-breakpoint
UPDATE "user_playlist_pins" SET "updated_at" = "created_at";
--> statement-breakpoint
ALTER TABLE "user_playlist_pins" ALTER COLUMN "updated_at" SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE "user_playlist_pins" ALTER COLUMN "updated_at" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "playlist_follows" ADD COLUMN "updated_at" timestamp;
--> statement-breakpoint
UPDATE "playlist_follows" SET "updated_at" = "created_at";
--> statement-breakpoint
ALTER TABLE "playlist_follows" ALTER COLUMN "updated_at" SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE "playlist_follows" ALTER COLUMN "updated_at" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "setter_follows" ADD COLUMN "updated_at" timestamp;
--> statement-breakpoint
UPDATE "setter_follows" SET "updated_at" = "created_at";
--> statement-breakpoint
ALTER TABLE "setter_follows" ALTER COLUMN "updated_at" SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE "setter_follows" ALTER COLUMN "updated_at" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "user_follows" ADD COLUMN "updated_at" timestamp;
--> statement-breakpoint
UPDATE "user_follows" SET "updated_at" = "created_at";
--> statement-breakpoint
ALTER TABLE "user_follows" ALTER COLUMN "updated_at" SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE "user_follows" ALTER COLUMN "updated_at" SET NOT NULL;
--> statement-breakpoint

-- Cursor indexes. Drizzle's migrator wraps migrations in a transaction, so
-- CREATE INDEX CONCURRENTLY is not available here. These are simple btree
-- indexes; production table sizes are modest enough for the standard path.
CREATE INDEX "sync_deletions_user_since_idx" ON "sync_deletions" USING btree ("user_id","deleted_at","id");
--> statement-breakpoint
CREATE INDEX "board_climb_stats_sync_cursor_idx" ON "board_climb_stats" USING btree ("updated_at","sync_seq");
--> statement-breakpoint
CREATE INDEX "board_climbs_sync_cursor_idx" ON "board_climbs" USING btree ("updated_at","sync_seq");
--> statement-breakpoint
CREATE INDEX "user_favorites_sync_cursor_idx" ON "user_favorites" USING btree ("user_id","updated_at","id");
--> statement-breakpoint
CREATE INDEX "playlist_climbs_sync_cursor_idx" ON "playlist_climbs" USING btree ("updated_at","id");
--> statement-breakpoint
CREATE INDEX "playlists_sync_cursor_idx" ON "playlists" USING btree ("updated_at","id");
--> statement-breakpoint
CREATE INDEX "playlist_follows_sync_cursor_idx" ON "playlist_follows" USING btree ("follower_id","updated_at","id");
--> statement-breakpoint
CREATE INDEX "setter_follows_sync_cursor_idx" ON "setter_follows" USING btree ("follower_id","updated_at","id");
--> statement-breakpoint
CREATE INDEX "user_follows_sync_cursor_idx" ON "user_follows" USING btree ("follower_id","updated_at","id");
--> statement-breakpoint

-- Updated-at maintenance for sync-owned tables. Do not attach this to playlists:
-- updatePlaylist sets updated_at explicitly, while updatePlaylistLastAccessedAt
-- intentionally updates only last_accessed_at.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER trg_user_favorites_set_updated_at BEFORE UPDATE ON "user_favorites"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_user_follows_set_updated_at BEFORE UPDATE ON "user_follows"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_setter_follows_set_updated_at BEFORE UPDATE ON "setter_follows"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_playlist_follows_set_updated_at BEFORE UPDATE ON "playlist_follows"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_user_playlist_pins_set_updated_at BEFORE UPDATE ON "user_playlist_pins"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_playlist_climbs_set_updated_at BEFORE UPDATE ON "playlist_climbs"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION set_board_climbs_sync_fields() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  NEW.sync_seq = nextval('board_climbs_sync_seq_seq');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_board_climbs_set_sync_fields BEFORE UPDATE ON "board_climbs"
  FOR EACH ROW EXECUTE FUNCTION set_board_climbs_sync_fields();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION set_board_climb_stats_sync_fields() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  NEW.sync_seq = nextval('board_climb_stats_sync_seq_seq');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_board_climb_stats_set_sync_fields BEFORE UPDATE ON "board_climb_stats"
  FOR EACH ROW EXECUTE FUNCTION set_board_climb_stats_sync_fields();
--> statement-breakpoint

-- Deletion tombstones. record_id is the mobile natural key, not the server
-- bigserial id. user_id scopes private rows; NULL marks board reference data.
CREATE OR REPLACE FUNCTION log_deletion_ticks() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  VALUES (TG_TABLE_NAME, OLD.uuid, OLD.user_id);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_ticks_delete AFTER DELETE ON "boardsesh_ticks"
  FOR EACH ROW EXECUTE FUNCTION log_deletion_ticks();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION log_deletion_playlists() RETURNS TRIGGER AS $$
DECLARE
  owner_id text;
BEGIN
  SELECT po.user_id INTO owner_id
  FROM playlist_ownership po
  WHERE po.playlist_id = OLD.id AND po.role = 'owner'
  LIMIT 1;
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  VALUES (TG_TABLE_NAME, OLD.uuid, owner_id);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_playlists_delete BEFORE DELETE ON "playlists"
  FOR EACH ROW EXECUTE FUNCTION log_deletion_playlists();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION log_deletion_playlist_climbs() RETURNS TRIGGER AS $$
DECLARE
  v_playlist_uuid text;
  owner_id text;
BEGIN
  SELECT p.uuid INTO v_playlist_uuid
  FROM playlists p
  WHERE p.id = OLD.playlist_id
  LIMIT 1;
  IF v_playlist_uuid IS NULL THEN
    RETURN OLD;
  END IF;

  SELECT po.user_id INTO owner_id
  FROM playlist_ownership po
  WHERE po.playlist_id = OLD.playlist_id AND po.role = 'owner'
  LIMIT 1;

  INSERT INTO sync_deletions (table_name, record_id, user_id)
  VALUES (TG_TABLE_NAME, v_playlist_uuid || ':' || OLD.climb_uuid, owner_id);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_playlist_climbs_delete AFTER DELETE ON "playlist_climbs"
  FOR EACH ROW EXECUTE FUNCTION log_deletion_playlist_climbs();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION log_deletion_favorites() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  VALUES (TG_TABLE_NAME,
          OLD.board_name || ':' || OLD.climb_uuid || ':' || OLD.angle::text,
          OLD.user_id);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_favorites_delete AFTER DELETE ON "user_favorites"
  FOR EACH ROW EXECUTE FUNCTION log_deletion_favorites();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION log_deletion_user_follows() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  VALUES (TG_TABLE_NAME, OLD.following_id, OLD.follower_id);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_user_follows_delete AFTER DELETE ON "user_follows"
  FOR EACH ROW EXECUTE FUNCTION log_deletion_user_follows();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION log_deletion_setter_follows() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  VALUES (TG_TABLE_NAME, OLD.setter_username, OLD.follower_id);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_setter_follows_delete AFTER DELETE ON "setter_follows"
  FOR EACH ROW EXECUTE FUNCTION log_deletion_setter_follows();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION log_deletion_playlist_follows() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  VALUES (TG_TABLE_NAME, OLD.playlist_uuid, OLD.follower_id);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_playlist_follows_delete AFTER DELETE ON "playlist_follows"
  FOR EACH ROW EXECUTE FUNCTION log_deletion_playlist_follows();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION log_deletion_board_climbs() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  VALUES (TG_TABLE_NAME, OLD.uuid, NULL);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_board_climbs_delete AFTER DELETE ON "board_climbs"
  FOR EACH ROW EXECUTE FUNCTION log_deletion_board_climbs();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION log_deletion_board_climb_stats() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  VALUES (TG_TABLE_NAME,
          OLD.board_type || ':' || OLD.climb_uuid || ':' || OLD.angle::text,
          NULL);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_board_climb_stats_delete AFTER DELETE ON "board_climb_stats"
  FOR EACH ROW EXECUTE FUNCTION log_deletion_board_climb_stats();

--> statement-breakpoint
CREATE INDEX "boardsesh_ticks_sync_cursor_idx" ON "boardsesh_ticks" USING btree ("user_id","updated_at","id");
