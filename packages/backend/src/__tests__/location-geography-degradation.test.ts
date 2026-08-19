import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { logger } from '../utils/logger';
import { socialBoardMutations } from '../graphql/resolvers/social/boards';
import { socialGymMutations } from '../graphql/resolvers/social/gyms';
import { resetAllRateLimits } from '../utils/rate-limiter';
import { getWorkerDatabaseUrl } from './worker-db';
import { POSTGIS_SCHEMA_SQL, POSTGIS_TEARDOWN_SQL } from './schema-sql';

/**
 * Real-DB coverage for board/gym mutations on a database WITHOUT PostGIS — the
 * deployment #4218 reports.
 *
 * The test database used to BE that deployment by accident. Since #4507 it
 * carries PostGIS (the proximity queries need somewhere real to run), so this
 * file builds its own no-PostGIS world instead: `beforeAll` drops the `location`
 * columns and their derivation triggers, `afterAll` puts them back from the same
 * DDL string schema-sql.ts applies, so there is no second copy to drift. Files
 * run one at a time within a worker, so the window is this file only.
 *
 * Dropping the column beats stubbing the write: the resolver still issues the
 * real statement and still gets a real SQLSTATE back from the real driver.
 *
 * On main, updateBoard/updateGym/createGym issued unguarded
 * `UPDATE ... SET location = ST_MakePoint(...)` statements, so saving an edit
 * with coordinates threw after the row had already been updated: the user saw a
 * failure for a save that had landed. Every case below except the premise probe
 * and `createBoard` (already guarded) fails against main.
 */

const OWNER = 'geo-degrade-owner';

const BOARD_CONFIG = { boardType: 'moonboard', layoutId: 3, sizeId: 1, setIds: '5,6,7' };

let connectionCounter = 0;
const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}-${connectionCounter++}`, isAuthenticated: true, userId }) as ConnectionContext;

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

type BoardRow = { uuid: string; name: string };
type GymRow = { uuid: string; name: string };

const createBoard = (input: Record<string, unknown>) =>
  socialBoardMutations.createBoard(
    null,
    { input: { ...BOARD_CONFIG, name: 'A board', ...input } },
    authCtx(OWNER),
  ) as Promise<BoardRow>;

const updateBoard = (input: Record<string, unknown>) =>
  socialBoardMutations.updateBoard(null, { input }, authCtx(OWNER)) as Promise<BoardRow>;

const createGym = (input: Record<string, unknown>) =>
  socialGymMutations.createGym(null, { input: { name: 'A gym', ...input } }, authCtx(OWNER)) as Promise<GymRow>;

const updateGym = (input: Record<string, unknown>) =>
  socialGymMutations.updateGym(null, { input }, authCtx(OWNER)) as Promise<GymRow>;

type Coordinates = { latitude: number | null; longitude: number | null };

async function storedCoordinates(table: 'user_boards' | 'gyms', uuid: string): Promise<Coordinates> {
  const result =
    table === 'user_boards'
      ? await db.execute(sql`SELECT latitude, longitude FROM user_boards WHERE uuid = ${uuid}`)
      : await db.execute(sql`SELECT latitude, longitude FROM gyms WHERE uuid = ${uuid}`);
  const row = Array.from(result as Iterable<Coordinates>)[0];
  return {
    latitude: row.latitude == null ? null : Number(row.latitude),
    longitude: row.longitude == null ? null : Number(row.longitude),
  };
}

type GeographyWarning = { table: string; operation: string; code: string | undefined };

// Reduce logger.warn calls to the geography-sync ones, dropping the message and
// the raw driver text so the assertion reads as the contract, not the wording.
function warnedGeographyFailures(warnSpy: { mock: { calls: unknown[][] } }): GeographyWarning[] {
  return warnSpy.mock.calls.flatMap((call) => {
    const meta = call[1] as { table?: string; operation?: string; code?: string } | undefined;
    if (meta?.table == null || meta.operation == null) return [];
    return [{ table: meta.table, operation: meta.operation, code: meta.code }];
  });
}

/** Multi-statement DDL, so it goes through postgres.js directly rather than `db.execute`. */
async function applySchemaStatements(statements: string): Promise<void> {
  const client = postgres(getWorkerDatabaseUrl(), { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(statements);
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Whether the server under test has PostGIS at all. It decides which SQLSTATE
 * the guarded write comes back with: with the extension installed and only the
 * column removed the `::geography` cast still resolves, so the failure is the
 * undefined column; on a server with no PostGIS the cast itself is what fails.
 */
let hasPostGis = false;

beforeAll(async () => {
  const extension = await db.execute(
    sql`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') AS present`,
  );
  hasPostGis = Array.from(extension as Iterable<{ present: boolean }>)[0]?.present === true;
  await applySchemaStatements(POSTGIS_TEARDOWN_SQL);
});

afterAll(async () => {
  await applySchemaStatements(POSTGIS_SCHEMA_SQL);
});

