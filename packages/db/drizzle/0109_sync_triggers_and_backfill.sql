-- Phase 2 offline sync: updated_at maintenance + deletion log triggers.
--
-- Mirrors the hand-written trigger/function precedent in 0053_add_vote_counts.sql.
-- Companion column migration 0108 already added:
--   - updated_at to user_favorites, user_follows, setter_follows, playlist_follows,
--     user_playlist_pins, playlist_climbs, board_climbs, board_climb_stats
--   - sync_seq (bigserial) to board_climbs, board_climb_stats
--   - the sync_deletions table
--
-- This migration adds the behaviour:
--   1. A shared set_updated_at() BEFORE UPDATE trigger so every writer (incl. raw
--      SQL stat recompute) bumps updated_at transparently.
--   2. Backfills of updated_at for existing rows.
--   3. Per-table AFTER DELETE triggers that append the row's NATURAL key to
--      sync_deletions, encoded EXACTLY per docs/sync-table-manifest.md "Del:" lines.

-- ============================================================================
-- 1. Shared updated_at trigger
-- ============================================================================

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER trg_user_favorites_set_updated_at BEFORE UPDATE ON user_favorites
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_user_follows_set_updated_at BEFORE UPDATE ON user_follows
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_setter_follows_set_updated_at BEFORE UPDATE ON setter_follows
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_playlist_follows_set_updated_at BEFORE UPDATE ON playlist_follows
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_user_playlist_pins_set_updated_at BEFORE UPDATE ON user_playlist_pins
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_playlist_climbs_set_updated_at BEFORE UPDATE ON playlist_climbs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_board_climbs_set_updated_at BEFORE UPDATE ON board_climbs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_board_climb_stats_set_updated_at BEFORE UPDATE ON board_climb_stats
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- 2. Backfill updated_at for existing rows (small user-data tables only).
--    created_at for favorites/follows/pins; added_at for playlist_climbs.
--    The board tables' updated_at is backfilled inside 0108's BATCHED loop —
--    deliberately NOT re-done here, so this migration never issues an unbatched
--    full-table UPDATE that would rewrite the 200k–1M-row board catalog under a
--    long lock (the exact prod-deploy hazard 0108 was reworked to avoid).
-- ============================================================================

UPDATE user_favorites     SET updated_at = created_at;
--> statement-breakpoint
UPDATE user_follows       SET updated_at = created_at;
--> statement-breakpoint
UPDATE setter_follows     SET updated_at = created_at;
--> statement-breakpoint
UPDATE playlist_follows   SET updated_at = created_at;
--> statement-breakpoint
UPDATE user_playlist_pins SET updated_at = created_at;
--> statement-breakpoint
UPDATE playlist_climbs    SET updated_at = added_at;
--> statement-breakpoint

-- ============================================================================
-- 3. Deletion-log triggers. record_id is the NATURAL key (matches the mobile
--    local PK), NOT the server bigserial id. user_id scopes user data; NULL for
--    reference data. Encodings per docs/sync-table-manifest.md per-table "Del:".
-- ============================================================================

-- boardsesh_ticks -> record_id = uuid (1 seg), user_id = OLD.user_id
CREATE OR REPLACE FUNCTION log_deletion_ticks() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  VALUES (TG_TABLE_NAME, OLD.uuid, OLD.user_id);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_ticks_delete AFTER DELETE ON boardsesh_ticks
  FOR EACH ROW EXECUTE FUNCTION log_deletion_ticks();
--> statement-breakpoint

-- playlists -> record_id = uuid (1 seg). Owner resolved from playlist_ownership.
-- BEFORE DELETE (not AFTER): playlist_ownership FK-cascades on this same delete, so
-- by AFTER time the ownership row may already be gone and owner_id would resolve NULL,
-- logging the tombstone as user_id=NULL (reference data visible to every user). At
-- BEFORE time the cascade has not run yet, so the owner is captured reliably.
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
CREATE TRIGGER trg_playlists_delete BEFORE DELETE ON playlists
  FOR EACH ROW EXECUTE FUNCTION log_deletion_playlists();
--> statement-breakpoint

-- playlist_climbs -> record_id = <playlist_uuid>:<climb_uuid> (2 segs).
-- playlist_uuid + owner looked up from the parent playlist / its ownership.
-- When a playlist is deleted, FK cascade deletes its playlist_climbs and fires this
-- trigger per row, by which point the parent playlists row is gone, so the uuid
-- lookup returns NULL. We MUST skip the insert in that case: `NULL || ':' || x` is
-- NULL, and sync_deletions.record_id is NOT NULL, so inserting would raise and abort
-- the entire playlist delete. Skipping is correct — the playlist-level tombstone
-- already tells the client to drop the whole playlist and its climbs. Direct
-- removeClimbFromPlaylist (parent still present) resolves and logs normally.
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
CREATE TRIGGER trg_playlist_climbs_delete AFTER DELETE ON playlist_climbs
  FOR EACH ROW EXECUTE FUNCTION log_deletion_playlist_climbs();
--> statement-breakpoint

-- user_favorites -> record_id = <board_name>:<climb_uuid>:<angle> (3 segs),
-- user_id = OLD.user_id.
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
CREATE TRIGGER trg_favorites_delete AFTER DELETE ON user_favorites
  FOR EACH ROW EXECUTE FUNCTION log_deletion_favorites();
--> statement-breakpoint

-- user_follows -> record_id = following_id (1 seg), user_id = OLD.follower_id.
CREATE OR REPLACE FUNCTION log_deletion_user_follows() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  VALUES (TG_TABLE_NAME, OLD.following_id, OLD.follower_id);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_user_follows_delete AFTER DELETE ON user_follows
  FOR EACH ROW EXECUTE FUNCTION log_deletion_user_follows();
--> statement-breakpoint

-- setter_follows -> record_id = setter_username (1 seg), user_id = OLD.follower_id.
CREATE OR REPLACE FUNCTION log_deletion_setter_follows() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  VALUES (TG_TABLE_NAME, OLD.setter_username, OLD.follower_id);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_setter_follows_delete AFTER DELETE ON setter_follows
  FOR EACH ROW EXECUTE FUNCTION log_deletion_setter_follows();
--> statement-breakpoint

-- playlist_follows -> record_id = playlist_uuid (1 seg), user_id = OLD.follower_id.
CREATE OR REPLACE FUNCTION log_deletion_playlist_follows() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  VALUES (TG_TABLE_NAME, OLD.playlist_uuid, OLD.follower_id);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_playlist_follows_delete AFTER DELETE ON playlist_follows
  FOR EACH ROW EXECUTE FUNCTION log_deletion_playlist_follows();
--> statement-breakpoint

-- board_climbs -> record_id = uuid (1 seg), user_id = NULL (reference data).
CREATE OR REPLACE FUNCTION log_deletion_board_climbs() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  VALUES (TG_TABLE_NAME, OLD.uuid, NULL);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_board_climbs_delete AFTER DELETE ON board_climbs
  FOR EACH ROW EXECUTE FUNCTION log_deletion_board_climbs();
--> statement-breakpoint

-- board_climb_stats -> record_id = <board_type>:<climb_uuid>:<angle> (3 segs),
-- user_id = NULL (reference data).
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
CREATE TRIGGER trg_board_climb_stats_delete AFTER DELETE ON board_climb_stats
  FOR EACH ROW EXECUTE FUNCTION log_deletion_board_climb_stats();