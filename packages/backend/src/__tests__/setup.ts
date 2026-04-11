import { beforeAll, beforeEach, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { roomManager } from '../services/room-manager';
import { resetAllRateLimits } from '../utils/rate-limiter';

const TEST_DB_NAME = 'boardsesh_backend_test';
const connectionString =
  process.env.DATABASE_URL || `postgresql://postgres:postgres@localhost:5433/${TEST_DB_NAME}`;

// Parse connection string to get base URL (without database name)
const baseConnectionString = connectionString.replace(/\/[^/]+$/, '/postgres');

let migrationClient: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle>;

// SQL to create only the tables needed for backend tests
const createTablesSQL = `
  -- Drop existing tables to ensure schema is up-to-date
  DROP TABLE IF EXISTS "board_session_queues" CASCADE;
  DROP TABLE IF EXISTS "board_session_clients" CASCADE;
  DROP TABLE IF EXISTS "board_session_participants" CASCADE;
  DROP TABLE IF EXISTS "board_sessions" CASCADE;
  DROP TABLE IF EXISTS "users" CASCADE;

  -- Create users table (minimal, needed for FK reference)
  CREATE TABLE IF NOT EXISTS "users" (
    "id" text PRIMARY KEY NOT NULL,
    "name" text,
    "email" text NOT NULL,
    "emailVerified" timestamp,
    "image" text,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );

  -- Create board_sessions table
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
    CONSTRAINT "board_sessions_status_check" CHECK (status IN ('active', 'inactive', 'ended'))
  );

  -- Create board_session_participants table
  CREATE TABLE IF NOT EXISTS "board_session_participants" (
    "session_id" text NOT NULL REFERENCES "board_sessions"("id") ON DELETE CASCADE,
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "joined_at" timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY ("session_id", "user_id")
  );

  -- Create board_session_clients table
  CREATE TABLE IF NOT EXISTS "board_session_clients" (
    "id" text PRIMARY KEY NOT NULL,
    "session_id" text NOT NULL REFERENCES "board_sessions"("id") ON DELETE CASCADE,
    "username" text,
    "connected_at" timestamp DEFAULT now() NOT NULL,
    "is_leader" boolean DEFAULT false NOT NULL
  );

  -- Create board_session_queues table
  CREATE TABLE IF NOT EXISTS "board_session_queues" (
    "session_id" text PRIMARY KEY NOT NULL REFERENCES "board_sessions"("id") ON DELETE CASCADE,
    "queue" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "current_climb_queue_item" jsonb DEFAULT 'null'::jsonb,
    "version" integer DEFAULT 1 NOT NULL,
    "sequence" integer DEFAULT 0 NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );

  -- Create indexes
  CREATE INDEX IF NOT EXISTS "board_sessions_location_idx" ON "board_sessions" ("latitude", "longitude");
  CREATE INDEX IF NOT EXISTS "board_sessions_discoverable_idx" ON "board_sessions" ("discoverable");
  CREATE INDEX IF NOT EXISTS "board_sessions_user_idx" ON "board_sessions" ("created_by_user_id");
  CREATE INDEX IF NOT EXISTS "board_sessions_status_idx" ON "board_sessions" ("status");
  CREATE INDEX IF NOT EXISTS "board_sessions_last_activity_idx" ON "board_sessions" ("last_activity");
  CREATE INDEX IF NOT EXISTS "board_sessions_discovery_idx" ON "board_sessions" ("discoverable", "status", "last_activity");
  CREATE INDEX IF NOT EXISTS "board_session_participants_session_idx" ON "board_session_participants" ("session_id");
  CREATE INDEX IF NOT EXISTS "board_session_participants_user_idx" ON "board_session_participants" ("user_id");

  -- Drop and recreate esp32_controllers table for controller tests
  DROP TABLE IF EXISTS "esp32_controllers" CASCADE;

  -- Create esp32_controllers table
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

  -- Create indexes for esp32_controllers
  CREATE INDEX IF NOT EXISTS "esp32_controllers_user_idx" ON "esp32_controllers" ("user_id");
  CREATE INDEX IF NOT EXISTS "esp32_controllers_api_key_idx" ON "esp32_controllers" ("api_key");
  CREATE INDEX IF NOT EXISTS "esp32_controllers_session_idx" ON "esp32_controllers" ("authorized_session_id");

  -- Drop and recreate board data tables (needed for climb-queries tests)
  DROP TABLE IF EXISTS "board_climb_stats" CASCADE;
  DROP TABLE IF EXISTS "board_climbs" CASCADE;
  DROP TABLE IF EXISTS "board_difficulty_grades" CASCADE;

  -- Create board_difficulty_grades table
  CREATE TABLE IF NOT EXISTS "board_difficulty_grades" (
    "board_type" text NOT NULL,
    "difficulty" integer NOT NULL,
    "boulder_name" text,
    "route_name" text,
    "is_listed" boolean,
    PRIMARY KEY ("board_type", "difficulty")
  );

  -- Create board_climbs table
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
    "compatible_size_ids" integer[]
  );

  -- Create board_climb_stats table
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

  -- Create enum types for boardsesh_ticks
  DO $$ BEGIN
    CREATE TYPE tick_status AS ENUM ('flash', 'send', 'attempt');
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$;

  -- Create boardsesh_ticks table (needed for climb queries with userId)
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
    "aurora_sync_error" text
  );

  -- Create board_placements table (needed for set_ids filtering in climb queries)
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

  -- Create board_climb_holds table (needed for set_ids filtering in climb queries)
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

  -- Insert common test users (needed for FK constraints in session tests)
  INSERT INTO "users" (id, email, name, created_at, updated_at)
  VALUES ('user-123', 'user-123@test.com', 'Test User 123', now(), now())
  ON CONFLICT (id) DO NOTHING;
`;

beforeAll(async () => {
  // First, connect to postgres database to create test database if needed
  // Suppress PostgreSQL NOTICE messages in test output
  const adminClient = postgres(baseConnectionString, { 
    max: 1, 
    onnotice: () => {},
    connect_timeout: 2, // Short timeout for check
  });

  let hasDb = false;
  try {
    // Check if test database exists
    const result = await adminClient`
      SELECT 1 FROM pg_database WHERE datname = ${TEST_DB_NAME}
    `;

    if (result.length === 0) {
      // Create the test database
      await adminClient.unsafe(`CREATE DATABASE ${TEST_DB_NAME}`);
      console.log(`Created test database: ${TEST_DB_NAME}`);
    }
    hasDb = true;
  } catch (error) {
    // Database might not be reachable
    console.warn('Test database check failed (Postgres might not be running):', (error as Error).message);
  } finally {
    try {
      await adminClient.end();
    } catch (e) {}
  }

  if (hasDb) {
    try {
      // Now connect to the test database
      migrationClient = postgres(connectionString, { max: 1, onnotice: () => {} });
      db = drizzle(migrationClient, { schema });

      // Create tables directly (backend tests only need session tables)
      await migrationClient.unsafe(createTablesSQL);
    } catch (error) {
      console.warn('Failed to initialize test database tables:', (error as Error).message);
      migrationClient = undefined as any;
      db = undefined as any;
    }
  }
});

beforeEach(async () => {
  // Reset room manager state
  roomManager.reset();

  // Reset rate limiter to prevent state leaking between tests
  resetAllRateLimits();

  // Clear all tables in correct order (respect foreign keys) if DB is available
  if (db) {
    try {
      await db.execute(sql`TRUNCATE TABLE board_session_queues CASCADE`);
      await db.execute(sql`TRUNCATE TABLE board_session_clients CASCADE`);
      await db.execute(sql`TRUNCATE TABLE board_session_participants CASCADE`);
      await db.execute(sql`TRUNCATE TABLE board_sessions CASCADE`);
    } catch (error) {
      console.warn('Failed to truncate tables in beforeEach:', (error as Error).message);
    }
  }
});

afterAll(async () => {
  // Close database connection
  if (migrationClient) {
    try {
      await migrationClient.end();
    } catch (e) {}
  }
});