beforeEach(async () => {
  resetAllRateLimits();
  await db.execute(sql`
    TRUNCATE TABLE
      "community_roles", "gym_members", "gym_follows", "location_sync_gym_sources", "user_boards", "gyms"
    RESTART IDENTITY CASCADE
  `);
  await insertUser(OWNER);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('location geography writes degrade without PostGIS', () => {
  it('runs against a database that really has no location column', async () => {
    const tablesWithColumn = async (columnName: string) => {
      const rows = await db.execute(sql`
        SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('user_boards', 'gyms')
          AND column_name = ${columnName}
      `);
      return Array.from(rows as Iterable<{ table_name: string }>)
        .map((row) => row.table_name)
        .sort();
    };

    // The latitude probe proves the query shape finds columns that DO exist, so
    // the empty `location` result below is a real absence rather than a query
    // that silently returns nothing.
    expect(await tablesWithColumn('latitude')).toEqual(['gyms', 'user_boards']);
    // The beforeAll teardown is what every case below stands on: with the column
    // still there the geography writes all succeed and the file passes vacuously.
    // If this fails, the teardown stopped working — fix it before trusting them.
    expect(await tablesWithColumn('location')).toEqual([]);
  });

  it('leaves no derivation trigger to write the geography behind the resolver', async () => {
    // The other half of the teardown. `gyms_set_location` derives `location` from
    // lat/lng on every insert, so a surviving trigger would both hide the guarded
    // write's failure and error inside the trigger body against the dropped column.
    const triggers = await db.execute(sql`
      SELECT tgname FROM pg_trigger
      WHERE tgname IN ('gyms_set_location', 'user_boards_set_location')
    `);
    expect(Array.from(triggers as Iterable<{ tgname: string }>)).toEqual([]);
  });

  it('updateBoard saves new coordinates instead of failing on the missing column', async () => {
    const board = await createBoard({ name: 'Klimmuur MoonBoard' });

    const updated = await updateBoard({ boardUuid: board.uuid, latitude: 47.0, longitude: 8.0 });

    expect(updated.uuid).toBe(board.uuid);
    expect(await storedCoordinates('user_boards', board.uuid)).toEqual({ latitude: 47.0, longitude: 8.0 });
  });

  it('updateBoard clears coordinates without failing', async () => {
    const board = await createBoard({ name: 'Klimmuur MoonBoard', latitude: 47.0, longitude: 8.0 });

    await updateBoard({ boardUuid: board.uuid, latitude: null, longitude: null });

    expect(await storedCoordinates('user_boards', board.uuid)).toEqual({ latitude: null, longitude: null });
  });

  it('updateBoard changing only longitude keeps the stored latitude', async () => {
    const board = await createBoard({ name: 'Klimmuur MoonBoard', latitude: 47.0, longitude: 8.0 });

    await updateBoard({ boardUuid: board.uuid, longitude: 8.5 });

    expect(await storedCoordinates('user_boards', board.uuid)).toEqual({ latitude: 47.0, longitude: 8.5 });
  });

  it('createGym with coordinates resolves', async () => {
    const gym = await createGym({ name: 'Boulder Space', latitude: 47.0, longitude: 8.0 });

    expect(await storedCoordinates('gyms', gym.uuid)).toEqual({ latitude: 47.0, longitude: 8.0 });
  });

  it('updateGym saves new coordinates instead of failing', async () => {
    const gym = await createGym({ name: 'Boulder Space' });

    await updateGym({ gymUuid: gym.uuid, latitude: 47.1, longitude: 8.1 });

    expect(await storedCoordinates('gyms', gym.uuid)).toEqual({ latitude: 47.1, longitude: 8.1 });
  });

  it('updateGym clears coordinates without failing', async () => {
    const gym = await createGym({ name: 'Boulder Space', latitude: 47.0, longitude: 8.0 });

    await updateGym({ gymUuid: gym.uuid, latitude: null, longitude: null });

    expect(await storedCoordinates('gyms', gym.uuid)).toEqual({ latitude: null, longitude: null });
  });

  it('createBoard with coordinates still resolves after the refactor', async () => {
    const board = await createBoard({ name: 'Klimmuur MoonBoard', latitude: 47.0, longitude: 8.0 });

    expect(await storedCoordinates('user_boards', board.uuid)).toEqual({ latitude: 47.0, longitude: 8.0 });
  });

  // The cases above only prove the mutations stop throwing — they would also
  // pass if the geography writes were deleted outright. These two pin the
  // guard itself: the write is still attempted, and the failure is warned with
  // the SQLSTATE this database really returns.
  it('warns with the ST_MakePoint SQLSTATE instead of throwing', async () => {
    const board = await createBoard({ name: 'Klimmuur MoonBoard' });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    await updateBoard({ boardUuid: board.uuid, latitude: 47.0, longitude: 8.0 });

    expect(warnedGeographyFailures(warnSpy)).toContainEqual({
      table: 'user_boards',
      operation: 'updateBoard',
      // Both are the #4218 deployment, one column-shaped and one extension-shaped:
      // with PostGIS installed the `::geography` cast resolves and the undefined
      // column is what fails; with no PostGIS the cast fails first.
      code: hasPostGis ? '42703' : '42704',
    });
  });

  it('warns with the missing-column SQLSTATE when clearing coordinates', async () => {
    const gym = await createGym({ name: 'Boulder Space', latitude: 47.0, longitude: 8.0 });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    await updateGym({ gymUuid: gym.uuid, latitude: null, longitude: null });

    expect(warnedGeographyFailures(warnSpy)).toContainEqual({
      table: 'gyms',
      operation: 'updateGym',
      code: '42703', // column "location" does not exist
    });
  });
});
