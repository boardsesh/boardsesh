// worker-db must be imported first: it rewrites DATABASE_URL at module-load
// time, before any other import can materialise db/client against the template DB.
import { getWorkerDatabaseUrl, setupWorkerDatabase } from './worker-db';
import { beforeAll, beforeEach, afterAll } from 'vite-plus/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { roomManager } from '../services/room-manager';
import { resetAllRateLimits } from '../utils/rate-limiter';

// migrationClient is assigned as soon as we open a connection, so afterAll can
// always close it even if the subsequent TRUNCATE/seed throws (which would
// leave dbAvailable=false but still leak the socket).
let migrationClient: ReturnType<typeof postgres> | undefined;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;

// Tables the per-file beforeAll resets so each file starts on a clean slate.
// Order doesn't matter — TRUNCATE ... CASCADE handles FK edges.
const TABLES_TO_RESET = [
  'activity_push_tokens',
  'board_session_queues',
  'board_session_clients',
  'board_session_participants',
  'board_sessions',
  'boardsesh_ticks',
  'inferred_sessions',
  'board_climb_holds',
  'board_climb_stats',
  'board_climbs',
  'board_placements',
  'board_difficulty_grades',
  'esp32_controllers',
  'user_climb_percentiles',
  'user_board_mappings',
  'board_climb_history',
  'board_history_sequences',
  'user_board_serials',
  'user_boards',
  'users',
];

beforeAll(async () => {
  try {
    // Ensure this worker's dedicated DB + schema exist. Idempotent, cached per-process.
    await setupWorkerDatabase();

    migrationClient = postgres(getWorkerDatabaseUrl(), { max: 1, onnotice: () => {} });
    db = drizzle(migrationClient, { schema });

    await migrationClient.unsafe(
      `TRUNCATE TABLE ${TABLES_TO_RESET.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );
    await migrationClient.unsafe(
      `INSERT INTO "users" (id, email, name, created_at, updated_at)
       VALUES ('user-123', 'user-123@test.com', 'Test User 123', now(), now())
       ON CONFLICT (id) DO NOTHING`,
    );
    dbAvailable = true;
  } catch (error) {
    if (process.env.SKIP_TEST_INFRA === '1') {
      console.warn('[setup] Test database unreachable (SKIP_TEST_INFRA=1) — DB-dependent tests will fail.');
      return;
    }
    throw new Error(
      `[setup] Cannot initialise worker database.\n` +
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
});

beforeEach(async () => {
  // Reset room manager state
  roomManager.reset();

  // Reset rate limiter to prevent state leaking between tests
  resetAllRateLimits();

  // Only clear tables if the database is available
  if (dbAvailable && db) {
    // Clear all tables in correct order (respect foreign keys)
    await db.execute(sql`TRUNCATE TABLE board_session_queues CASCADE`);
    await db.execute(sql`TRUNCATE TABLE board_session_clients CASCADE`);
    await db.execute(sql`TRUNCATE TABLE board_session_participants CASCADE`);
    await db.execute(sql`TRUNCATE TABLE board_sessions CASCADE`);
  }
});

afterAll(async () => {
  if (migrationClient) {
    await migrationClient.end();
  }
});
