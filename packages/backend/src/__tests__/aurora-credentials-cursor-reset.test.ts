import { describe, it, expect, beforeEach, afterAll, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';

// Encryption secret for encrypt()/decrypt() used inside the save service.
process.env.AURORA_CREDENTIALS_SECRET = process.env.AURORA_CREDENTIALS_SECRET ?? 'test-aurora-secret';

// saveAuroraCredential calls AuroraClimbingClient.signIn (network). Stub it so
// every link here resolves to the same Aurora login; the cursor rows are read
// and written against the real per-worker test DB.
const signInMock = vi.fn();

vi.mock('@boardsesh/aurora-sync/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/aurora-sync/api')>()),
  AuroraClimbingClient: class {
    signIn = signInMock;
  },
  isAuroraRequestError: () => false,
}));

import { db } from '../db/client';
import { DuplicateBoardLinkError, deleteAuroraCredential, saveAuroraCredential } from '../services/aurora-credentials';

// #6692: board_user_syncs holds one watermark per Aurora login. A Boardsesh
// user with nothing synced from the board gets the login's logbook watermarks
// cleared when they link it, so its first sync reads the whole history.

const FIRST = 'cursor-reset-first';
const SECOND = 'cursor-reset-second';
const AURORA_LOGIN = 987654;
const OTHER_AURORA_LOGIN = 987655;
const WATERMARK = '2026-05-03 00:00:00.000000';
// Alphabetical, the order cursorTables reads them back in.
const EVERY_TABLE = ['ascents', 'bids', 'circuits', 'users', 'walls'];
const NON_LOGBOOK_TABLES = ['users', 'walls'];

