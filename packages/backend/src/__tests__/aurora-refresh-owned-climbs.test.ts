import { afterAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext, SyncCursorInput } from '@boardsesh/shared-schema';
import type { OfflineDatabase, QueryInvalidator } from '@boardsesh/offline-sync';
import { pullSync, runMigrations } from '@boardsesh/offline-sync';
import { createTestDatabase } from '@boardsesh/offline-sync/testing';
import { rowsFromResult } from '@boardsesh/db/client';
import { clearAuroraBoardData, settleClearedOwnedClimbs } from '@boardsesh/db/queries';
import { db } from '../db/client';
import { syncQueries } from '../graphql/resolvers/sync/queries';

// ---------------------------------------------------------------------------
// A full refresh of a direct-Aurora board withdraws the owned upstream climbs it
// drops (real Postgres, real resolvers, the real client pull).
//
// The refresh deletes every upstream row of the board and re-inserts the dump,
// with sync tombstones suppressed so the rows that come straight back do not
// wipe every device's copy. An upstream climb an account owns (a draft the
// linked-account import stamped, or a climb the owner backfill assigned) may not
// be in the dump at all: the dump has no drafts. Its owner's phone downloaded
// it, and a sync never treats a missing row as deleted, so without a marker the
// phone kept it for good. A climb the dump recreates is not withdrawn, and gets
// its owner back.
// ---------------------------------------------------------------------------

const BOARD = 'decoy';
const LAYOUT_ID = 935_401;
const SIZE_ID = 5;
const SCOPE_KEY = `${BOARD}:${LAYOUT_ID}:${SIZE_ID}`;
const AURORA_SETTER_ID = 4_242;
const OWNER = 'refresh-owner';
const STRANGER = 'refresh-stranger';

type ClearDb = Parameters<typeof clearAuroraBoardData>[0];

type SeedClimb = {
  uuid: string;
  userId: string | null;
  isDraft: boolean;
  isListed: boolean;
  synced?: boolean;
};

// Upstream climbs carry the Aurora setter; the climb set in Boardsesh has none.
const BEFORE_REFRESH: SeedClimb[] = [
  { uuid: 'refresh-dropped-draft', userId: OWNER, isDraft: true, isListed: false },
  { uuid: 'refresh-dropped-public', userId: OWNER, isDraft: false, isListed: true },
  { uuid: 'refresh-kept-unlisted', userId: OWNER, isDraft: false, isListed: false },
  { uuid: 'refresh-kept-public', userId: OWNER, isDraft: false, isListed: true },
  { uuid: 'refresh-catalogue', userId: null, isDraft: false, isListed: true },
  { uuid: 'refresh-dropped-catalogue', userId: null, isDraft: false, isListed: true },
  { uuid: 'refresh-set-here', userId: OWNER, isDraft: false, isListed: true, synced: false },
];

/** What the dump brings back: no drafts, and no owner on anything, as the importer writes it. */
const DUMP: SeedClimb[] = [
  { uuid: 'refresh-kept-unlisted', userId: null, isDraft: false, isListed: false },
  { uuid: 'refresh-kept-public', userId: null, isDraft: false, isListed: true },
  { uuid: 'refresh-catalogue', userId: null, isDraft: false, isListed: true },
];

async function insertClimb(executor: { execute: typeof db.execute }, climb: SeedClimb, updatedAt: string | null) {
  const synced = climb.synced ?? true;
  await executor.execute(sql`
    INSERT INTO board_climbs
      (uuid, board_type, layout_id, name, frames, is_draft, is_listed, user_id, synced, setter_id,
       compatible_size_ids, updated_at)
    VALUES
      (${climb.uuid}, ${BOARD}, ${LAYOUT_ID}, ${`Climb ${climb.uuid}`}, 'p1r1', ${climb.isDraft}, ${climb.isListed},
       ${climb.userId}, ${synced}, ${synced ? AURORA_SETTER_ID : null}, ${`{${SIZE_ID}}`}::int[],
       COALESCE(${updatedAt}::timestamp, now()))
  `);
}

function viewerContext(userId: string): ConnectionContext {
  return {
    connectionId: `refresh-${userId}`,
    isAuthenticated: true,
    userId,
    sessionId: null,
    controllerId: null,
    controllerApiKey: null,
  } as unknown as ConnectionContext;
}

/**
 * The client's GraphQL transport, answered by the real sync resolvers for this
 * viewer: climbs and deletions, with an empty page for every other table.
 */
