/**
 * Shared schema DDL for backend tests. Consumed by globalSetup (to build the
 * template DB) and by worker-db (to hydrate newly-minted per-worker DBs).
 */

export const schemaSQL = `
  DROP TABLE IF EXISTS "board_session_queues" CASCADE;
  DROP TABLE IF EXISTS "board_session_clients" CASCADE;
  DROP TABLE IF EXISTS "session_health_kit_workouts" CASCADE;
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
    "timezone" text,
    "is_permanent" boolean DEFAULT false NOT NULL,
    "color" text,
    CONSTRAINT "board_sessions_status_check" CHECK (status IN ('active', 'inactive', 'ended'))
  );

  CREATE TABLE IF NOT EXISTS "session_health_kit_workouts" (
    "session_id" text NOT NULL REFERENCES "board_sessions"("id") ON DELETE CASCADE,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "workout_id" text NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY ("session_id", "user_id")
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
  CREATE INDEX IF NOT EXISTS "session_health_kit_workouts_session_idx" ON "session_health_kit_workouts" ("session_id");
  CREATE INDEX IF NOT EXISTS "session_health_kit_workouts_user_idx" ON "session_health_kit_workouts" ("user_id");
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
    "characteristics" text[]
  );

  CREATE INDEX IF NOT EXISTS "board_climbs_hold_fingerprint_idx" ON "board_climbs" ("board_type", "layout_id", "hold_fingerprint");
  CREATE INDEX IF NOT EXISTS "board_climbs_characteristics_idx" ON "board_climbs" USING gin ("characteristics");

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
    PRIMARY KEY ("board_type", "climb_uuid", "angle")
  );

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

  -- user-data-export resolver joins these (playlists/favorites). Minimal DDL
  -- covering only the columns the export queries read.
  DROP TABLE IF EXISTS "playlist_climbs" CASCADE;
  DROP TABLE IF EXISTS "playlist_ownership" CASCADE;
  DROP TABLE IF EXISTS "playlists" CASCADE;
  DROP TABLE IF EXISTS "user_favorites" CASCADE;

  CREATE TABLE IF NOT EXISTS "playlists" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "uuid" text NOT NULL,
    "board_type" text NOT NULL,
    "layout_id" integer,
    "name" text NOT NULL,
    "description" text,
    "is_public" boolean DEFAULT false NOT NULL,
    "color" text,
    "icon" text,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE IF NOT EXISTS "playlist_ownership" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "playlist_id" bigint NOT NULL REFERENCES "playlists"("id") ON DELETE CASCADE,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "role" text DEFAULT 'owner' NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE IF NOT EXISTS "playlist_climbs" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "playlist_id" bigint NOT NULL REFERENCES "playlists"("id") ON DELETE CASCADE,
    "climb_uuid" text NOT NULL,
    "angle" integer,
    "position" integer DEFAULT 0 NOT NULL,
    "added_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE IF NOT EXISTS "user_favorites" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "board_name" text NOT NULL,
    "climb_uuid" text NOT NULL,
    "angle" integer NOT NULL DEFAULT 40,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );

  DROP TABLE IF EXISTS "user_profiles" CASCADE;
  CREATE TABLE IF NOT EXISTS "user_profiles" (
    "user_id" text PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "display_name" text,
    "avatar_url" text,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE IF NOT EXISTS "gyms" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "uuid" text NOT NULL UNIQUE,
    "name" text NOT NULL,
    "slug" text,
    "owner_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "address" text,
    "latitude" double precision,
    "longitude" double precision,
    "is_public" boolean DEFAULT true NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    "deleted_at" timestamp
  );

  DROP TABLE IF EXISTS "user_boards" CASCADE;
  CREATE TABLE IF NOT EXISTS "user_boards" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "uuid" text NOT NULL UNIQUE,
    "slug" text NOT NULL,
    "owner_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "board_type" text NOT NULL,
    "layout_id" bigint NOT NULL,
    "size_id" bigint NOT NULL,
    "set_ids" text NOT NULL,
    "name" text NOT NULL,
    "description" text,
    "location_name" text,
    "latitude" double precision,
    "longitude" double precision,
    "is_public" boolean DEFAULT true NOT NULL,
    "is_unlisted" boolean DEFAULT false NOT NULL,
    "hide_location" boolean DEFAULT false NOT NULL,
    "is_owned" boolean DEFAULT true NOT NULL,
    "angle" bigint DEFAULT 40 NOT NULL,
    "is_angle_adjustable" boolean DEFAULT true NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    "serial_number" text,
    "gym_id" bigint,
    "deleted_at" timestamp
  );
  -- Board presence: serials are not globally unique (the supplier reuses them),
  -- so a serial may map to many active boards. We only forbid one owner binding
  -- the same serial to two of their own boards; the user disambiguates the rest.
  -- Excludes the system user (seeded public catalog boards) so the location
  -- sync can mirror the upstream catalog's duplicate serials verbatim.
  CREATE UNIQUE INDEX IF NOT EXISTS "user_boards_unique_owner_serial"
    ON "user_boards" ("owner_id", "serial_number")
    WHERE "serial_number" IS NOT NULL AND "serial_number" <> '' AND "deleted_at" IS NULL AND "owner_id" != '00000000-0000-0000-0000-000000000000';
  CREATE INDEX IF NOT EXISTS "user_boards_serial_idx"
    ON "user_boards" ("serial_number")
    WHERE "serial_number" IS NOT NULL AND "serial_number" <> '' AND "deleted_at" IS NULL;
  -- One active board per owner per config (mirrors the prod partial unique index).
  CREATE UNIQUE INDEX IF NOT EXISTS "user_boards_unique_owner_config"
    ON "user_boards" ("owner_id", "board_type", "layout_id", "size_id", "set_ids")
    WHERE "deleted_at" IS NULL AND "owner_id" != '00000000-0000-0000-0000-000000000000';
  CREATE UNIQUE INDEX IF NOT EXISTS "user_boards_unique_slug"
    ON "user_boards" ("slug")
    WHERE "deleted_at" IS NULL;

  -- Auto-recorded serial→config rows + the user's remembered board choice for a
  -- serial (board_uuid). Resolver reads this to skip the disambiguation prompt.
  CREATE TABLE IF NOT EXISTS "user_board_serials" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "serial_number" text NOT NULL,
    "board_name" text NOT NULL,
    "layout_id" bigint NOT NULL,
    "size_id" bigint NOT NULL,
    "set_ids" text NOT NULL,
    "api_level" integer,
    "board_uuid" text REFERENCES "user_boards"("uuid") ON DELETE SET NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "user_board_serials_unique_user_serial"
    ON "user_board_serials" ("user_id", "serial_number");
  CREATE INDEX IF NOT EXISTS "user_board_serials_serial_idx" ON "user_board_serials" ("serial_number");
  CREATE INDEX IF NOT EXISTS "user_board_serials_board_uuid_idx" ON "user_board_serials" ("board_uuid");

  -- Durable per-board send log (dwell-gated). Distinct from boardsesh_ticks: the
  -- raw wall-push stream, no flash/send/attempt status.
  CREATE TABLE IF NOT EXISTS "board_climb_events" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "board_id" bigint NOT NULL REFERENCES "user_boards"("id") ON DELETE CASCADE,
    "board_type" text NOT NULL,
    "climb_uuid" text NOT NULL,
    "angle" integer NOT NULL,
    "user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
    "session_id" text REFERENCES "board_sessions"("id") ON DELETE SET NULL,
    "seq" bigint NOT NULL,
    "frames" text,
    "name" text,
    "grade" text,
    "setter" text,
    "confirmed_at" timestamp NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE INDEX IF NOT EXISTS "board_climb_events_board_confirmed_at_idx" ON "board_climb_events" ("board_id", "confirmed_at");
  CREATE UNIQUE INDEX IF NOT EXISTS "board_climb_events_board_seq_unique" ON "board_climb_events" ("board_id", "seq");
  CREATE INDEX IF NOT EXISTS "board_climb_events_session_idx" ON "board_climb_events" ("session_id");
  CREATE INDEX IF NOT EXISTS "board_climb_events_board_climb_idx" ON "board_climb_events" ("board_id", "climb_uuid");

  DROP TABLE IF EXISTS "integration_exports" CASCADE;
  DROP TABLE IF EXISTS "integration_credentials" CASCADE;

  CREATE TABLE IF NOT EXISTS "integration_credentials" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "provider" text NOT NULL,
    "encrypted_access_token" text,
    "encrypted_refresh_token" text,
    "token_expires_at" timestamp,
    "external_account_id" text,
    "external_account_name" text,
    "scopes" text,
    "auto_sync_enabled" boolean DEFAULT true NOT NULL,
    "status" text DEFAULT 'active' NOT NULL,
    "last_error" text,
    "last_sync_at" timestamp,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "unique_user_integration" ON "integration_credentials" ("user_id","provider");

  CREATE TABLE IF NOT EXISTS "integration_exports" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "provider" text NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "session_type" text NOT NULL,
    "session_id" text NOT NULL,
    "external_activity_id" text,
    "status" text NOT NULL,
    "error" text,
    "synced_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "unique_integration_export" ON "integration_exports" ("provider","user_id","session_type","session_id");

  -- Social tables the session-grouped feed LEFT-joins for vote/comment counts.
  -- entity_type is a text column here (the real schema uses an enum); the feed
  -- only does string-equality filters on it, so text is behavior-equivalent.
  DROP TABLE IF EXISTS "vote_counts" CASCADE;
  CREATE TABLE IF NOT EXISTS "vote_counts" (
    "entity_type" text NOT NULL,
    "entity_id" text NOT NULL,
    "upvotes" integer DEFAULT 0 NOT NULL,
    "downvotes" integer DEFAULT 0 NOT NULL,
    "score" integer DEFAULT 0 NOT NULL,
    "hot_score" double precision DEFAULT 0 NOT NULL,
    "created_at" timestamp NOT NULL,
    PRIMARY KEY ("entity_type", "entity_id")
  );

  DROP TABLE IF EXISTS "comments" CASCADE;
  CREATE TABLE IF NOT EXISTS "comments" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "uuid" text NOT NULL UNIQUE,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "entity_type" text NOT NULL,
    "entity_id" text NOT NULL,
    "parent_comment_id" bigint,
    "body" text NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    "deleted_at" timestamp
  );
  CREATE INDEX IF NOT EXISTS "comments_entity_created_at_idx" ON "comments" ("entity_type", "entity_id", "created_at");

  -- Beta links the session feed INNER-joins for featured-beta enrichment. Empty
  -- in tests (no featured beta), but the relation must exist so the query plans.
  DROP TABLE IF EXISTS "board_beta_links" CASCADE;
  CREATE TABLE IF NOT EXISTS "board_beta_links" (
    "board_type" text NOT NULL,
    "climb_uuid" text NOT NULL,
    "link" text NOT NULL,
    "foreign_username" text,
    "angle" integer,
    "thumbnail" text,
    "is_listed" boolean,
    "created_at" text,
    "shortcode" text,
    "created_by_user_id" text,
    "tick_uuid" text,
    "board_id" bigint,
    "video_identity" text
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "board_beta_links_video_identity_unique" ON "board_beta_links" ("video_identity") WHERE "video_identity" IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS "board_beta_links_tick_uuid_unique" ON "board_beta_links" ("tick_uuid") WHERE "tick_uuid" IS NOT NULL;
  CREATE INDEX IF NOT EXISTS "board_beta_links_board_id_idx" ON "board_beta_links" ("board_id") WHERE "board_id" IS NOT NULL;
`;