async function insertUser(id: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

async function clearFixtures(): Promise<void> {
  await db.execute(sql`DELETE FROM "board_user_syncs" WHERE "user_id" IN (${AURORA_LOGIN}, ${OTHER_AURORA_LOGIN})`);
  await db.execute(sql`DELETE FROM "boardsesh_ticks" WHERE "user_id" IN (${FIRST}, ${SECOND})`);
  await db.execute(sql`DELETE FROM "playlists" WHERE "uuid" LIKE 'cursor-reset-%'`);
  await db.execute(sql`DELETE FROM "aurora_credentials" WHERE "user_id" IN (${FIRST}, ${SECOND})`);
  await db.execute(sql`DELETE FROM "user_board_mappings" WHERE "user_id" IN (${FIRST}, ${SECOND})`);
  await db.execute(sql`DELETE FROM "provider_sync_controls" WHERE "user_id" IN (${FIRST}, ${SECOND})`);
  await db.execute(sql`DELETE FROM "users" WHERE "id" IN (${FIRST}, ${SECOND})`);
}

/** What the first account's syncs left behind: a watermark on every user table. */
async function seedCursor(boardType: string, auroraUserId: number, tables: readonly string[] = EVERY_TABLE) {
  for (const tableName of tables) {
    await db.execute(sql`
      INSERT INTO "board_user_syncs" (board_type, user_id, table_name, last_synchronized_at)
      VALUES (${boardType}, ${auroraUserId}, ${tableName}, ${WATERMARK})
    `);
  }
}

async function cursorTables(boardType: string, auroraUserId: number): Promise<string[]> {
  const rows = await db.execute<{ table_name: string; last_synchronized_at: string }>(sql`
    SELECT table_name, last_synchronized_at FROM "board_user_syncs"
     WHERE board_type = ${boardType} AND user_id = ${auroraUserId}
     ORDER BY table_name
  `);
  // Every row that survives keeps the watermark it had.
  for (const row of rows) expect(row.last_synchronized_at).toBe(WATERMARK);
  return rows.map((row) => row.table_name);
}

/** A pulled tick, or with `auroraId: null` one logged here (origin `native`). */
async function insertTick(userId: string, boardType: string, auroraId: string | null): Promise<void> {
  await db.execute(sql`
    INSERT INTO "boardsesh_ticks" (uuid, user_id, board_type, climb_uuid, angle, status, climbed_at, origin, aurora_id)
    VALUES (${`cursor-reset-tick-${userId}-${boardType}-${auroraId ?? 'native'}`}, ${userId}, ${boardType},
            'cursor-reset-climb', 40, 'send', '2026-05-01 22:00:00',
            ${auroraId === null ? sql`'native'` : sql`'aurora_pull'`}, ${auroraId})
  `);
}

async function insertCircuitPlaylist(
  userId: string,
  boardType: string,
  auroraId: string,
  role: 'owner' | 'viewer' = 'owner',
): Promise<void> {
  await db.execute(sql`
    WITH playlist AS (
      INSERT INTO "playlists" (uuid, board_type, name, aurora_type, aurora_id)
      VALUES (${'cursor-reset-' + auroraId}, ${boardType}, 'Warmups', 'circuits', ${auroraId})
      RETURNING id
    )
    INSERT INTO "playlist_ownership" (playlist_id, user_id, role)
    SELECT id, ${userId}, ${role} FROM playlist
  `);
}

const link = (userId: string) =>
  saveAuroraCredential({ userId, boardType: 'tension', username: 'climber', password: 'pw' });

describe('linking an Aurora login resets its logbook watermark for a first-time linker (#6692)', () => {
  beforeEach(async () => {
    // These tests start no job queue, so keep the link from queueing a sync.
    vi.stubEnv('BATCH_FAMILIES_DISABLED', 'aurora-user-sync,kilter-user-sync');
    signInMock.mockReset();
    signInMock.mockResolvedValue({ token: 'aurora-token', user_id: AURORA_LOGIN });
    await clearFixtures();
    await insertUser(FIRST);
    await insertUser(SECOND);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await clearFixtures();
  });

  it('starts a second account from the beginning after the first account unlinked', async () => {
    await link(FIRST);
    await seedCursor('tension', AURORA_LOGIN);
    await insertTick(FIRST, 'tension', 'aurora-ascent-1');
    await insertCircuitPlaylist(FIRST, 'tension', 'aurora-circuit-1');
    await deleteAuroraCredential(FIRST, 'tension');

    await link(SECOND);

    // The first account's footprint is not the second account's. What the
    // re-read then does with the first account's sends is covered end to end in
    // aurora-credentials-enqueue.test.ts.
    expect(await cursorTables('tension', AURORA_LOGIN)).toEqual(NON_LOGBOOK_TABLES);
  });

  it('starts a second account from the beginning after the first account was deleted', async () => {
    await link(FIRST);
    await seedCursor('tension', AURORA_LOGIN);
    await insertTick(FIRST, 'tension', 'aurora-ascent-1');
    // Account deletion: prod cascades the ticks off users; the test schema has
    // no FK on boardsesh_ticks.user_id, so delete them the way the cascade would.
    await db.execute(sql`DELETE FROM "boardsesh_ticks" WHERE user_id = ${FIRST}`);
    await db.execute(sql`DELETE FROM "users" WHERE id = ${FIRST}`);

    await link(SECOND);

    expect(await cursorTables('tension', AURORA_LOGIN)).toEqual(NON_LOGBOOK_TABLES);
  });

  it('keeps the watermark for a climber relinking their own login, with or without an unlink', async () => {
    await link(FIRST);
    await seedCursor('tension', AURORA_LOGIN);
    await insertTick(FIRST, 'tension', 'aurora-ascent-1');

    await link(FIRST);
    expect(await cursorTables('tension', AURORA_LOGIN)).toEqual(EVERY_TABLE);

    await deleteAuroraCredential(FIRST, 'tension');
    await link(FIRST);
    expect(await cursorTables('tension', AURORA_LOGIN)).toEqual(EVERY_TABLE);
  });

  it('keeps the watermark when the relinking climber has only synced circuits', async () => {
    await link(FIRST);
    await seedCursor('tension', AURORA_LOGIN);
    await insertCircuitPlaylist(FIRST, 'tension', 'aurora-circuit-1');
    await deleteAuroraCredential(FIRST, 'tension');

    await link(FIRST);

    expect(await cursorTables('tension', AURORA_LOGIN)).toEqual(EVERY_TABLE);
  });

  it("ignores what says nothing about this login's cursor: JSON-import ids, other boards, a followed playlist", async () => {
    await seedCursor('tension', AURORA_LOGIN);
    // A send logged here, never pulled.
    await insertTick(SECOND, 'tension', null);
    // JSON-import ids are per-user hashes from the export file, never the API cursor.
    await insertTick(SECOND, 'tension', 'json-import-abc123');
    await insertCircuitPlaylist(SECOND, 'tension', 'json-import-circuit-abc123');
    // Sends and circuits synced from a different board.
    await insertTick(SECOND, 'decoy', 'aurora-decoy-ascent-1');
    await insertCircuitPlaylist(SECOND, 'decoy', 'aurora-decoy-circuit-1');
    // Someone else's Aurora circuit this climber only follows.
    await insertCircuitPlaylist(SECOND, 'tension', 'aurora-circuit-followed', 'viewer');

    await link(SECOND);

    expect(await cursorTables('tension', AURORA_LOGIN)).toEqual(NON_LOGBOOK_TABLES);
  });

  it('clears only the linked login on the linked board', async () => {
    await seedCursor('tension', AURORA_LOGIN);
    await seedCursor('tension', OTHER_AURORA_LOGIN);
    await seedCursor('decoy', AURORA_LOGIN);

    await link(SECOND);

    expect(await cursorTables('tension', AURORA_LOGIN)).toEqual(NON_LOGBOOK_TABLES);
    expect(await cursorTables('tension', OTHER_AURORA_LOGIN)).toEqual(EVERY_TABLE);
    expect(await cursorTables('decoy', AURORA_LOGIN)).toEqual(EVERY_TABLE);
  });

  it('leaves the watermark alone when the link is refused', async () => {
    await link(FIRST);
    await seedCursor('tension', AURORA_LOGIN);

    const error = await link(SECOND).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(DuplicateBoardLinkError);
    expect(await cursorTables('tension', AURORA_LOGIN)).toEqual(EVERY_TABLE);
  });
});
