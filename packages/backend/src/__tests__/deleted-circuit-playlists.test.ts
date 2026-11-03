process.env.AURORA_CREDENTIALS_SECRET = process.env.AURORA_CREDENTIALS_SECRET ?? 'test-aurora-secret';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { asc, eq, sql } from 'drizzle-orm';
import type { ConnectionContext, SyncResult } from '@boardsesh/shared-schema';
import { userDeletedUpstreamPlaylists } from '@boardsesh/db/schema';
import { acquireUpstreamPlaylistLock } from '@boardsesh/db/queries';
import { getCircuitPlaylistOwnershipConflictState, syncUserData } from '@boardsesh/aurora-sync/sync';
import { applyCircuits, type PowerSyncOp } from '@boardsesh/kilter-sync';

import { db } from '../db/client';
import { playlistMutations } from '../graphql/resolvers/playlists/mutations';
import { syncQueries } from '../graphql/resolvers/sync/queries';
import { deleteAuroraCredential } from '../services/aurora-credentials';
import {
  AURORA_USER_ID,
  FIXTURE_BOARD,
  fullSyncPage,
  insertLinkedTensionAccount,
  removeFixtures,
  stubAuroraApi,
} from '../workers/families/__tests__/provider-sync-fixtures';

// ---------------------------------------------------------------------------
// Deleted playlists stay deleted (#7240), against a real database.
//
// The Kilter PowerSync stream re-sends every circuit every routine cycle, and
// Aurora re-sends a circuit when it changes. Before the fix, deletePlaylist
// hard-deleted the row and kept nothing, so the next cycle found no playlist
// with that kilter_id / aurora_id and inserted a fresh one. These tests run the
// real resolver and the real circuit writers back to back.
// ---------------------------------------------------------------------------

const USER_A = 'psync-deleted-circuit-a';
const USER_B = 'psync-deleted-circuit-b';
const TENSION_CLIMB = 'psync-deleted-tension-climb';
const KILTER_CIRCUIT = 'psync-deleted-kcircuit-1';
const OTHER_KILTER_CIRCUIT = 'psync-deleted-kcircuit-2';
const ADOPTED_CIRCUIT = 'psync-deleted-adopted';
const UNADOPTED_CIRCUIT = 'psync-deleted-unadopted';
/** The circuit `fullSyncPage` carries. */
const TENSION_CIRCUIT = 'psync-circuit-1';

type OwnedPlaylist = { id: string; uuid: string; kilter_id: string | null; aurora_id: string | null };

function ctx(userId: string): ConnectionContext {
  return {
    connectionId: `conn-${userId}`,
    isAuthenticated: true,
    userId,
    sessionId: null,
    controllerId: null,
    controllerApiKey: null,
  } as unknown as ConnectionContext;
}

