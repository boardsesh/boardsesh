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
    "shared_playlist_enabled" boolean DEFAULT false NOT NULL,
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
    "published_at" text
  );

  CREATE TABLE IF NOT EXISTS "board_climb_stats" (
    "board_type" text NOT NULL,
    "climb_uuid" text NOT NULL,
    "angle" integer NOT NULL,
    "display_difficulty" double precision,
    "benchmark_difficulty" double precision,
    "ascensionist_count" bigint,
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
    "aurora_sync_error" text
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
    "board_user_id" integer NOT NULL,
    "board_username" text,
    "linked_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "unique_user_board_mapping" ON "user_board_mappings" ("user_id", "board_type");
  CREATE INDEX IF NOT EXISTS "board_user_mapping_idx" ON "user_board_mappings" ("board_type", "board_user_id");

  -- Board history (per-physical-board send log; phase 2 of the shared queue plan).
  DROP TABLE IF EXISTS "board_climb_history" CASCADE;
  DROP TABLE IF EXISTS "board_history_sequences" CASCADE;
  DROP TABLE IF EXISTS "user_board_serials" CASCADE;
  DROP TABLE IF EXISTS "user_boards" CASCADE;

  CREATE TABLE IF NOT EXISTS "user_boards" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "uuid" text UNIQUE NOT NULL,
    "owner_id" text REFERENCES "users"("id") ON DELETE SET NULL,
    "name" text,
    "slug" text,
    "is_owned" boolean DEFAULT true,
    "deleted_at" timestamp,
    "created_at" timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE IF NOT EXISTS "user_board_serials" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "serial_number" text NOT NULL,
    "board_name" text NOT NULL,
    "layout_id" bigint NOT NULL,
    "size_id" bigint NOT NULL,
    "set_ids" text NOT NULL,
    "board_uuid" text REFERENCES "user_boards"("uuid") ON DELETE SET NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "user_board_serials_unique_user_serial" ON "user_board_serials" ("user_id", "serial_number");
  CREATE INDEX IF NOT EXISTS "user_board_serials_serial_idx" ON "user_board_serials" ("serial_number");

  DO $$ BEGIN
    CREATE TYPE board_history_source AS ENUM ('ble_send', 'manual', 'shared_queue_relay');
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$;

  CREATE TABLE IF NOT EXISTS "board_history_sequences" (
    "board_serial" text PRIMARY KEY,
    "last_sequence" bigint NOT NULL
  );

  CREATE TABLE IF NOT EXISTS "board_climb_history" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "uuid" text UNIQUE NOT NULL,
    "board_serial" text NOT NULL,
    "board_id" bigint REFERENCES "user_boards"("id") ON DELETE SET NULL,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "climb_uuid" text NOT NULL,
    "board_type" text NOT NULL,
    "layout_id" bigint NOT NULL,
    "angle" integer NOT NULL,
    "is_mirror" boolean DEFAULT false NOT NULL,
    "frames" text,
    "source" board_history_source NOT NULL,
    "session_id" text REFERENCES "board_sessions"("id") ON DELETE SET NULL,
    "shared_playlist_mode" boolean DEFAULT false NOT NULL,
    "tick_id" bigint REFERENCES "boardsesh_ticks"("id") ON DELETE SET NULL,
    "sequence" bigint NOT NULL,
    "sent_at" timestamp with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "board_climb_history_serial_sequence_unique" ON "board_climb_history" ("board_serial", "sequence");
  CREATE INDEX IF NOT EXISTS "board_climb_history_serial_sent_at_idx" ON "board_climb_history" ("board_serial", "sent_at" DESC);
  CREATE INDEX IF NOT EXISTS "board_climb_history_serial_sequence_idx" ON "board_climb_history" ("board_serial", "sequence" DESC);

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
`;
