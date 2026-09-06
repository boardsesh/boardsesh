/**
 * Shared schema DDL for backend tests. Consumed by globalSetup (to build the
 * template DB) and by worker-db (to hydrate newly-minted per-worker DBs).
 */

export const schemaSQL = `
  DROP TABLE IF EXISTS "board_session_queues" CASCADE;
  DROP TABLE IF EXISTS "session_health_kit_workouts" CASCADE;
  DROP TABLE IF EXISTS "board_session_participants" CASCADE;
  DROP TABLE IF EXISTS "board_sessions" CASCADE;
  DROP TABLE IF EXISTS "user_climb_percentiles" CASCADE;
  DROP TABLE IF EXISTS "user_credentials" CASCADE;
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

  CREATE TABLE IF NOT EXISTS "user_credentials" (
    "user_id" text PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "password_hash" text NOT NULL,
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

  -- Declared here rather than with the other enums further down: board_sessions
  -- below is typed against it, and the CREATE TABLE would fail on an unknown type.
  -- The EXCEPTION guard keeps a re-apply from aborting the whole transaction.
  DO $$ BEGIN
    CREATE TYPE session_origin AS ENUM ('explicit', 'inferred');
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$;

  CREATE TABLE IF NOT EXISTS "board_sessions" (
    "id" text PRIMARY KEY NOT NULL,
    -- Nullable: inferred sessions are rebuilt from ticks that may span boards.
    "board_path" text,
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
    "notes" text,
    "is_public" boolean DEFAULT true NOT NULL,
    "started_at" timestamp,
    "ended_at" timestamp,
    "timezone" text,
    "is_permanent" boolean DEFAULT false NOT NULL,
    "color" text,
    "origin" session_origin DEFAULT 'explicit' NOT NULL,
    "anchor_tick_id" bigint,
    "user_edited" boolean DEFAULT false NOT NULL,
    CONSTRAINT "board_sessions_status_check" CHECK (status IN ('active', 'inactive', 'ended'))
  );

  -- Two concurrent reconciliations of the same unassigned run would otherwise both
  -- create a session on the same anchor. Present here so tests exercise the same
  -- constraint production has.
  CREATE UNIQUE INDEX IF NOT EXISTS "board_sessions_anchor_tick_idx"
    ON "board_sessions" ("anchor_tick_id") WHERE "origin" = 'inferred';

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

  DROP TABLE IF EXISTS "board_climb_ratings" CASCADE;
  DROP TABLE IF EXISTS "board_climb_aliases" CASCADE;
  DROP TABLE IF EXISTS "board_kits" CASCADE;
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
    "characteristics" text[],
    "updated_at" timestamp DEFAULT now() NOT NULL,
    "sync_seq" bigserial NOT NULL
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
    "upstream_ascensionist_count" bigint,
    "boardsesh_ascensionist_count" bigint,
    "difficulty_average" double precision,
    "quality_average" double precision,
    "upstream_quality_average" double precision,
    "boardsesh_quality_sum" double precision,
    "boardsesh_quality_count" bigint,
    "quality_normalized" boolean DEFAULT false NOT NULL,
    "fa_username" text,
    "fa_at" timestamp,
    "upstream_synced_at" timestamp,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    "sync_seq" bigserial NOT NULL,
    PRIMARY KEY ("board_type", "climb_uuid", "angle"),
    CONSTRAINT "board_climb_stats_quality_average_range" CHECK ("board_climb_stats"."quality_average" IS NULL OR ("board_climb_stats"."quality_average" >= 0 AND "board_climb_stats"."quality_average" <= 5)),
    CONSTRAINT "board_climb_stats_upstream_quality_average_range" CHECK ("board_climb_stats"."upstream_quality_average" IS NULL OR ("board_climb_stats"."upstream_quality_average" >= 0 AND "board_climb_stats"."upstream_quality_average" <= 5))
  );
  -- Same trap as the "gyms" column backfill further down: "board_climb_stats" is
  -- CREATE TABLE IF NOT EXISTS with no preceding DROP, and the per-worker test DBs
  -- persist between runs, so the two CHECKs above never land on a DB that was
  -- created before they existed. climb-stats-quality-range-check.test.ts asserts
  -- on them by name, so re-add them idempotently for pre-existing worker DBs.
  DO $$ BEGIN
    ALTER TABLE "board_climb_stats" ADD CONSTRAINT "board_climb_stats_quality_average_range" CHECK ("board_climb_stats"."quality_average" IS NULL OR ("board_climb_stats"."quality_average" >= 0 AND "board_climb_stats"."quality_average" <= 5));
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$;

  DO $$ BEGIN
    ALTER TABLE "board_climb_stats" ADD CONSTRAINT "board_climb_stats_upstream_quality_average_range" CHECK ("board_climb_stats"."upstream_quality_average" IS NULL OR ("board_climb_stats"."upstream_quality_average" >= 0 AND "board_climb_stats"."upstream_quality_average" <= 5));
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$;

  CREATE TABLE IF NOT EXISTS "board_climb_grades" (
    "board_type" text NOT NULL,
    "climb_uuid" text NOT NULL,
    "angle" integer NOT NULL,
    "local_grade" double precision,
    "universal_grade" double precision,
    "grade_low" double precision,
    "grade_high" double precision,
    "confidence" text NOT NULL,
    "ascensionist_count" bigint DEFAULT 0 NOT NULL,
    "content_prior" double precision,
    "model_version" text NOT NULL,
    "coeff_version" text NOT NULL,
    "computed_at" timestamp DEFAULT now() NOT NULL,
    "sync_seq" bigserial NOT NULL,
    PRIMARY KEY ("board_type", "climb_uuid", "angle")
  );

  -- Per-user, per-(board, climb, angle) star rating pulled from the climber's
  -- own Kilter account. The tick resolvers LEFT JOIN this to fall back to the
  -- synced rating when a tick's own quality is null. Mirrors board_climb_ratings
  -- in packages/db/src/schema/boards/unified.ts.
  CREATE TABLE IF NOT EXISTS "board_climb_ratings" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "board_type" text NOT NULL,
    "climb_uuid" text NOT NULL,
    "angle" integer NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "rating" integer,
    "difficulty_grade_id" integer,
    "comment" text DEFAULT '',
    "weight" double precision,
    "kilter_id" text,
    "aurora_id" text,
    -- Upstream-deleted marker (kilter-sync REMOVE soft-detach). Read paths
    -- exclude a stamped row from the effectiveQuality fallback.
    "kilter_detached_at" timestamp,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "board_climb_ratings_rating_range" CHECK ("rating" IS NULL OR ("rating" >= 1 AND "rating" <= 5))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "board_climb_ratings_user_climb_angle_idx" ON "board_climb_ratings" ("board_type", "climb_uuid", "angle", "user_id");
  -- The two surrogate uniques are PARTIAL (NOT NULL only) so a Boardsesh-originated
  -- rating can sit unsynced without colliding with every other unsynced row. They are
  -- GLOBAL, not user-scoped: one climb_rating_uuid lives on at most one row table-wide.
  -- kilter-sync's ratings upsert can only name ONE conflict target, so it has to make
  -- these unreachable before the statement runs (see applyClimbRatings). Leaving them
  -- out of this test schema is what let a duplicate-key regression reach production and
  -- wedge the kilter user sync for 30+ days.
  CREATE UNIQUE INDEX IF NOT EXISTS "board_climb_ratings_kilter_id_unique" ON "board_climb_ratings" ("kilter_id") WHERE "kilter_id" IS NOT NULL;
  -- aurora_id has the same structural hazard as kilter_id, but no writer today:
  -- board_climb_ratings is written ONLY by kilter-sync's applyClimbRatings, and
  -- nothing anywhere sets aurora_id. The column and index exist so an Aurora
  -- rating can be adopted later. Whoever adds that writer needs the same
  -- reconcile-before-upsert treatment kilter_id got — a single-target
  -- ON CONFLICT on the natural key does NOT cover this index.
  CREATE UNIQUE INDEX IF NOT EXISTS "board_climb_ratings_aurora_id_unique" ON "board_climb_ratings" ("aurora_id") WHERE "aurora_id" IS NOT NULL;

  -- Mirrors packages/db schema/boards/unified.ts boardClimbStatsHistory. The
  -- weekly full-table snapshot (snapshotClimbStatsHistoryIfDue) appends the
  -- current state of every climb with ascents; the grade backtest reads the
  -- series back. No FK to board_climb_stats — history rows outlive their source.
  DROP TABLE IF EXISTS "board_climb_stats_history" CASCADE;
  CREATE TABLE IF NOT EXISTS "board_climb_stats_history" (
    "id" bigserial PRIMARY KEY NOT NULL,
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
    "created_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE INDEX IF NOT EXISTS "board_climb_stats_history_lookup_idx" ON "board_climb_stats_history" ("board_type", "climb_uuid", "angle");

  -- Mirrors packages/db schema/boards/unified.ts boardSharedSyncs. Per-board
  -- sync cursors; the weekly gate (weekly-gate.ts) stores its "last run"
  -- watermark here under a synthetic __local_* table_name.
  DROP TABLE IF EXISTS "board_shared_syncs" CASCADE;
  CREATE TABLE IF NOT EXISTS "board_shared_syncs" (
    "board_type" text NOT NULL,
    "table_name" text NOT NULL,
    "last_synchronized_at" text,
    PRIMARY KEY ("board_type", "table_name")
  );

  DO $$ BEGIN
    CREATE TYPE tick_status AS ENUM ('flash', 'send', 'attempt');
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$;

  DO $$ BEGIN
    CREATE TYPE tick_origin AS ENUM ('native', 'aurora_pull', 'kilter_pull', 'json_import', 'moonboard_import');
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$;

  -- gym_members.role is a real enum in prod. The merge's member-collapse upsert
  -- builds an enum-typed CASE value (not just a string-equality read), so the
  -- test schema needs the actual type, not a text column.
  DO $$ BEGIN
    CREATE TYPE gym_member_role AS ENUM ('admin', 'editor', 'member');
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
    "origin" tick_origin NOT NULL DEFAULT 'native',
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
    "kilter_sync_error" text,
    "kilter_detached_at" timestamp
  );
  -- Mirror the prod cross-system unique indexes so the aurora/kilter sync and
  -- JSON-import upserts (ON CONFLICT (aurora_id) / (kilter_id)) resolve an
  -- arbiter index. Postgres allows many NULLs under a unique index, so pending
  -- (unsynced) ticks are unaffected.
  CREATE UNIQUE INDEX IF NOT EXISTS "boardsesh_ticks_aurora_id_unique" ON "boardsesh_ticks" ("aurora_id");
  CREATE UNIQUE INDEX IF NOT EXISTS "boardsesh_ticks_kilter_id_unique" ON "boardsesh_ticks" ("kilter_id");

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

  -- Remaining Aurora catalog tables. The direct-Aurora unified importer's
  -- provenance-scoped clear (clearAuroraBoardData, issue #3540) DELETEs from
  -- every board catalog table; these stubs let that clear run against the test
  -- DB. Minimal (no cross-table FKs) — the tests never insert into them.
  CREATE TABLE IF NOT EXISTS "board_attempts" (
    "board_type" text NOT NULL,
    "id" integer NOT NULL,
    "position" integer,
    "name" text,
    PRIMARY KEY ("board_type", "id")
  );

  CREATE TABLE IF NOT EXISTS "board_kits" (
    "board_type" text NOT NULL,
    "serial_number" text NOT NULL,
    "name" text,
    "is_autoconnect" boolean NOT NULL,
    "is_listed" boolean NOT NULL,
    "created_at" text NOT NULL,
    "updated_at" text NOT NULL,
    PRIMARY KEY ("board_type", "serial_number")
  );

  CREATE TABLE IF NOT EXISTS "board_products" (
    "board_type" text NOT NULL,
    "id" integer NOT NULL,
    "name" text,
    "is_listed" boolean,
    "password" text,
    "min_count_in_frame" integer,
    "max_count_in_frame" integer,
    PRIMARY KEY ("board_type", "id")
  );

  CREATE TABLE IF NOT EXISTS "board_sets" (
    "board_type" text NOT NULL,
    "id" integer NOT NULL,
    "name" text,
    "hsm" integer,
    PRIMARY KEY ("board_type", "id")
  );

  CREATE TABLE IF NOT EXISTS "board_users" (
    "board_type" text NOT NULL,
    "id" integer NOT NULL,
    "username" text,
    "created_at" text,
    PRIMARY KEY ("board_type", "id")
  );

  CREATE TABLE IF NOT EXISTS "board_layouts" (
    "board_type" text NOT NULL,
    "id" integer NOT NULL,
    "product_id" integer,
    "name" text,
    "instagram_caption" text,
    "is_mirrored" boolean,
    "is_listed" boolean,
    "password" text,
    "created_at" text,
    PRIMARY KEY ("board_type", "id")
  );

  CREATE TABLE IF NOT EXISTS "board_product_sizes" (
    "board_type" text NOT NULL,
    "id" integer NOT NULL,
    "product_id" integer NOT NULL,
    "edge_left" integer,
    "edge_right" integer,
    "edge_bottom" integer,
    "edge_top" integer,
    "name" text,
    "description" text,
    "image_filename" text,
    "position" integer,
    "is_listed" boolean,
    PRIMARY KEY ("board_type", "id")
  );

  CREATE TABLE IF NOT EXISTS "board_holes" (
    "board_type" text NOT NULL,
    "id" integer NOT NULL,
    "product_id" integer,
    "name" text,
    "x" integer,
    "y" integer,
    "mirrored_hole_id" integer,
    "mirror_group" integer DEFAULT 0,
    PRIMARY KEY ("board_type", "id")
  );

  CREATE TABLE IF NOT EXISTS "board_placement_roles" (
    "board_type" text NOT NULL,
    "id" integer NOT NULL,
    "product_id" integer,
    "position" integer,
    "name" text,
    "full_name" text,
    "led_color" text,
    "screen_color" text,
    PRIMARY KEY ("board_type", "id")
  );

  CREATE TABLE IF NOT EXISTS "board_leds" (
    "board_type" text NOT NULL,
    "id" integer NOT NULL,
    "product_size_id" integer,
    "hole_id" integer,
    "position" integer,
    PRIMARY KEY ("board_type", "id")
  );

  CREATE TABLE IF NOT EXISTS "board_product_sizes_layouts_sets" (
    "board_type" text NOT NULL,
    "id" integer NOT NULL,
    "product_size_id" integer,
    "layout_id" integer,
    "set_id" integer,
    "image_filename" text,
    "is_listed" boolean,
    PRIMARY KEY ("board_type", "id")
  );

  CREATE TABLE IF NOT EXISTS "board_walls" (
    "board_type" text NOT NULL,
    "uuid" text NOT NULL,
    "user_id" integer,
    "name" text,
    "product_id" integer,
    "is_adjustable" boolean,
    "angle" integer,
    "layout_id" integer,
    "product_size_id" integer,
    "hsm" integer,
    "serial_number" text,
    "created_at" text,
    PRIMARY KEY ("board_type", "uuid")
  );

  CREATE TABLE IF NOT EXISTS "board_user_syncs" (
    "board_type" text NOT NULL,
    "user_id" integer NOT NULL,
    "table_name" text NOT NULL,
    "last_synchronized_at" text,
    PRIMARY KEY ("board_type", "user_id", "table_name")
  );

  CREATE TABLE IF NOT EXISTS "board_circuits" (
    "board_type" text NOT NULL,
    "uuid" text NOT NULL,
    "name" text,
    "description" text,
    "color" text,
    "user_id" integer,
    "is_public" boolean,
    "created_at" text,
    "updated_at" text,
    PRIMARY KEY ("board_type", "uuid")
  );

  CREATE TABLE IF NOT EXISTS "board_circuits_climbs" (
    "board_type" text NOT NULL,
    "circuit_uuid" text NOT NULL,
    "climb_uuid" text NOT NULL,
    "position" integer,
    PRIMARY KEY ("board_type", "circuit_uuid", "climb_uuid")
  );

  CREATE TABLE IF NOT EXISTS "board_tags" (
    "board_type" text NOT NULL,
    "entity_uuid" text NOT NULL,
    "user_id" integer NOT NULL,
    "name" text NOT NULL,
    "is_listed" boolean,
    PRIMARY KEY ("board_type", "entity_uuid", "user_id", "name")
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

  -- Mirrors packages/db schema/auth/mappings.ts auroraCredentials. The
  -- duplicate-link guard reads (board_type, aurora_user_id, sync_status) here;
  -- the unique index enforces one credential per (user, board).
  DROP TABLE IF EXISTS "aurora_credentials" CASCADE;
  CREATE TABLE IF NOT EXISTS "aurora_credentials" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "board_type" text NOT NULL,
    "encrypted_username" text,
    "encrypted_password" text,
    "encrypted_refresh_token" text,
    "aurora_user_id" integer,
    "aurora_token" text,
    "last_sync_at" timestamp,
    "last_sync_attempt_at" timestamp,
    "sync_status" text DEFAULT 'pending' NOT NULL,
    "sync_error" text,
    "credential_failure_count" integer DEFAULT 0 NOT NULL,
    "last_credential_failure_at" timestamp,
    "consecutive_failures" integer DEFAULT 0 NOT NULL,
    "last_sync_error" text,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "unique_user_board_credential" ON "aurora_credentials" ("user_id", "board_type");
  CREATE INDEX IF NOT EXISTS "aurora_credentials_user_idx" ON "aurora_credentials" ("user_id");

  -- user-data-export resolver joins these (playlists/favorites). Minimal DDL
  -- covering only the columns the export queries read.
  DROP TABLE IF EXISTS "playlist_climbs" CASCADE;
  DROP TABLE IF EXISTS "playlist_ownership" CASCADE;
  DROP TABLE IF EXISTS "playlists" CASCADE;
  DROP TABLE IF EXISTS "user_favorites" CASCADE;

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
    "generated_recommendation" text,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    "last_accessed_at" timestamp
  );
  -- The two GLOBAL (non-partial) uniques the sync writers conflict on. Without
  -- them Postgres' "NULLs are distinct" behaviour — the whole cause of the
  -- kilter playlist duplication in #4707 — is unreproducible in the test DB,
  -- and an ON CONFLICT (kilter_id) would fail outright for want of an index.
  CREATE UNIQUE INDEX IF NOT EXISTS "playlists_aurora_id_idx" ON "playlists" ("aurora_id");
  CREATE UNIQUE INDEX IF NOT EXISTS "playlists_kilter_id_idx" ON "playlists" ("kilter_id");

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

  CREATE TABLE IF NOT EXISTS "user_playlist_pins" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "playlist_id" bigint NOT NULL REFERENCES "playlists"("id") ON DELETE CASCADE,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "unique_user_playlist_pin" ON "user_playlist_pins" ("user_id", "playlist_id");

  CREATE TABLE IF NOT EXISTS "user_favorites" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "board_name" text NOT NULL,
    "climb_uuid" text NOT NULL,
    "angle" integer NOT NULL DEFAULT 40,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );

  -- Follow tables (mirrors packages/db/src/schema/app/follows.ts) so the
  -- sync*Follows resolvers' user scoping is exercisable in tests.
  DROP TABLE IF EXISTS "user_follows" CASCADE;
  CREATE TABLE IF NOT EXISTS "user_follows" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "follower_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "following_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "unique_user_follow" ON "user_follows" ("follower_id", "following_id");

  DROP TABLE IF EXISTS "setter_follows" CASCADE;
  CREATE TABLE IF NOT EXISTS "setter_follows" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "follower_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "setter_username" text NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "unique_setter_follow" ON "setter_follows" ("follower_id", "setter_username");

  DROP TABLE IF EXISTS "playlist_follows" CASCADE;
  CREATE TABLE IF NOT EXISTS "playlist_follows" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "follower_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "playlist_uuid" text NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "unique_playlist_follow" ON "playlist_follows" ("follower_id", "playlist_uuid");

  DROP TABLE IF EXISTS "user_profiles" CASCADE;
  CREATE TABLE IF NOT EXISTS "user_profiles" (
    "user_id" text PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "display_name" text,
    "avatar_url" text,
    "instagram_url" text,
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
    "website" text,
    "contact_email" text,
    "contact_phone" text,
    "latitude" double precision,
    "longitude" double precision,
    "is_public" boolean DEFAULT true NOT NULL,
    "description" text,
    "hours" text,
    "hours_updated_at" timestamp,
    "image_url" text,
    "logo_url" text,
    "brand_primary_color" text,
    "brand_accent_color" text,
    "brand_background_color" text,
    "merged_into_gym_id" bigint REFERENCES "gyms"("id") ON DELETE SET NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    "deleted_at" timestamp,
    "sync_frozen_at" timestamp,
    "website_vouched_by_owner" boolean DEFAULT false NOT NULL
  );
  CREATE INDEX IF NOT EXISTS "gyms_merged_into_idx" ON "gyms" ("merged_into_gym_id") WHERE "merged_into_gym_id" IS NOT NULL;
  -- "gyms" is CREATE TABLE IF NOT EXISTS with no preceding DROP, and the
  -- per-worker test DBs persist between runs, so a column added to the block
  -- above never lands on a DB that already exists. Backfill it here.
  ALTER TABLE "gyms" ADD COLUMN IF NOT EXISTS "hours" text;
  ALTER TABLE "gyms" ADD COLUMN IF NOT EXISTS "hours_updated_at" timestamp;

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
    "timer_name" text,
    "gym_id" bigint,
    "presence_seq" bigint DEFAULT 0 NOT NULL,
    "deleted_at" timestamp,
    "sync_frozen_at" timestamp,
    "merged_into_board_uuid" text
  );
  -- Board presence: serials are not globally unique (the supplier reuses them),
  -- so a serial may map to many active boards. We only forbid one owner binding
  -- the same serial to two of their own boards OF THE SAME TYPE — Aurora runs a
  -- separate serial sequence per board app, so a Kilter #12345 and a Tension
  -- #12345 are different controllers one owner may legitimately hold.
  -- Excludes the system user (seeded public catalog boards) so the location
  -- sync can mirror the upstream catalog's duplicate serials verbatim.
  -- Dropped first: worker databases are reused across runs, so a bare
  -- CREATE ... IF NOT EXISTS would leave the narrower (owner, serial) index in
  -- place and the widened definition would never land.
  DROP INDEX IF EXISTS "user_boards_unique_owner_serial";
  CREATE UNIQUE INDEX IF NOT EXISTS "user_boards_unique_owner_serial"
    ON "user_boards" ("owner_id", "board_type", "serial_number")
    WHERE "serial_number" IS NOT NULL AND "serial_number" <> '' AND "deleted_at" IS NULL AND "owner_id" != '00000000-0000-0000-0000-000000000000';
  CREATE INDEX IF NOT EXISTS "user_boards_serial_idx"
    ON "user_boards" ("serial_number")
    WHERE "serial_number" IS NOT NULL AND "serial_number" <> '' AND "deleted_at" IS NULL;
  -- Owner+config lookup for createBoard's duplicate check (mirrors the prod
  -- partial index). NOT unique: the same config legitimately exists at two
  -- different gyms (#4166), so createBoard enforces "same config AND same
  -- place" in the resolver instead. The DROP handles a test DB created before
  -- migration 0189, where the old unique index would still be present and
  -- CREATE INDEX IF NOT EXISTS would silently leave it in place.
  DROP INDEX IF EXISTS "user_boards_unique_owner_config";
  CREATE INDEX IF NOT EXISTS "user_boards_owner_config_idx"
    ON "user_boards" ("owner_id", "board_type", "layout_id", "size_id", "set_ids")
    WHERE "deleted_at" IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS "user_boards_unique_slug"
    ON "user_boards" ("slug")
    WHERE "deleted_at" IS NULL;

  -- Follow/member tables that searchGyms/searchBoards enrichment reads (counts +
  -- follow/member status). The role column is plain text here (prod uses an
  -- enum); the resolvers only read the string value.
  DROP TABLE IF EXISTS "gym_members" CASCADE;
  CREATE TABLE IF NOT EXISTS "gym_members" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "gym_id" bigint NOT NULL REFERENCES "gyms"("id") ON DELETE CASCADE,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "role" gym_member_role NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "gym_members_unique_gym_user" ON "gym_members" ("gym_id", "user_id");

  DROP TABLE IF EXISTS "gym_follows" CASCADE;
  CREATE TABLE IF NOT EXISTS "gym_follows" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "gym_id" bigint NOT NULL REFERENCES "gyms"("id") ON DELETE CASCADE,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "created_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "gym_follows_unique_gym_user" ON "gym_follows" ("gym_id", "user_id");

  -- Maps upstream provider source keys (e.g. "kilter:123") to the canonical gym.
  -- findSimilarGyms reads the source-key prefixes to surface provider origins.
  DROP TABLE IF EXISTS "location_sync_gym_sources" CASCADE;
  CREATE TABLE IF NOT EXISTS "location_sync_gym_sources" (
    "source_key" text PRIMARY KEY NOT NULL,
    "gym_id" bigint NOT NULL REFERENCES "gyms"("id") ON DELETE CASCADE,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    -- When this gym's walls were last read from Aurora's authenticated per-gym
    -- endpoint. NULL means never read; the crawl queues those first.
    "walls_crawled_at" timestamp
  );

  DROP TABLE IF EXISTS "board_follows" CASCADE;
  CREATE TABLE IF NOT EXISTS "board_follows" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "board_uuid" text NOT NULL REFERENCES "user_boards"("uuid") ON DELETE CASCADE,
    "created_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "board_follows_unique_user_board" ON "board_follows" ("user_id", "board_uuid");

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
  -- Keyed on board_name too: one user can record both a Kilter #12345 and a
  -- Tension #12345. Dropped first for the same reused-worker-database reason as
  -- user_boards_unique_owner_serial above.
  DROP INDEX IF EXISTS "user_board_serials_unique_user_serial";
  CREATE UNIQUE INDEX IF NOT EXISTS "user_board_serials_unique_user_serial"
    ON "user_board_serials" ("user_id", "board_name", "serial_number");
  CREATE INDEX IF NOT EXISTS "user_board_serials_serial_idx" ON "user_board_serials" ("serial_number");
  CREATE INDEX IF NOT EXISTS "user_board_serials_board_uuid_idx" ON "user_board_serials" ("board_uuid");

  -- Durable per-board send log (dwell-gated). Distinct from boardsesh_ticks: the
  -- raw wall-push stream, no flash/send/attempt status.
  DROP TABLE IF EXISTS "board_climb_events" CASCADE;
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

  -- Votes on a comment/tick/climb/etc. entity_type is text here (see the
  -- comments-table note above — the real schema uses an enum).
  DROP TABLE IF EXISTS "votes" CASCADE;
  CREATE TABLE IF NOT EXISTS "votes" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "entity_type" text NOT NULL,
    "entity_id" text NOT NULL,
    "value" integer NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "votes_unique_user_entity" ON "votes" ("user_id", "entity_type", "entity_id");
  CREATE INDEX IF NOT EXISTS "votes_entity_idx" ON "votes" ("entity_type", "entity_id");

  -- Per-user activity feed rows (ascent/new_climb/comment/etc.), fanned out on
  -- write. entity_type/type are text here (see the comments-table note above).
  DROP TABLE IF EXISTS "feed_items" CASCADE;
  CREATE TABLE IF NOT EXISTS "feed_items" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "recipient_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "actor_id" text REFERENCES "users"("id") ON DELETE SET NULL,
    "type" text NOT NULL,
    "entity_type" text NOT NULL,
    "entity_id" text NOT NULL,
    "board_uuid" text,
    "metadata" jsonb,
    "created_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE INDEX IF NOT EXISTS "feed_items_recipient_created_at_idx" ON "feed_items" ("recipient_id", "created_at" DESC, "id" DESC);
  CREATE INDEX IF NOT EXISTS "feed_items_entity_type_entity_id_idx" ON "feed_items" ("entity_type", "entity_id");

  -- User notifications (comment replies, votes, follows, etc.). type/entity_type
  -- are text here (see the comments-table note above).
  DROP TABLE IF EXISTS "notifications" CASCADE;
  CREATE TABLE IF NOT EXISTS "notifications" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "uuid" text NOT NULL UNIQUE,
    "recipient_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "actor_id" text REFERENCES "users"("id") ON DELETE SET NULL,
    "type" text NOT NULL,
    "entity_type" text,
    "entity_id" text,
    "comment_id" bigint REFERENCES "comments"("id") ON DELETE SET NULL,
    "read_at" timestamp,
    "created_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE INDEX IF NOT EXISTS "notifications_recipient_created_at_idx" ON "notifications" ("recipient_id", "created_at");

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
  ALTER TABLE "board_beta_links"
    ADD CONSTRAINT "board_beta_links_tick_uuid_boardsesh_ticks_uuid_fk"
    FOREIGN KEY ("tick_uuid") REFERENCES "boardsesh_ticks"("uuid") ON DELETE SET NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS "board_beta_links_video_identity_unique" ON "board_beta_links" ("video_identity") WHERE "video_identity" IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS "board_beta_links_tick_uuid_unique" ON "board_beta_links" ("tick_uuid") WHERE "tick_uuid" IS NOT NULL;
  CREATE INDEX IF NOT EXISTS "board_beta_links_board_id_idx" ON "board_beta_links" ("board_id") WHERE "board_id" IS NOT NULL;

  -- Community moderation roles (admin / community_leader / tester), global or
  -- board-type-scoped. enrichBoard/enrichGym + requireBoardEditAccess /
  -- requireGymOwnerOrAdmin read these to authorize moderators editing catalog
  -- boards/gyms they don't own. role/board_type kept as plain text so the test
  -- schema doesn't need the production enum types.
  DROP TABLE IF EXISTS "community_roles" CASCADE;
  CREATE TABLE IF NOT EXISTS "community_roles" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "role" text NOT NULL,
    "board_type" text,
    "granted_by" text REFERENCES "users"("id") ON DELETE SET NULL,
    "created_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE INDEX IF NOT EXISTS "community_roles_board_type_idx" ON "community_roles" ("board_type");

  -- Scoped key/value config (scope: global | board | climb). Holds the grade
  -- proposal thresholds and the gym_ operational settings, including
  -- gym_claim_auto_approve, which requestGymClaim reads to decide whether an
  -- unclaimed listing can be handed over without a human reviewing it.
  DROP TABLE IF EXISTS "community_settings" CASCADE;
  CREATE TABLE IF NOT EXISTS "community_settings" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "scope" text NOT NULL,
    "scope_key" text NOT NULL,
    "key" text NOT NULL,
    "value" text NOT NULL,
    "set_by" text REFERENCES "users"("id") ON DELETE SET NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "community_settings_scope_key_idx"
    ON "community_settings" ("scope", "scope_key", "key");

  -- gym_members is created once, earlier (alongside the follow/member enrichment
  -- tables). The duplicate DROP+CREATE that used to sit here has been removed.

  DROP TABLE IF EXISTS "gym_follows" CASCADE;
  CREATE TABLE IF NOT EXISTS "gym_follows" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "gym_id" bigint NOT NULL REFERENCES "gyms"("id") ON DELETE CASCADE,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "created_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "gym_follows_unique_gym_user" ON "gym_follows" ("gym_id", "user_id");

  -- Gym ownership claims (domain-verified or admin-reviewed). method/status are
  -- plain text here (prod uses enums); the resolvers only read the string value.
  DROP TABLE IF EXISTS "gym_claims" CASCADE;
  CREATE TABLE IF NOT EXISTS "gym_claims" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "gym_id" bigint NOT NULL REFERENCES "gyms"("id") ON DELETE CASCADE,
    "claimant_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "method" text NOT NULL,
    "status" text DEFAULT 'pending' NOT NULL,
    "claim_email" text,
    "message" text,
    "token_hash" text,
    "expires_at" timestamp,
    "reviewed_by" text REFERENCES "users"("id") ON DELETE SET NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE INDEX IF NOT EXISTS "gym_claims_gym_idx" ON "gym_claims" ("gym_id");
  CREATE INDEX IF NOT EXISTS "gym_claims_claimant_idx" ON "gym_claims" ("claimant_user_id");
  CREATE INDEX IF NOT EXISTS "gym_claims_status_idx" ON "gym_claims" ("status");
  CREATE UNIQUE INDEX IF NOT EXISTS "gym_claims_token_hash_idx" ON "gym_claims" ("token_hash") WHERE "token_hash" IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS "gym_claims_unique_pending" ON "gym_claims" ("gym_id", "claimant_user_id") WHERE "status" = 'pending';

  -- Gym kiosks (smart-TV dashboards). layout holds the preset config (1–4 board
  -- slots + optional leaderboard rail); the resolver validates it with
  -- @boardsesh/kiosk's KioskLayoutSchema. Partial unique index keeps one live
  -- kiosk per (gym, slug) while freeing the slug on soft-delete.
  DROP TABLE IF EXISTS "gym_kiosks" CASCADE;
  CREATE TABLE IF NOT EXISTS "gym_kiosks" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "uuid" text NOT NULL UNIQUE,
    "gym_id" bigint NOT NULL REFERENCES "gyms"("id") ON DELETE CASCADE,
    "slug" text NOT NULL,
    "name" text NOT NULL,
    "layout" jsonb DEFAULT '{"version":1,"boards":[],"leaderboard":null}'::jsonb NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    "deleted_at" timestamp
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "gym_kiosks_unique_gym_slug" ON "gym_kiosks" ("gym_id", "slug") WHERE "deleted_at" IS NULL;

  -- In-app feedback (bug reports + ratings) and its admin triage state. Mirrors
  -- packages/db/src/schema/app/feedback.ts. status/resolved_* + github_issue_*
  -- were added in migration 0183. status is plain text here (prod uses the
  -- app_feedback_status enum); the resolvers only read the string value.
  DROP TABLE IF EXISTS "app_feedback" CASCADE;
  CREATE TABLE IF NOT EXISTS "app_feedback" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
    "rating" integer,
    "comment" text,
    "platform" text NOT NULL,
    "app_version" text,
    "source" text NOT NULL,
    "board_name" text,
    "layout_id" integer,
    "size_id" integer,
    "set_ids" jsonb,
    "angle" integer,
    "contact_consent" boolean,
    "context" jsonb,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "status" text DEFAULT 'new' NOT NULL,
    "resolved_at" timestamp,
    "resolved_by" text REFERENCES "users"("id") ON DELETE SET NULL,
    "github_issue_number" integer,
    "github_issue_url" text,
    "screenshot_keys" jsonb
  );
  CREATE INDEX IF NOT EXISTS "app_feedback_created_at_idx" ON "app_feedback" ("created_at");
  CREATE INDEX IF NOT EXISTS "app_feedback_user_idx" ON "app_feedback" ("user_id");
  CREATE INDEX IF NOT EXISTS "app_feedback_board_idx" ON "app_feedback" ("board_name");
  CREATE INDEX IF NOT EXISTS "app_feedback_status_idx" ON "app_feedback" ("status");

  -- Crowdsourced-QA verdicts a tester filed on a PR preview. Mirrors
  -- packages/db/src/schema/app/qa-verdicts.ts (migration 0206). verdict is
  -- plain text here (prod uses the qa_verdict_kind enum) with a CHECK; the
  -- resolvers only ever compare the string value.
  DROP TABLE IF EXISTS "qa_verdicts" CASCADE;
  CREATE TABLE IF NOT EXISTS "qa_verdicts" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
    "pr_number" integer NOT NULL,
    "branch" text NOT NULL,
    "head_sha" text,
    "head_committed_at" timestamp,
    "verdict" text NOT NULL CHECK ("verdict" IN ('approved', 'declined')),
    "by_tester" boolean DEFAULT true NOT NULL,
    "comment" text,
    "platform" text NOT NULL,
    "device_model" text,
    "os_version" text,
    "app_version" text,
    "update_id" text,
    "runtime_version" text,
    "bundle_created_at" timestamp,
    "screenshot_keys" jsonb,
    "github_comment_id" bigint,
    "github_comment_url" text,
    "created_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE INDEX IF NOT EXISTS "qa_verdicts_pr_created_idx" ON "qa_verdicts" ("pr_number", "created_at");
  CREATE INDEX IF NOT EXISTS "qa_verdicts_user_idx" ON "qa_verdicts" ("user_id");

  CREATE INDEX IF NOT EXISTS "gym_kiosks_gym_idx" ON "gym_kiosks" ("gym_id") WHERE "deleted_at" IS NULL;

  -- Hand-corrected hold outlines, overriding the traced geometry shard. Mirrors
  -- packages/db/src/schema/app/hold-outline-overrides.ts (migration 0207). kind
  -- is plain text here (prod uses the hold_outline_kind enum) with a CHECK, the
  -- same shape qa_verdicts.verdict takes above; the resolvers only ever compare
  -- the string value. The unique index is the upsert target, so it is not
  -- optional here.
  DROP TABLE IF EXISTS "hold_outline_overrides" CASCADE;
  CREATE TABLE IF NOT EXISTS "hold_outline_overrides" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "board_name" text NOT NULL,
    "layout_id" integer NOT NULL,
    "size_id" integer NOT NULL,
    "placement_id" integer NOT NULL,
    "kind" text NOT NULL DEFAULT 'silhouette' CHECK ("kind" IN ('silhouette', 'led_inner')),
    "outline" jsonb NOT NULL,
    "note" text,
    "author_id" text REFERENCES "users"("id") ON DELETE SET NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "hold_outline_overrides_placement_idx"
    ON "hold_outline_overrides" ("board_name", "layout_id", "size_id", "placement_id", "kind");
  CREATE INDEX IF NOT EXISTS "hold_outline_overrides_config_idx"
    ON "hold_outline_overrides" ("board_name", "layout_id", "size_id");

  -- Maps upstream location-provider source keys (kilter:..., tension:...) to the
  -- canonical gym. The duplicate-review candidate query reads provider prefixes
  -- from here, the merge re-points aliases, and the orphan audit flags gyms with
  -- no source row.
  DROP TABLE IF EXISTS "location_sync_gym_sources" CASCADE;
  CREATE TABLE IF NOT EXISTS "location_sync_gym_sources" (
    "source_key" text PRIMARY KEY NOT NULL,
    "gym_id" bigint NOT NULL REFERENCES "gyms"("id") ON DELETE CASCADE,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    -- When this gym's walls were last read from Aurora's authenticated per-gym
    -- endpoint. NULL means never read; the crawl queues those first.
    "walls_crawled_at" timestamp
  );
  CREATE INDEX IF NOT EXISTS "location_sync_gym_sources_gym_idx" ON "location_sync_gym_sources" ("gym_id");

  -- Audit trail for the /admin/gym-duplicates review queue. entity_type is not
  -- involved here; action is a plain text column (prod uses a gym_merge_audit_action
  -- enum) with a CHECK — string-equality is all the queue does with it.
  DROP TABLE IF EXISTS "gym_merge_audit" CASCADE;
  CREATE TABLE IF NOT EXISTS "gym_merge_audit" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "action" text NOT NULL,
    "canonical_gym_id" bigint REFERENCES "gyms"("id") ON DELETE SET NULL,
    "duplicate_gym_id" bigint REFERENCES "gyms"("id") ON DELETE SET NULL,
    "cluster_signature" text NOT NULL,
    "moved_counts" jsonb,
    "moved_rows" jsonb,
    "warnings" jsonb,
    "performed_by" text REFERENCES "users"("id") ON DELETE SET NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "gym_merge_audit_action_check" CHECK (action IN ('merged', 'dismissed'))
  );
  CREATE INDEX IF NOT EXISTS "gym_merge_audit_signature_action_idx" ON "gym_merge_audit" ("cluster_signature", "action");
  CREATE INDEX IF NOT EXISTS "gym_merge_audit_canonical_idx" ON "gym_merge_audit" ("canonical_gym_id");

  -- Durable audit for the global-admin location-sync unfreeze action. Production
  -- uses a Postgres enum; text + CHECK keeps the backend test schema portable.
  DROP TABLE IF EXISTS "location_sync_unfreeze_audit" CASCADE;
  CREATE TABLE IF NOT EXISTS "location_sync_unfreeze_audit" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "entity_type" text NOT NULL,
    "entity_uuid" text NOT NULL,
    "previous_sync_frozen_at" timestamp NOT NULL,
    "previous_deleted_at" timestamp,
    "previous_owner_id" text NOT NULL,
    "reason" text NOT NULL,
    "performed_by" text NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "location_sync_unfreeze_audit_entity_type_check" CHECK (entity_type IN ('gym', 'board'))
  );
  CREATE INDEX IF NOT EXISTS "location_sync_unfreeze_audit_entity_history_idx"
    ON "location_sync_unfreeze_audit" ("entity_type", "entity_uuid", "created_at");
  CREATE INDEX IF NOT EXISTS "location_sync_unfreeze_audit_performed_by_idx"
    ON "location_sync_unfreeze_audit" ("performed_by");

  -- Durable audit for the global-admin gym ownership handover (migration 0201).
  -- No foreign keys anywhere: the record must outlive the gym and both accounts.
  DROP TABLE IF EXISTS "gym_owner_reassignments" CASCADE;
  CREATE TABLE IF NOT EXISTS "gym_owner_reassignments" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "gym_uuid" text NOT NULL,
    "previous_owner_id" text NOT NULL,
    "new_owner_id" text NOT NULL,
    "sync_frozen_at_before" timestamp,
    "sync_frozen_at_after" timestamp,
    "reason" text NOT NULL,
    "performed_by" text NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE INDEX IF NOT EXISTS "gym_owner_reassignments_gym_history_idx"
    ON "gym_owner_reassignments" ("gym_uuid", "created_at");
  CREATE INDEX IF NOT EXISTS "gym_owner_reassignments_performed_by_idx"
    ON "gym_owner_reassignments" ("performed_by");

  -- Board followers (enrichBoard counts these per board).
  DROP TABLE IF EXISTS "board_follows" CASCADE;
  CREATE TABLE IF NOT EXISTS "board_follows" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "board_uuid" text NOT NULL REFERENCES "user_boards"("uuid") ON DELETE CASCADE,
    "created_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "board_follows_unique_user_board" ON "board_follows" ("user_id", "board_uuid");

  -- Per-(user, board) interaction state: last opened, and the pin. Drives the
  -- "Your boards" ordering in myBoards.
  DROP TABLE IF EXISTS "user_board_activity" CASCADE;
  CREATE TABLE IF NOT EXISTS "user_board_activity" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "board_uuid" text NOT NULL REFERENCES "user_boards"("uuid") ON DELETE CASCADE,
    "last_used_at" timestamp,
    "pinned_at" timestamp,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "user_board_activity_unique_user_board" ON "user_board_activity" ("user_id", "board_uuid");
  CREATE INDEX IF NOT EXISTS "user_board_activity_user_idx" ON "user_board_activity" ("user_id");
  CREATE INDEX IF NOT EXISTS "user_board_activity_board_uuid_idx" ON "user_board_activity" ("board_uuid");

  CREATE UNIQUE INDEX IF NOT EXISTS "unique_user_favorite" ON "user_favorites" ("user_id", "board_name", "climb_uuid", "angle");

  DROP TABLE IF EXISTS "sync_deletions" CASCADE;
  CREATE TABLE IF NOT EXISTS "sync_deletions" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "table_name" text NOT NULL,
    "record_id" text NOT NULL,
    "user_id" text,
    "deleted_at" timestamp DEFAULT now() NOT NULL
  );

  -- Mirrors packages/db schema/app/sync-daemon-leases.ts (migration 0187).
  -- Best-effort single-active-instance lease for the sync daemons.
  DROP TABLE IF EXISTS "sync_daemon_leases" CASCADE;
  CREATE TABLE IF NOT EXISTS "sync_daemon_leases" (
    "daemon_name" text PRIMARY KEY NOT NULL,
    "holder_id" text NOT NULL,
    "acquired_at" timestamp DEFAULT now() NOT NULL,
    "heartbeat_at" timestamp DEFAULT now() NOT NULL,
    "hostname" text
  );

  -- Mirrors 0146: sync cursor indexes lead with board_type; deleted_at serves
  -- the daily prune's DELETE WHERE deleted_at < cutoff.
  CREATE INDEX IF NOT EXISTS "sync_deletions_deleted_at_idx" ON "sync_deletions" ("deleted_at");
  CREATE INDEX IF NOT EXISTS "board_climbs_sync_cursor_idx" ON "board_climbs" ("board_type", "updated_at", "sync_seq");
  CREATE INDEX IF NOT EXISTS "board_climb_stats_sync_cursor_idx" ON "board_climb_stats" ("board_type", "updated_at", "sync_seq");
  CREATE INDEX IF NOT EXISTS "board_climb_grades_sync_cursor_idx" ON "board_climb_grades" ("board_type", "computed_at", "sync_seq");

  CREATE OR REPLACE FUNCTION log_deletion_playlists() RETURNS TRIGGER AS $$
  DECLARE
    owner_id text;
  BEGIN
    SELECT po.user_id INTO owner_id
    FROM playlist_ownership po
    WHERE po.playlist_id = OLD.id AND po.role = 'owner'
    LIMIT 1;
    -- Mirrors 0147: an orphaned playlist must not emit a user_id=NULL
    -- (global) tombstone.
    IF owner_id IS NULL THEN
      RETURN OLD;
    END IF;
    INSERT INTO sync_deletions (table_name, record_id, user_id)
    VALUES (TG_TABLE_NAME, OLD.uuid, owner_id);
    RETURN OLD;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_playlists_delete ON playlists;
  CREATE TRIGGER trg_playlists_delete BEFORE DELETE ON playlists
    FOR EACH ROW EXECUTE FUNCTION log_deletion_playlists();

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
    -- Mirrors 0146: an orphaned playlist_ownership must not emit a
    -- user_id=NULL (global) tombstone.
    IF owner_id IS NULL THEN
      RETURN OLD;
    END IF;
    INSERT INTO sync_deletions (table_name, record_id, user_id)
    VALUES (TG_TABLE_NAME, v_playlist_uuid || ':' || OLD.climb_uuid, owner_id);
    RETURN OLD;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_playlist_climbs_delete ON playlist_climbs;
  CREATE TRIGGER trg_playlist_climbs_delete AFTER DELETE ON playlist_climbs
    FOR EACH ROW EXECUTE FUNCTION log_deletion_playlist_climbs();

  CREATE OR REPLACE FUNCTION log_deletion_favorites() RETURNS TRIGGER AS $$
  BEGIN
    INSERT INTO sync_deletions (table_name, record_id, user_id)
    VALUES (TG_TABLE_NAME, OLD.board_name || ':' || OLD.climb_uuid || ':' || OLD.angle::text, OLD.user_id);
    RETURN OLD;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_favorites_delete ON user_favorites;
  CREATE TRIGGER trg_favorites_delete AFTER DELETE ON user_favorites
    FOR EACH ROW EXECUTE FUNCTION log_deletion_favorites();

  CREATE OR REPLACE FUNCTION log_deletion_board_climb_stats() RETURNS TRIGGER AS $$
  BEGIN
    -- Mirrors 0144: see log_deletion_board_climbs.
    IF current_setting('boardsesh.suppress_sync_tombstones', true) = 'on' THEN
      RETURN OLD;
    END IF;
    INSERT INTO sync_deletions (table_name, record_id, user_id)
    VALUES (TG_TABLE_NAME, OLD.board_type || ':' || OLD.climb_uuid || ':' || OLD.angle::text, NULL);
    RETURN OLD;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_board_climb_stats_delete ON board_climb_stats;
  CREATE TRIGGER trg_board_climb_stats_delete AFTER DELETE ON board_climb_stats
    FOR EACH ROW EXECUTE FUNCTION log_deletion_board_climb_stats();

  CREATE OR REPLACE FUNCTION log_deletion_ticks() RETURNS TRIGGER AS $$
  BEGIN
    INSERT INTO sync_deletions (table_name, record_id, user_id)
    VALUES (TG_TABLE_NAME, OLD.uuid, OLD.user_id);
    RETURN OLD;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_ticks_delete ON boardsesh_ticks;
  CREATE TRIGGER trg_ticks_delete AFTER DELETE ON boardsesh_ticks
    FOR EACH ROW EXECUTE FUNCTION log_deletion_ticks();

  CREATE OR REPLACE FUNCTION log_deletion_board_climbs() RETURNS TRIGGER AS $$
  BEGIN
    -- Mirrors 0144: bulk board re-imports set this transaction-local GUC so
    -- delete-then-recreate cycles don't tombstone the whole board.
    IF current_setting('boardsesh.suppress_sync_tombstones', true) = 'on' THEN
      RETURN OLD;
    END IF;
    INSERT INTO sync_deletions (table_name, record_id, user_id)
    VALUES (TG_TABLE_NAME, OLD.uuid, NULL);
    RETURN OLD;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_board_climbs_delete ON board_climbs;
  CREATE TRIGGER trg_board_climbs_delete AFTER DELETE ON board_climbs
    FOR EACH ROW EXECUTE FUNCTION log_deletion_board_climbs();

  -- Sync-field maintenance on UPDATE, mirroring 0144 + the later WHEN guards:
  -- internal-only (synced/sync_error) and no-op writes must not advance the
  -- sync cursors, and bookkeeping-only tick writes must not bump updated_at.
  CREATE OR REPLACE FUNCTION set_board_climbs_sync_fields() RETURNS TRIGGER AS $$
  BEGIN
    NEW.updated_at = NOW();
    NEW.sync_seq = nextval('board_climbs_sync_seq_seq');
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_board_climbs_set_sync_fields ON board_climbs;
  CREATE TRIGGER trg_board_climbs_set_sync_fields BEFORE UPDATE ON board_climbs
    FOR EACH ROW
    WHEN ((to_jsonb(OLD) - ARRAY['synced','sync_error','updated_at','sync_seq'])
          IS DISTINCT FROM
          (to_jsonb(NEW) - ARRAY['synced','sync_error','updated_at','sync_seq']))
    EXECUTE FUNCTION set_board_climbs_sync_fields();

  CREATE OR REPLACE FUNCTION set_board_climb_stats_sync_fields() RETURNS TRIGGER AS $$
  BEGIN
    NEW.updated_at = NOW();
    NEW.sync_seq = nextval('board_climb_stats_sync_seq_seq');
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_board_climb_stats_set_sync_fields ON board_climb_stats;
  CREATE TRIGGER trg_board_climb_stats_set_sync_fields BEFORE UPDATE ON board_climb_stats
    FOR EACH ROW
    WHEN (ROW(
            OLD.board_type,
            OLD.climb_uuid,
            OLD.angle,
            OLD.display_difficulty,
            OLD.benchmark_difficulty,
            OLD.ascensionist_count,
            OLD.difficulty_average,
            OLD.quality_average,
            OLD.fa_username,
            OLD.fa_at
          ) IS DISTINCT FROM ROW(
            NEW.board_type,
            NEW.climb_uuid,
            NEW.angle,
            NEW.display_difficulty,
            NEW.benchmark_difficulty,
            NEW.ascensionist_count,
            NEW.difficulty_average,
            NEW.quality_average,
            NEW.fa_username,
            NEW.fa_at
          ))
    EXECUTE FUNCTION set_board_climb_stats_sync_fields();

  CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
  BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_boardsesh_ticks_set_updated_at ON boardsesh_ticks;
  CREATE TRIGGER trg_boardsesh_ticks_set_updated_at BEFORE UPDATE ON boardsesh_ticks
    FOR EACH ROW
    WHEN ((to_jsonb(OLD) - ARRAY['id','board_id','updated_at',
            'aurora_type','aurora_id','aurora_synced_at','aurora_sync_error',
            'kilter_type','kilter_id','kilter_synced_at','kilter_sync_error'])
          IS DISTINCT FROM
          (to_jsonb(NEW) - ARRAY['id','board_id','updated_at',
            'aurora_type','aurora_id','aurora_synced_at','aurora_sync_error',
            'kilter_type','kilter_id','kilter_synced_at','kilter_sync_error']))
    EXECUTE FUNCTION set_updated_at();
`;