async function seedUser(userId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, name, created_at, updated_at)
    VALUES (${userId}, ${`${userId}@test.com`}, ${userId}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

async function ownedPlaylists(userId: string): Promise<OwnedPlaylist[]> {
  const result = await db.execute(sql`
    SELECT p.id::text AS id, p.uuid, p.kilter_id, p.aurora_id
    FROM playlists p
    JOIN playlist_ownership po ON po.playlist_id = p.id AND po.role = 'owner'
    WHERE po.user_id = ${userId}
    ORDER BY p.id
  `);
  return Array.from(result as Iterable<OwnedPlaylist>);
}

async function playlistsCarrying(upstreamId: string): Promise<number> {
  const result = await db.execute(sql`
    SELECT count(*)::int AS count FROM playlists WHERE kilter_id = ${upstreamId} OR aurora_id = ${upstreamId}
  `);
  return Array.from(result as Iterable<{ count: number }>)[0].count;
}

async function deletedRows(userId: string) {
  return db
    .select({
      boardType: userDeletedUpstreamPlaylists.boardType,
      upstreamSource: userDeletedUpstreamPlaylists.upstreamSource,
      upstreamId: userDeletedUpstreamPlaylists.upstreamId,
    })
    .from(userDeletedUpstreamPlaylists)
    .where(eq(userDeletedUpstreamPlaylists.userId, userId))
    .orderBy(asc(userDeletedUpstreamPlaylists.upstreamSource), asc(userDeletedUpstreamPlaylists.upstreamId));
}

function deletePlaylist(userId: string, playlistUuid: string): Promise<boolean> {
  return playlistMutations.deletePlaylist(undefined, { playlistId: playlistUuid }, ctx(userId));
}

function circuitPut(circuitUuid: string, name: string): PowerSyncOp {
  return {
    op_id: circuitUuid,
    op: 'PUT',
    object_type: 'circuits',
    object_id: circuitUuid,
    data: {
      id: circuitUuid,
      circuit_uuid: circuitUuid,
      name,
      description: null,
      color: null,
      is_public: 0,
      user_uuid: 'kilter-sub',
      product_layout_uuid: null,
    },
  };
}

function circuitClimbPut(circuitUuid: string, climbUuid: string): PowerSyncOp {
  return {
    op_id: `${circuitUuid}:${climbUuid}`,
    op: 'PUT',
    object_type: 'circuit_climbs',
    object_id: `${circuitUuid}:${climbUuid}`,
    data: {
      id: `${circuitUuid}:${climbUuid}`,
      circuit_uuid: circuitUuid,
      climb_uuid: climbUuid,
      angle: 40,
      position: 0,
    },
  };
}

type ApplyTx = Parameters<typeof applyCircuits>[0];

/** One Kilter circuits phase: the full snapshot, in its own transaction, as the runner does it. */
function kilterCycle(userId: string, circuitUuids: string[] = [KILTER_CIRCUIT]) {
  const ops = circuitUuids.map((circuitUuid) => circuitPut(circuitUuid, `Circuit ${circuitUuid}`));
  const climbOps = circuitUuids.map((circuitUuid) => circuitClimbPut(circuitUuid, 'psync-deleted-kclimb'));
  const aliasCache = new Map([['kilter:psync-deleted-kclimb', 'psync-deleted-kclimb']]);
  return db.transaction((tx) => applyCircuits(tx as unknown as ApplyTx, userId, ops, climbOps, aliasCache, () => {}));
}

/** One Aurora user sync: the stubbed API serves the same page, circuit included, every time. */
async function tensionCycle(userId: string): Promise<void> {
  stubAuroraApi({ pages: [fullSyncPage(TENSION_CLIMB)] });
  await syncUserData(db, FIXTURE_BOARD, 'token', AURORA_USER_ID, userId, { log: () => {}, logError: () => {} });
}

async function cleanUp(): Promise<void> {
  await db.execute(sql`DELETE FROM sync_deletions WHERE user_id IN (${USER_A}, ${USER_B})`);
  await db.execute(sql`
    DELETE FROM playlists
    WHERE kilter_id LIKE 'psync-deleted-%' OR aurora_id LIKE 'psync-deleted-%' OR uuid LIKE 'psync-deleted-%'
  `);
  // Users last: the deleted-circuit rows cascade with them.
  await removeFixtures(db, [USER_A, USER_B], [TENSION_CLIMB]);
}

describe('deleted circuit playlists stay deleted (#7240)', () => {
  beforeEach(cleanUp);
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(cleanUp);

  it('a deleted Kilter circuit playlist is not re-imported by the next sync, and the pull serves only its tombstone', async () => {
    await seedUser(USER_A);
    await kilterCycle(USER_A);
    const [synced] = await ownedPlaylists(USER_A);
    expect(synced.kilter_id).toBe(KILTER_CIRCUIT);

    expect(await deletePlaylist(USER_A, synced.uuid)).toBe(true);
    expect(await deletedRows(USER_A)).toEqual([
      { boardType: 'kilter', upstreamSource: 'kilter', upstreamId: KILTER_CIRCUIT },
    ]);

    // Two more cycles of the same snapshot: before the fix the first one
    // inserted a fresh playlist with a new uuid.
    await kilterCycle(USER_A);
    await kilterCycle(USER_A);
    expect(await ownedPlaylists(USER_A)).toEqual([]);
    expect(await playlistsCarrying(KILTER_CIRCUIT)).toBe(0);

    // Offline clients: the playlist pull has nothing, and the tombstone the
    // delete trigger wrote is what syncDeletions will hand them.
    const pulled = (await syncQueries.syncPlaylists(
      undefined,
      { cursor: null, limit: 500 },
      ctx(USER_A),
    )) as SyncResult;
    expect(pulled.documents).toEqual([]);
    const tombstones = await db.execute(sql`
      SELECT record_id FROM sync_deletions WHERE table_name = 'playlists' AND user_id = ${USER_A}
    `);
    expect(Array.from(tombstones as Iterable<{ record_id: string }>).map((row) => row.record_id)).toEqual([
      synced.uuid,
    ]);
  });

  it('a deleted Tension circuit playlist is not re-imported when Aurora sends the circuit again', async () => {
    await insertLinkedTensionAccount(db, USER_A, TENSION_CLIMB);
    await tensionCycle(USER_A);
    const [synced] = await ownedPlaylists(USER_A);
    expect(synced.aurora_id).toBe(TENSION_CIRCUIT);

    expect(await deletePlaylist(USER_A, synced.uuid)).toBe(true);
    expect(await deletedRows(USER_A)).toEqual([
      { boardType: FIXTURE_BOARD, upstreamSource: 'aurora', upstreamId: TENSION_CIRCUIT },
    ]);

    await tensionCycle(USER_A);
    expect(await ownedPlaylists(USER_A)).toEqual([]);
    expect(await playlistsCarrying(TENSION_CIRCUIT)).toBe(0);
    // The circuit itself still mirrors upstream: only the playlist stays gone.
    const source = await db.execute(sql`
      SELECT count(*)::int AS count FROM board_circuits WHERE board_type = ${FIXTURE_BOARD} AND uuid = ${TENSION_CIRCUIT}
    `);
    expect(Array.from(source as Iterable<{ count: number }>)[0].count).toBe(1);
  });

  it('deleting a playlist built in Boardsesh records nothing and still deletes it', async () => {
    await seedUser(USER_A);
    const inserted = await db.execute(sql`
      INSERT INTO playlists (uuid, board_type, name) VALUES ('psync-deleted-native', 'kilter', 'Mine') RETURNING id
    `);
    const playlistId = Array.from(inserted as Iterable<{ id: string }>)[0].id;
    await db.execute(sql`
      INSERT INTO playlist_ownership (playlist_id, user_id, role) VALUES (${playlistId}, ${USER_A}, 'owner')
    `);

    expect(await deletePlaylist(USER_A, 'psync-deleted-native')).toBe(true);
    expect(await ownedPlaylists(USER_A)).toEqual([]);
    expect(await deletedRows(USER_A)).toEqual([]);
  });

  it('one climber deleting a circuit does not hide it from another climber linked to the same account', async () => {
    await seedUser(USER_A);
    await seedUser(USER_B);
    await kilterCycle(USER_A);
    const [synced] = await ownedPlaylists(USER_A);
    await deletePlaylist(USER_A, synced.uuid);

    // B's sync of the same circuit is untouched by A's list.
    const bResult = await kilterCycle(USER_B);
    expect(bResult.skippedForeignCircuits).toBe(0);
    expect((await ownedPlaylists(USER_B)).map((row) => row.kilter_id)).toEqual([KILTER_CIRCUIT]);

    // A's next cycle skips it quietly: a circuit A deleted is not a
    // duplicate-account conflict just because B now holds it.
    const aResult = await kilterCycle(USER_A);
    expect(aResult.skippedForeignCircuits).toBe(0);
    expect(await ownedPlaylists(USER_A)).toEqual([]);
    expect((await ownedPlaylists(USER_B)).map((row) => row.kilter_id)).toEqual([KILTER_CIRCUIT]);
  });

  it('an adopted pre-split Kilter playlist records both upstream ids and stays deleted', async () => {
    await seedUser(USER_A);
    // The pre-split shape: aurora_id only. Tier-1 adoption stamps the kilter_id.
    const inserted = await db.execute(sql`
      INSERT INTO playlists (uuid, board_type, name, aurora_type, aurora_id, aurora_synced_at, created_at, updated_at)
      VALUES ('psync-deleted-legacy', 'kilter', 'Warmups', 'circuits', ${ADOPTED_CIRCUIT},
              now() - interval '200 days', now() - interval '200 days', now() - interval '200 days')
      RETURNING id
    `);
    const playlistId = Array.from(inserted as Iterable<{ id: string }>)[0].id;
    await db.execute(sql`
      INSERT INTO playlist_ownership (playlist_id, user_id, role) VALUES (${playlistId}, ${USER_A}, 'owner')
    `);
    await kilterCycle(USER_A, [ADOPTED_CIRCUIT]);
    expect(await ownedPlaylists(USER_A)).toEqual([
      { id: playlistId, uuid: 'psync-deleted-legacy', kilter_id: ADOPTED_CIRCUIT, aurora_id: ADOPTED_CIRCUIT },
    ]);

    await deletePlaylist(USER_A, 'psync-deleted-legacy');
    expect(await deletedRows(USER_A)).toEqual([
      { boardType: 'kilter', upstreamSource: 'kilter', upstreamId: ADOPTED_CIRCUIT },
      { boardType: 'kilter', upstreamSource: 'aurora', upstreamId: ADOPTED_CIRCUIT },
    ]);

    await kilterCycle(USER_A, [ADOPTED_CIRCUIT]);
    expect(await ownedPlaylists(USER_A)).toEqual([]);
  });

  it('a pre-split Kilter playlist deleted before Kilter adopted it stays deleted when Grips sends its circuit', async () => {
    await seedUser(USER_A);
    // The pre-split shape no Kilter cycle has adopted yet: aurora_id only.
    const inserted = await db.execute(sql`
      INSERT INTO playlists (uuid, board_type, name, aurora_type, aurora_id, aurora_synced_at, created_at, updated_at)
      VALUES ('psync-deleted-unadopted-row', 'kilter', 'Projects', 'circuits', ${UNADOPTED_CIRCUIT},
              now() - interval '200 days', now() - interval '200 days', now() - interval '200 days')
      RETURNING id
    `);
    const playlistId = Array.from(inserted as Iterable<{ id: string }>)[0].id;
    await db.execute(sql`
      INSERT INTO playlist_ownership (playlist_id, user_id, role) VALUES (${playlistId}, ${USER_A}, 'owner')
    `);

    await deletePlaylist(USER_A, 'psync-deleted-unadopted-row');
    // aurora-sync never syncs a Kilter credential, so the aurora row alone is
    // never read: the kilter row is the one that keeps it gone.
    expect(await deletedRows(USER_A)).toEqual([
      { boardType: 'kilter', upstreamSource: 'kilter', upstreamId: UNADOPTED_CIRCUIT },
      { boardType: 'kilter', upstreamSource: 'aurora', upstreamId: UNADOPTED_CIRCUIT },
    ]);

    // Grips kept the circuit uuid, so it arrives as a Kilter circuit. Before
    // the fix nothing held that kilter_id and there was no row left to adopt,
    // so the first cycle inserted a fresh playlist.
    await kilterCycle(USER_A, [UNADOPTED_CIRCUIT]);
    await kilterCycle(USER_A, [UNADOPTED_CIRCUIT]);
    expect(await ownedPlaylists(USER_A)).toEqual([]);
    expect(await playlistsCarrying(UNADOPTED_CIRCUIT)).toBe(0);
  });

  it('a Tension circuit one climber deleted and another claimed is not a duplicate-account conflict', async () => {
    // Two Boardsesh accounts linked to the same Tension account.
    await insertLinkedTensionAccount(db, USER_A, TENSION_CLIMB);
    await insertLinkedTensionAccount(db, USER_B, TENSION_CLIMB);
    const conflictStateFor = (userId: string) =>
      getCircuitPlaylistOwnershipConflictState(db, FIXTURE_BOARD, AURORA_USER_ID, userId);

    await tensionCycle(USER_A);
    const [synced] = await ownedPlaylists(USER_A);
    await deletePlaylist(USER_A, synced.uuid);
    expect(await conflictStateFor(USER_A)).toBe('none');

    // B's sync claims the circuit A deleted.
    await tensionCycle(USER_B);
    expect((await ownedPlaylists(USER_B)).map((row) => row.aurora_id)).toEqual([TENSION_CIRCUIT]);

    // Before the fix this read 'foreign' for A on every sync from here on, and
    // A's runner stored the duplicate-account sync_error.
    expect(await conflictStateFor(USER_A)).toBe('none');
    expect(await conflictStateFor(USER_B)).toBe('none');

    // A's next sync still leaves it alone, and B keeps it.
    await tensionCycle(USER_A);
    expect(await ownedPlaylists(USER_A)).toEqual([]);
    expect((await ownedPlaylists(USER_B)).map((row) => row.aurora_id)).toEqual([TENSION_CIRCUIT]);
  });

  it('unlinking a board account clears only that board, so a re-link imports the circuit again', async () => {
    await insertLinkedTensionAccount(db, USER_A, TENSION_CLIMB);
    await tensionCycle(USER_A);
    await kilterCycle(USER_A);
    for (const playlist of await ownedPlaylists(USER_A)) await deletePlaylist(USER_A, playlist.uuid);
    expect((await deletedRows(USER_A)).map((row) => row.boardType)).toEqual(['kilter', FIXTURE_BOARD]);

    await deleteAuroraCredential(USER_A, 'kilter');
    expect(await deletedRows(USER_A)).toEqual([
      { boardType: FIXTURE_BOARD, upstreamSource: 'aurora', upstreamId: TENSION_CIRCUIT },
    ]);

    await kilterCycle(USER_A);
    await tensionCycle(USER_A);
    // Kilter's circuit is back; the Tension one, whose account is still
    // linked, stays deleted.
    expect((await ownedPlaylists(USER_A)).map((row) => row.kilter_id ?? row.aurora_id)).toEqual([KILTER_CIRCUIT]);
  });

  it('a delete waits for an in-flight circuit sync of the same climber instead of racing it', async () => {
    await seedUser(USER_A);
    await kilterCycle(USER_A);
    const [synced] = await ownedPlaylists(USER_A);

    // A circuits phase for a DIFFERENT circuit: it holds no row lock on the
    // playlist being deleted, so only the per-user lock can make the delete
    // wait. Without it the delete commits mid-batch, and a batch that had
    // already read the deleted list would re-insert the circuit.
    let releaseSync!: () => void;
    const syncMayCommit = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    let syncHoldsLock!: () => void;
    const syncStarted = new Promise<void>((resolve) => {
      syncHoldsLock = resolve;
    });
    const inFlightSync = db.transaction(async (tx) => {
      await applyCircuits(
        tx as unknown as ApplyTx,
        USER_A,
        [circuitPut(OTHER_KILTER_CIRCUIT, 'Other')],
        [],
        new Map(),
        () => {},
      );
      syncHoldsLock();
      await syncMayCommit;
    });
    await syncStarted;

    const pendingDelete = deletePlaylist(USER_A, synced.uuid);
    const settledEarly = await Promise.race([
      pendingDelete.then(() => 'deleted'),
      new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 400)),
    ]);
    expect(settledEarly).toBe('waiting');

    releaseSync();
    await inFlightSync;
    expect(await pendingDelete).toBe(true);
    expect((await ownedPlaylists(USER_A)).map((row) => row.kilter_id)).toEqual([OTHER_KILTER_CIRCUIT]);
    expect((await deletedRows(USER_A)).map((row) => row.upstreamId)).toEqual([KILTER_CIRCUIT]);
  });

  it("a delete of a circuit playlist waits for a transaction holding the climber's upstream-playlist lock", async () => {
    await seedUser(USER_A);
    await kilterCycle(USER_A);
    const [synced] = await ownedPlaylists(USER_A);

    // The lock the circuit writers will take around their batch. It holds no
    // row lock on the playlist, so only the advisory lock can make the delete
    // wait.
    let releaseLock!: () => void;
    const lockMayRelease = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let lockHeld!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      lockHeld = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await acquireUpstreamPlaylistLock(tx, USER_A);
      lockHeld();
      await lockMayRelease;
    });
    await lockTaken;

    const pendingDelete = deletePlaylist(USER_A, synced.uuid);
    const settledEarly = await Promise.race([
      pendingDelete.then(() => 'deleted'),
      new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 400)),
    ]);
    expect(settledEarly).toBe('waiting');

    releaseLock();
    await holder;
    expect(await pendingDelete).toBe(true);
    expect(await ownedPlaylists(USER_A)).toEqual([]);
    expect((await deletedRows(USER_A)).map((row) => row.upstreamId)).toEqual([KILTER_CIRCUIT]);
  });
});