function resolverFetch(userId: string) {
  const context = viewerContext(userId);
  const emptyCursor: SyncCursorInput = { updatedAt: '1970-01-01T00:00:00.000Z', syncSeq: '0' };
  return async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    const climbArgs = variables as Parameters<typeof syncQueries.syncClimbs>[1];
    if (query.includes('syncDeletions')) {
      const deletionArgs = variables as Parameters<typeof syncQueries.syncDeletions>[1];
      return { syncDeletions: await syncQueries.syncDeletions(undefined, deletionArgs, context) } as T;
    }
    if (query.includes('syncClimbStats')) {
      return { syncClimbStats: await syncQueries.syncClimbStats(undefined, climbArgs, context) } as T;
    }
    if (query.includes('syncClimbGrades')) {
      return { syncClimbGrades: await syncQueries.syncClimbGrades(undefined, climbArgs, context) } as T;
    }
    if (query.includes('syncClimbs')) {
      return { syncClimbs: await syncQueries.syncClimbs(undefined, climbArgs, context) } as T;
    }
    const fieldName = query.match(/\{\s*\n?\s*(sync[A-Za-z]+)\(/)?.[1] ?? 'unknown';
    return { [fieldName]: { documents: [], cursor: emptyCursor, hasMore: false } } as T;
  };
}

function noopQueryClient(): QueryInvalidator {
  return { invalidateQueries: () => {} } as unknown as QueryInvalidator;
}

async function devicePull(device: OfflineDatabase, userId: string): Promise<string[]> {
  await pullSync(device, noopQueryClient(), resolverFetch(userId), { enabledBoards: [SCOPE_KEY] });
  const rows = await device.getAllAsync<{ uuid: string }>('SELECT uuid FROM board_climbs ORDER BY uuid');
  return rows.map((row) => row.uuid);
}

async function newDevice(): Promise<OfflineDatabase> {
  const device = createTestDatabase();
  await runMigrations(device);
  return device;
}

/** The importer's transaction, cut down to the clear, the dump and the settlement. */
async function refreshBoard(dump: SeedClimb[]) {
  return db.transaction(async (tx) => {
    const { clearedOwnedClimbs } = await clearAuroraBoardData(tx as unknown as ClearDb, BOARD);
    for (const climb of dump) await insertClimb(tx, climb, null);
    return settleClearedOwnedClimbs(tx as unknown as ClearDb, BOARD, clearedOwnedClimbs);
  });
}

async function removeFixtures(): Promise<void> {
  await db.execute(sql`DELETE FROM board_climbs WHERE board_type = ${BOARD}`);
  await db.execute(sql`DELETE FROM sync_deletions WHERE record_id LIKE 'refresh-%'`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${OWNER}, ${STRANGER})`);
}

describe('a full Aurora board refresh and the owned upstream climbs it drops (real DB)', () => {
  beforeEach(async () => {
    await removeFixtures();
    for (const userId of [OWNER, STRANGER]) {
      await db.execute(
        sql`INSERT INTO users (id, name, email) VALUES (${userId}, ${userId}, ${`${userId}@example.test`})`,
      );
    }
    for (const climb of BEFORE_REFRESH) await insertClimb(db, climb, '2026-05-01T00:00:00Z');
  });

  afterAll(async () => {
    await removeFixtures();
  });

  it('withdraws a dropped climb from the phones that downloaded it, and nothing the dump recreated', async () => {
    const ownerPhone = await newDevice();
    const strangerPhone = await newDevice();
    expect(await devicePull(ownerPhone, OWNER)).toEqual([
      'refresh-catalogue',
      'refresh-dropped-catalogue',
      'refresh-dropped-draft',
      'refresh-dropped-public',
      'refresh-kept-public',
      'refresh-kept-unlisted',
      'refresh-set-here',
    ]);
    expect(await devicePull(strangerPhone, STRANGER)).toEqual([
      'refresh-catalogue',
      'refresh-dropped-catalogue',
      'refresh-dropped-public',
      'refresh-kept-public',
      'refresh-set-here',
    ]);

    const settlement = await refreshBoard(DUMP);
    expect(settlement).toEqual({ ownerKept: 2, withdrawn: 2 });

    // The owner's draft is gone from their phone; their public climb from every
    // phone. A catalogue climb nobody owned keeps the refresh's old behaviour.
    expect(await devicePull(ownerPhone, OWNER)).toEqual([
      'refresh-catalogue',
      'refresh-dropped-catalogue',
      'refresh-kept-public',
      'refresh-kept-unlisted',
      'refresh-set-here',
    ]);
    expect(await devicePull(strangerPhone, STRANGER)).toEqual([
      'refresh-catalogue',
      'refresh-dropped-catalogue',
      'refresh-kept-public',
      'refresh-set-here',
    ]);
  });

  it('writes one marker per dropped owned climb: the owner’s for a draft, everyone’s for a public climb', async () => {
    await refreshBoard(DUMP);

    const markers = rowsFromResult<{ record_id: string; user_id: string | null }>(
      await db.execute(sql`
        SELECT record_id, user_id FROM sync_deletions
         WHERE table_name = 'board_climbs' AND record_id LIKE 'refresh-%'
         ORDER BY record_id`),
    );
    expect(markers).toEqual([
      { record_id: 'refresh-dropped-draft', user_id: OWNER },
      { record_id: 'refresh-dropped-public', user_id: null },
    ]);
  });

  it('gives a recreated climb back the owner it had', async () => {
    await refreshBoard(DUMP);

    const owners = rowsFromResult<{ uuid: string; user_id: string | null }>(
      await db.execute(sql`
        SELECT uuid, user_id FROM board_climbs WHERE board_type = ${BOARD} ORDER BY uuid`),
    );
    expect(owners).toEqual([
      { uuid: 'refresh-catalogue', user_id: null },
      { uuid: 'refresh-kept-public', user_id: OWNER },
      { uuid: 'refresh-kept-unlisted', user_id: OWNER },
      { uuid: 'refresh-set-here', user_id: OWNER },
    ]);
  });

  it('settles nothing when no account owned an upstream climb', async () => {
    await db.execute(sql`UPDATE board_climbs SET user_id = NULL WHERE board_type = ${BOARD} AND synced`);
    // Releasing the owned draft and unlisted climb above withdrew them; only the
    // refresh's own markers are under test.
    await db.execute(sql`DELETE FROM sync_deletions WHERE record_id LIKE 'refresh-%'`);
    expect(await refreshBoard(DUMP)).toEqual({ ownerKept: 0, withdrawn: 0 });
    const [markerCount] = rowsFromResult<{ count: number }>(
      await db.execute(sql`SELECT count(*)::int AS count FROM sync_deletions WHERE record_id LIKE 'refresh-%'`),
    );
    expect(markerCount?.count).toBe(0);
  });
});
