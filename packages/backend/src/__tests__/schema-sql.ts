/**
 * Shared schema DDL for backend tests. Consumed by globalSetup (to build the
 * template DB) and by worker-db (to hydrate newly-minted per-worker DBs).
 */

export const schemaSQL = `
  DROP TABLE IF EXISTS "board_session_queues" CASCADE;
  DROP TABLE IF EXISTS "board_session_clients" CASCADE;
  DROP TABLE IF EXISTS "board_session_participants" CASCADE;
  DROP TABLE IF EXISTS "board_sessions" CASCADE;
  DROP TABLE IF EXISTS "user_climb_percentiles" CASCADE;
  DROP TABLE IF EXISTS "users" CASCADE;

  CREATE TABLE IF NOT EXISTS "users" (
    "id" text PRIMARY KEY NOT NULL,
    "name" text,
    "email" text NOT NULL,
    "emailVerified" timestamp,
    "image" text,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE IF NOT EXISTS "user_climb_percentiles" (
    "user_id" text PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "total_distinct_climbs" integer DEFAULT 0 NOT NULL,
    "percentile" double precision DEFAULT 0 NOT NULL,
    "total_active_users" integer DEFAULT 0 NOT NULL,
    "computed_at" timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE IF NOT EXISTS "board_sessions" (
    "id" text PRIMARY KEY NOT NULL,
    "board_path" text NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "last_activity" timestamp DEFAULT now() NOT NULL,
    "status" text DEFAULT 'active' NOT NULL,
    "latitude" double precision,
    "longitude" double precision,
    "discoverable" boolean DEFAULT false NOT NULL,
    "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
    "name" text,
    "board_id" bigint,
    "goal" text,
    "is_public" boolean DEFAULT true NOT NULL,
    "started_at" timestamp,
    "ended_at" timestamp,
    "is_permanent" boolean DEFAULT false NOT NULL,
    "color" text,
    "health_kit_workout_id" text,
    CONSTRAINT "board_sessions_status_check" CHECK (status IN ('active', 'inactive', 'ended'))
  );

  CREATE TABLE IF NOT EXISTS "board_session_participants" (
    "session_id" text NOT NULL REFERENCES "board_sessions"("id") ON DELETE CASCADE,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "joined_at" timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY ("session_id", "user_id")
  );

  CREATE TABLE IF NOT EXISTS "board_session_clients" (
    "id" text PRIMARY KEY NOT NULL,
    "session_id" text NOT NULL REFERENCES "board_sessions"("id") ON DELETE CASCADE,
    "username" text,
    "connected_at" timestamp DEFAULT now() NOT NULL,
    "is_leader" boolean DEFAULT false NOT NULL
  );

  CREATE TABLE IF NOT EXISTS "board_session_queues" (
    "session_id" text PRIMARY KEY NOT NULL REFERENCES "board_sessions"("id") ON DELETE CASCADE,
    "queue" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "current_climb_queue_item" jsonb DEFAULT 'null'::jsonb,
    "version" integer DEFAULT 1 NOT NULL,
    "sequence" integer DEFAULT 0 NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );

  DROP TABLE IF EXISTS "activity_push_tokens" CASCADE;
  CREATE TABLE IF NOT EXISTS "activity_push_tokens" (
    "token" text PRIMARY KEY NOT NULL,
    "session_id" text NOT NULL REFERENCES "board_sessions"("id") ON DELETE CASCADE,
    "user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE INDEX IF NOT EXISTS "activity_push_tokens_session_idx" ON "activity_push_tokens" ("session_id");
  CREATE INDEX IF NOT EXISTS "activity_push_tokens_user_idx" ON "activity_push_tokens" ("user_id");
  CREATE INDEX IF NOT EXISTS "activity_push_tokens_updated_at_idx" ON "activity_push_tokens" ("updated_at");

  DROP TABLE IF EXISTS "mobile_refresh_tokens" CASCADE;
  CREATE TABLE IF NOT EXISTS "mobile_refresh_tokens" (
    "id" text PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "token_hash" text NOT NULL,
    "expires_at" timestamp NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "revoked_at" timestamp
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "mobile_refresh_tokens_token_hash_idx" ON "mobile_refresh_tokens" ("token_hash");
  CREATE INDEX IF NOT EXISTS "mobile_refresh_tokens_user_id_idx" ON "mobile_refresh_tokens" ("user_id");
  CREATE INDEX IF NOT EXISTS "mobile_refresh_tokens_expires_at_idx" ON "mobile_refresh_tokens" ("expires_at");
  CREATE INDEX IF NOT EXISTS "mobile_refresh_tokens_revoked_at_partial_idx" ON "mobile_refresh_tokens" ("revoked_at") WHERE "revoked_at" IS NOT NULL;

  CREATE INDEX IF NOT EXISTS "board_sessions_location_idx" ON "board_sessions" ("latitude", "longitude");
  CREATE INDEX IF NOT EXISTS "board_sessions_discoverable_idx" ON "board_sessions" ("discoverable");
  CREATE INDEX IF NOT EXISTS "board_sessions_user_idx" ON "board_sessions" ("created_by_user_id");
  CREATE INDEX IF NOT EXISTS "board_sessions_status_idx" ON "board_sessions" ("status");
  CREATE INDEX IF NOT EXISTS "board_sessions_last_activity_idx" ON "board_sessions" ("last_activity");
  CREATE INDEX IF NOT EXISTS "board_sessions_discovery_idx" ON "board_sessions" ("discoverable", "status", "last_activity");
  CREATE INDEX IF NOT EXISTS "board_session_participants_session_idx" ON "board_session_participants" ("session_id");
  CREATE INDEX IF NOT EXISTS "board_session_participants_user_idx" ON "board_session_participants" ("user_id");

  DROP TABLE IF EXISTS "esp32_controllers" CASCADE;
  CREATE TABLE IF NOT EXISTS "esp32_controllers" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "user_id" text REFERENCES "users"("id") ON DELETE CASCADE,
    "api_key" varchar(64) UNIQUE NOT NULL,
    "name" varchar(100),
    "board_name" varchar(20) NOT NULL,
    "layout_id" integer NOT NULL,
    "size_id" integer NOT NULL,
    "set_ids" varchar(100) NOT NULL,
    "authorized_session_id" text,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "last_seen_at" timestamp
  );

  CREATE INDEX IF NOT EXISTS "esp32_controllers_user_idx" ON "esp32_controllers" ("user_id");
  CREATE INDEX IF NOT EXISTS "esp32_controllers_api_key_idx" ON "esp32_controllers" ("api_key");
  CREATE INDEX IF NOT EXISTS "esp32_controllers_session_idx" ON "esp32_controllers" ("authorized_session_id");

  DROP TABLE IF EXISTS "board_climb_aliases" CASCADE;
  DROP TABLE IF EXISTS "board_climb_stats" CASCADE;
  DROP TABLE IF EXISTS "board_climbs" CASCADE;
  DROP TABLE IF EXISTS "board_difficulty_grades" CASCADE;

  CREATE TABLE IF NOT EXISTS "board_difficulty_grades" (
    "board_type" text NOT NULL,
    "difficulty" integer NOT NULL,
    "boulder_name" text,
    "route_name" text,
    "is_listed" boolean,
    PRIMARY KEY ("board_type", "difficulty")
  );

  CREATE TABLE IF NOT EXISTS "board_climbs" (
    "uuid" text PRIMARY KEY NOT NULL,
    "board_type" text NOT NULL,
    "layout_id" integer NOT NULL,
    "setter_id" integer,
    "setter_username" text,
    "name" text,
    "description" text DEFAULT '',
    "hsm" integer,
    "edge_left" integer,
    "edge_right" integer,
    "edge_bottom" integer,
    "edge_top" integer,
    "angle" integer,
    "frames_count" integer DEFAULT 1,
    "frames_pace" integer DEFAULT 0,
    "frames" text,
    "is_draft" boolean DEFAULT false,
    "is_listed" boolean,
    "created_at" text,
    "synced" boolean DEFAULT true NOT NULL,
    "sync_error" text,
    "user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
    "required_set_ids" integer[],
    "compatible_size_ids" integer[],
    "published_at" text,
    "hold_fingerprint" text,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    "sync_seq" bigserial NOT NULL
  );

  CREATE INDEX IF NOT EXISTS "board_climbs_hold_fingerprint_idx" ON "board_climbs" ("board_type", "layout_id", "hold_fingerprint");
  CREATE INDEX IF NOT EXISTS "board_climbs_sync_cursor_idx" ON "board_climbs" ("updated_at", "sync_seq");

  CREATE TABLE IF NOT EXISTS "board_climb_aliases" (
    "board_type" text NOT NULL,
    "alias_uuid" text NOT NULL,
    "canonical_uuid" text NOT NULL,
    "source" text NOT NULL,
    "first_seen_at" timestamp DEFAULT now() NOT NULL,
    "last_seen_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "board_climb_aliases_board_type_alias_uuid_pk" PRIMARY KEY("board_type","alias_uuid"),
    CONSTRAINT "board_climb_aliases_uuids_non_empty" CHECK ("board_climb_aliases"."alias_uuid" <> '' AND "board_climb_aliases"."canonical_uuid" <> ''),
    CONSTRAINT "board_climb_aliases_canonical_fk" FOREIGN KEY ("canonical_uuid") REFERENCES "board_climbs"("uuid") ON DELETE CASCADE ON UPDATE CASCADE
  );
  CREATE INDEX IF NOT EXISTS "board_climb_aliases_canonical_idx" ON "board_climb_aliases" ("board_type","canonical_uuid");

  CREATE TABLE IF NOT EXISTS "board_climb_stats" (
    "board_type" text NOT NULL,
    "climb_uuid" text NOT NULL,
    "angle" integer NOT NULL,
    "display_difficulty" double precision,
    "benchmark_difficulty" double precision,
    "ascensionist_count" bigint,
    "aurora_ascensionist_count" bigint,
    "kilter_ascensionist_count" bigint,
    "boardsesh_ascensionist_count" bigint,
    "difficulty_average" double precision,
    "quality_average" double precision,
    "fa_username" text,
    "fa_at" timestamp,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    "sync_seq" bigserial NOT NULL,
    PRIMARY KEY ("board_type", "climb_uuid", "angle")
  );
  CREATE INDEX IF NOT EXISTS "board_climb_stats_sync_cursor_idx" ON "board_climb_stats" ("updated_at", "sync_seq");

  DO $$ BEGIN
    CREATE TYPE tick_status AS ENUM ('flash', 'send', 'attempt');
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$;

  DO $$ BEGIN
    CREATE TYPE kilter_table_type AS ENUM ('logs', 'attempts');
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$;

  DROP TABLE IF EXISTS "boardsesh_ticks" CASCADE;
  CREATE TABLE IF NOT EXISTS "boardsesh_ticks" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "uuid" text NOT NULL UNIQUE,
    "user_id" text NOT NULL,
    "board_type" text NOT NULL,
    "climb_uuid" text NOT NULL,
    "angle" integer NOT NULL,
    "is_mirror" boolean DEFAULT false,
    "status" tick_status NOT NULL,
    "attempt_count" integer NOT NULL DEFAULT 1,
    "quality" integer,
    "difficulty" integer,
    "is_benchmark" boolean DEFAULT false,
    "comment" text DEFAULT '',
    "climbed_at" timestamp NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    "session_id" text,
    "inferred_session_id" text,
    "previous_inferred_session_id" text,
    "board_id" bigint,
    "aurora_type" text,
    "aurora_id" text,
    "aurora_synced_at" timestamp,
    "aurora_sync_error" text,
    "kilter_type" kilter_table_type,
    "kilter_id" text,
    "kilter_synced_at" timestamp,
    "kilter_sync_error" text
  );
  CREATE INDEX IF NOT EXISTS "boardsesh_ticks_sync_cursor_idx" ON "boardsesh_ticks" ("user_id", "updated_at", "id");

  DROP TABLE IF EXISTS "board_placements" CASCADE;
  CREATE TABLE IF NOT EXISTS "board_placements" (
    "board_type" text NOT NULL,
    "id" integer NOT NULL,
    "layout_id" integer,
    "hole_id" integer,
    "set_id" integer,
    "default_placement_role_id" integer,
    PRIMARY KEY ("board_type", "id")
  );

  DROP TABLE IF EXISTS "board_climb_holds" CASCADE;
  CREATE TABLE IF NOT EXISTS "board_climb_holds" (
    "board_type" text NOT NULL,
    "climb_uuid" text NOT NULL,
    "hold_id" integer NOT NULL,
    "frame_number" integer NOT NULL,
    "hold_state" text NOT NULL,
    "created_at" timestamp DEFAULT now(),
    PRIMARY KEY ("board_type", "climb_uuid", "hold_id")
  );

  DROP TABLE IF EXISTS "user_board_mappings" CASCADE;
  CREATE TABLE IF NOT EXISTS "user_board_mappings" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "board_type" text NOT NULL,
    "board_user_id" integer,
    "board_user_id_text" text,
    "board_username" text,
    "linked_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "unique_user_board_mapping" ON "user_board_mappings" ("user_id", "board_type");
  CREATE INDEX IF NOT EXISTS "board_user_mapping_idx" ON "user_board_mappings" ("board_type", "board_user_id");

  DROP TABLE IF EXISTS "inferred_sessions" CASCADE;
  CREATE TABLE IF NOT EXISTS "inferred_sessions" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "board_type" text NOT NULL,
    "started_at" timestamp NOT NULL,
    "ended_at" timestamp,
    "tick_count" integer DEFAULT 0 NOT NULL,
    "health_kit_workout_id" text,
    "created_at" timestamp DEFAULT now() NOT NULL
  );

  -- ==========================================================================
  -- Phase 2 offline sync tables + triggers (mirrors migrations 0108/0109).
  -- Integration tests don't run migrations, so the parts of the sync surface we
  -- exercise (favorites/follows/playlists CRUD, deletion log, updated_at bumps)
  -- are recreated here by hand. record_id encodings match docs/sync-table-manifest.md.
  -- ==========================================================================

  DROP TABLE IF EXISTS "user_favorites" CASCADE;
  CREATE TABLE IF NOT EXISTS "user_favorites" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "board_name" text NOT NULL,
    "climb_uuid" text NOT NULL,
    "angle" integer NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "unique_user_favorite" ON "user_favorites" ("user_id", "board_name", "climb_uuid", "angle");
  CREATE INDEX IF NOT EXISTS "user_favorites_user_idx" ON "user_favorites" ("user_id");
  CREATE INDEX IF NOT EXISTS "user_favorites_sync_cursor_idx" ON "user_favorites" ("user_id", "updated_at", "id");

  DROP TABLE IF EXISTS "user_follows" CASCADE;
  CREATE TABLE IF NOT EXISTS "user_follows" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "follower_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "following_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "unique_user_follow" ON "user_follows" ("follower_id", "following_id");
  CREATE INDEX IF NOT EXISTS "user_follows_sync_cursor_idx" ON "user_follows" ("follower_id", "updated_at", "id");

  DROP TABLE IF EXISTS "setter_follows" CASCADE;
  CREATE TABLE IF NOT EXISTS "setter_follows" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "follower_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "setter_username" text NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "unique_setter_follow" ON "setter_follows" ("follower_id", "setter_username");
  CREATE INDEX IF NOT EXISTS "setter_follows_sync_cursor_idx" ON "setter_follows" ("follower_id", "updated_at", "id");

  DROP TABLE IF EXISTS "playlist_follows" CASCADE;
  DROP TABLE IF EXISTS "playlist_climbs" CASCADE;
  DROP TABLE IF EXISTS "playlist_ownership" CASCADE;
  DROP TABLE IF EXISTS "playlists" CASCADE;
  CREATE TABLE IF NOT EXISTS "playlists" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "uuid" text NOT NULL UNIQUE,
    "board_type" text NOT NULL,
    "layout_id" integer,
    "name" text NOT NULL,
    "description" text,
    "is_public" boolean DEFAULT false NOT NULL,
    "color" text,
    "icon" text,
    "aurora_type" text,
    "aurora_id" text,
    "aurora_synced_at" timestamp,
    "kilter_type" text,
    "kilter_id" text,
    "kilter_synced_at" timestamp,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    "last_accessed_at" timestamp
  );
  CREATE INDEX IF NOT EXISTS "playlists_sync_cursor_idx" ON "playlists" ("updated_at", "id");

  CREATE TABLE IF NOT EXISTS "playlist_ownership" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "playlist_id" bigint NOT NULL REFERENCES "playlists"("id") ON DELETE CASCADE,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "role" text DEFAULT 'owner' NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "unique_playlist_ownership" ON "playlist_ownership" ("playlist_id", "user_id");

  CREATE TABLE IF NOT EXISTS "playlist_climbs" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "playlist_id" bigint NOT NULL REFERENCES "playlists"("id") ON DELETE CASCADE,
    "climb_uuid" text NOT NULL,
    "angle" integer,
    "position" integer DEFAULT 0 NOT NULL,
    "added_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "unique_playlist_climb" ON "playlist_climbs" ("playlist_id", "climb_uuid");
  CREATE INDEX IF NOT EXISTS "playlist_climbs_sync_cursor_idx" ON "playlist_climbs" ("updated_at", "id");

  CREATE TABLE IF NOT EXISTS "playlist_follows" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "follower_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "playlist_uuid" text NOT NULL REFERENCES "playlists"("uuid") ON DELETE CASCADE,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "unique_playlist_follow" ON "playlist_follows" ("follower_id", "playlist_uuid");
  CREATE INDEX IF NOT EXISTS "playlist_follows_sync_cursor_idx" ON "playlist_follows" ("follower_id", "updated_at", "id");

  DROP TABLE IF EXISTS "sync_deletions" CASCADE;
  CREATE TABLE IF NOT EXISTS "sync_deletions" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "table_name" text NOT NULL,
    "record_id" text NOT NULL,
    "user_id" text,
    "deleted_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE INDEX IF NOT EXISTS "sync_deletions_user_since_idx" ON "sync_deletions" ("user_id", "deleted_at", "id");

  -- Shared updated_at trigger (subset of tables the tests touch).
  CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $set_updated_at$
  BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
  END;
  $set_updated_at$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_user_favorites_set_updated_at ON user_favorites;
  CREATE TRIGGER trg_user_favorites_set_updated_at BEFORE UPDATE ON user_favorites
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  DROP TRIGGER IF EXISTS trg_board_climb_stats_set_updated_at ON board_climb_stats;
  CREATE TRIGGER trg_board_climb_stats_set_updated_at BEFORE UPDATE ON board_climb_stats
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

  -- Deletion-log triggers exercised by the deletion-encoding tests.
  CREATE OR REPLACE FUNCTION log_deletion_favorites() RETURNS TRIGGER AS $log_deletion_favorites$
  BEGIN
    INSERT INTO sync_deletions (table_name, record_id, user_id)
    VALUES (TG_TABLE_NAME, OLD.board_name || ':' || OLD.climb_uuid || ':' || OLD.angle::text, OLD.user_id);
    RETURN OLD;
  END;
  $log_deletion_favorites$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS trg_favorites_delete ON user_favorites;
  CREATE TRIGGER trg_favorites_delete AFTER DELETE ON user_favorites
    FOR EACH ROW EXECUTE FUNCTION log_deletion_favorites();

  CREATE OR REPLACE FUNCTION log_deletion_board_climb_stats() RETURNS TRIGGER AS $log_deletion_board_climb_stats$
  BEGIN
    INSERT INTO sync_deletions (table_name, record_id, user_id)
    VALUES (TG_TABLE_NAME, OLD.board_type || ':' || OLD.climb_uuid || ':' || OLD.angle::text, NULL);
    RETURN OLD;
  END;
  $log_deletion_board_climb_stats$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS trg_board_climb_stats_delete ON board_climb_stats;
  CREATE TRIGGER trg_board_climb_stats_delete AFTER DELETE ON board_climb_stats
    FOR EACH ROW EXECUTE FUNCTION log_deletion_board_climb_stats();

  -- playlists: BEFORE DELETE so the owner is captured before playlist_ownership cascades.
  CREATE OR REPLACE FUNCTION log_deletion_playlists() RETURNS TRIGGER AS $log_deletion_playlists$
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
  $log_deletion_playlists$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS trg_playlists_delete ON playlists;
  CREATE TRIGGER trg_playlists_delete BEFORE DELETE ON playlists
    FOR EACH ROW EXECUTE FUNCTION log_deletion_playlists();

  -- playlist_climbs: AFTER DELETE; skip when the parent playlist is already gone
  -- (whole-playlist cascade) to avoid a NULL record_id NOT NULL violation.
  CREATE OR REPLACE FUNCTION log_deletion_playlist_climbs() RETURNS TRIGGER AS $log_deletion_playlist_climbs$
  DECLARE
    v_playlist_uuid text;
    owner_id text;
  BEGIN
    SELECT p.uuid INTO v_playlist_uuid FROM playlists p WHERE p.id = OLD.playlist_id LIMIT 1;
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
  $log_deletion_playlist_climbs$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS trg_playlist_climbs_delete ON playlist_climbs;
  CREATE TRIGGER trg_playlist_climbs_delete AFTER DELETE ON playlist_climbs
    FOR EACH ROW EXECUTE FUNCTION log_deletion_playlist_climbs();
`;
