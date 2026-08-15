import { describe, it, expect, afterEach } from 'vite-plus/test';
import { sql } from 'drizzle-orm';

import { db } from '../db/client';
import { applyCircuits, type PowerSyncOp } from '@boardsesh/kilter-sync';

// ---------------------------------------------------------------------------
// Legacy Kilter playlist adoption (real DB) — #4707
//
// Kilter used to be an ordinary Aurora board, so a circuit the user has had for
// years already lives in `playlists` keyed on `aurora_id`, with `kilter_id`
// still NULL. `playlists_kilter_id_idx` is a GLOBAL, NON-PARTIAL unique, and
// Postgres treats NULLs in a unique index as distinct — so applyCircuits'
// `ON CONFLICT (kilter_id) DO UPDATE` could never match that row. Re-linking
// Kilter inserted a SECOND playlist for every pre-split circuit, carrying
// Kilter's stale content and stamped `created_at = now()`, which sorted the old
// versions to the top of the user's list.
//
// This only reproduces against a real database with the real index, which is
// why schema-sql.ts now creates `playlists_aurora_id_idx` and
// `playlists_kilter_id_idx`. The stub-transaction unit tests in
// packages/kilter-sync cover the branch selection; these cover the behaviour.
// ---------------------------------------------------------------------------

const USER_ID = 'circuit-adopt-user';
const OTHER_USER_ID = 'circuit-adopt-other-user';

type PlaylistRow = {
  id: string | number | bigint;
  uuid: string;
  name: string;
  description: string | null;
  aurora_id: string | null;
  kilter_id: string | null;
  kilter_type: string | null;
  kilter_synced_at: Date | string | null;
  aurora_synced_at: Date | string | null;
  updated_at: Date | string;
};

async function seedUser(id: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${`${id}@test.com`}, ${id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

/**
 * A pre-split Kilter playlist exactly as aurora-sync (or the mobile JSON
 * import) left it: upstream origin in `aurora_id`, `kilter_id` still NULL.
 *
 * `editedDaysAgo` is when the user last touched it in Boardsesh. Leaving it
 * equal to the import time models an untouched playlist; a more recent value
 * models the reporter's case — edited in Boardsesh, and since circuit push-back
 * is stubbed (#3525) that edit is the only copy that exists.
 */
async function seedLegacyPlaylist(args: {
  userId: string;
  uuid: string;
  auroraId: string;
  name: string;
  description?: string | null;
  importedDaysAgo?: number;
  editedDaysAgo?: number;
  climbUuids?: string[];
}): Promise<bigint> {
  const importedDaysAgo = args.importedDaysAgo ?? 200;
  const editedDaysAgo = args.editedDaysAgo ?? importedDaysAgo;
  const inserted = await db.execute(sql`
    INSERT INTO playlists (uuid, board_type, layout_id, name, description, is_public, color,
                           aurora_type, aurora_id, aurora_synced_at, created_at, updated_at)
    VALUES (${args.uuid}, 'kilter', NULL, ${args.name}, ${args.description ?? null}, false, NULL,
            'circuits', ${args.auroraId},
            now() - (${importedDaysAgo} || ' days')::interval,
            now() - (${importedDaysAgo} || ' days')::interval,
            now() - (${editedDaysAgo} || ' days')::interval)
    RETURNING id
  `);
  const playlistId = BigInt(String(Array.from(inserted as Iterable<{ id: string | number }>)[0].id));

  await db.execute(sql`
    INSERT INTO playlist_ownership (playlist_id, user_id, role)
    VALUES (${playlistId}, ${args.userId}, 'owner')
  `);

  const climbUuids = args.climbUuids ?? [];
  for (const [position, climbUuid] of climbUuids.entries()) {
    await db.execute(sql`
      INSERT INTO playlist_climbs (playlist_id, climb_uuid, angle, position)
      VALUES (${playlistId}, ${climbUuid}, 40, ${position})
    `);
  }
  return playlistId;
}

async function readPlaylists(userId: string): Promise<PlaylistRow[]> {
  const result = await db.execute(sql`
    SELECT p.id, p.uuid, p.name, p.description, p.aurora_id, p.kilter_id, p.kilter_type,
           p.kilter_synced_at, p.aurora_synced_at, p.updated_at
    FROM playlists p
    JOIN playlist_ownership po ON po.playlist_id = p.id AND po.role = 'owner'
    WHERE po.user_id = ${userId} AND p.board_type = 'kilter'
    ORDER BY p.id
  `);
  return Array.from(result as Iterable<PlaylistRow>);
}

async function readClimbs(playlistId: bigint): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT climb_uuid FROM playlist_climbs WHERE playlist_id = ${playlistId} ORDER BY position
  `);
  return Array.from(result as Iterable<{ climb_uuid: string }>).map((row) => row.climb_uuid);
}

function circuitPut(args: { circuitUuid: string; name: string; description?: string | null }): PowerSyncOp {
  return {
    op_id: '1',
    op: 'PUT',
    object_type: 'circuits',
    object_id: args.circuitUuid,
    data: {
      id: args.circuitUuid,
      circuit_uuid: args.circuitUuid,
      name: args.name,
      description: args.description ?? null,
      color: null,
      is_public: 0,
      user_uuid: 'kilter-sub',
      product_layout_uuid: null,
    },
  };
}

function circuitClimbPut(args: { circuitUuid: string; climbUuid: string; position: number }): PowerSyncOp {
  return {
    op_id: `${args.circuitUuid}:${args.climbUuid}`,
    op: 'PUT',
    object_type: 'circuit_climbs',
    object_id: `${args.circuitUuid}:${args.climbUuid}`,
    data: {
      id: `${args.circuitUuid}:${args.climbUuid}`,
      circuit_uuid: args.circuitUuid,
      climb_uuid: args.climbUuid,
      angle: 40,
      position: args.position,
    },
  };
}

// Pre-seeded so resolveCanonicalClimbUuid never touches board_climb_aliases.
function aliasCacheFor(climbUuids: string[]): Map<string, string> {
  return new Map(climbUuids.map((uuid) => [`kilter:${uuid}`, uuid]));
}

type ApplyTx = Parameters<typeof applyCircuits>[0];
const applyTx = db as unknown as ApplyTx;

describe('applyCircuits legacy playlist adoption (real DB)', () => {
  afterEach(async () => {
    await db.execute(sql`
      DELETE FROM playlists p
      USING playlist_ownership po
      WHERE po.playlist_id = p.id AND po.user_id IN (${USER_ID}, ${OTHER_USER_ID})
    `);
    await db.execute(sql`DELETE FROM "users" WHERE id IN (${USER_ID}, ${OTHER_USER_ID})`);
  });

  // Guard the trap itself: without the global uniques the duplication this file
  // is named for cannot happen, and every test below would pass while testing
  // nothing.
  it('the global uniques on aurora_id and kilter_id exist in the test schema', async () => {
    const result = await db.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE indexname IN ('playlists_aurora_id_idx', 'playlists_kilter_id_idx')
      ORDER BY indexname
    `);
    const rows = Array.from(result as Iterable<{ indexname: string; indexdef: string }>);
    expect(rows.map((row) => row.indexname)).toEqual(['playlists_aurora_id_idx', 'playlists_kilter_id_idx']);
    for (const row of rows) {
      expect(row.indexdef).toContain('UNIQUE');
      // NON-partial. The moment either becomes `WHERE … IS NOT NULL` the NULL
      // that causes #4707 stops mattering and this file loses its point.
      expect(row.indexdef).not.toContain('WHERE');
    }
  });

  it('adopts the pre-split row in place instead of inserting a twin', async () => {
    await seedUser(USER_ID);
    const legacyId = await seedLegacyPlaylist({
      userId: USER_ID,
      uuid: 'legacy-uuid-1',
      auroraId: 'circuit-1',
      name: 'Warmups',
      description: 'my edited description',
      editedDaysAgo: 30,
      climbUuids: ['climb-A', 'climb-B'],
    });

    await applyCircuits(
      applyTx,
      USER_ID,
      [circuitPut({ circuitUuid: 'circuit-1', name: 'Warmups', description: 'kilter description' })],
      [circuitClimbPut({ circuitUuid: 'circuit-1', climbUuid: 'climb-C', position: 0 })],
      aliasCacheFor(['climb-C']),
    );

    const rows = await readPlaylists(USER_ID);
    expect(rows).toHaveLength(1);
    // Same physical row: the uuid is the offline-sync local PK that pins,
    // follows and every mobile client already point at.
    expect(String(rows[0].id)).toBe(String(legacyId));
    expect(rows[0].uuid).toBe('legacy-uuid-1');
    expect(rows[0].kilter_id).toBe('circuit-1');
    expect(rows[0].kilter_type).toBe('circuits');
    // Link-only: the user's Boardsesh-side content survives the adoption cycle.
    expect(rows[0].description).toBe('my edited description');
    expect(await readClimbs(legacyId)).toEqual(['climb-A', 'climb-B']);
  });

  it('adopts on the normalized name when the upstream id was rotated by a JSON import', async () => {
    await seedUser(USER_ID);
    const legacyId = await seedLegacyPlaylist({
      userId: USER_ID,
      uuid: 'legacy-uuid-2',
      auroraId: 'json-import-9f2c',
      name: '  Warmups  ',
      editedDaysAgo: 30,
    });

    await applyCircuits(applyTx, USER_ID, [circuitPut({ circuitUuid: 'circuit-1', name: 'warmups' })], [], new Map());

    const rows = await readPlaylists(USER_ID);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].id)).toBe(String(legacyId));
    expect(rows[0].kilter_id).toBe('circuit-1');
  });

  it('keeps the edited playlist frozen across later cycles instead of re-clobbering it', async () => {
    await seedUser(USER_ID);
    const legacyId = await seedLegacyPlaylist({
      userId: USER_ID,
      uuid: 'legacy-uuid-3',
      auroraId: 'circuit-1',
      name: 'Warmups',
      description: 'my edited description',
      editedDaysAgo: 30,
      climbUuids: ['climb-A'],
    });

    const ops = [circuitPut({ circuitUuid: 'circuit-1', name: 'Kilter Name', description: 'kilter description' })];
    const climbOps = [circuitClimbPut({ circuitUuid: 'circuit-1', climbUuid: 'climb-C', position: 0 })];

    // Cycle one adopts; cycle two goes down the ordinary ON CONFLICT path and
    // must be stopped by the edit-clobber guard.
    await applyCircuits(applyTx, USER_ID, ops, climbOps, aliasCacheFor(['climb-C']));
    await applyCircuits(applyTx, USER_ID, ops, climbOps, aliasCacheFor(['climb-C']));

    const rows = await readPlaylists(USER_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Warmups');
    expect(rows[0].description).toBe('my edited description');
    expect(await readClimbs(legacyId)).toEqual(['climb-A']);
  });

  it('applies Kilter content on the cycle after adopting a playlist the user never edited', async () => {
    await seedUser(USER_ID);
    // updated_at == aurora_synced_at: imported and never touched since.
    const legacyId = await seedLegacyPlaylist({
      userId: USER_ID,
      uuid: 'legacy-uuid-4',
      auroraId: 'circuit-1',
      name: 'Warmups',
      description: 'from the import',
      climbUuids: ['climb-A'],
    });

    const ops = [circuitPut({ circuitUuid: 'circuit-1', name: 'Kilter Name', description: 'kilter description' })];
    const climbOps = [circuitClimbPut({ circuitUuid: 'circuit-1', climbUuid: 'climb-C', position: 0 })];

    await applyCircuits(applyTx, USER_ID, ops, climbOps, aliasCacheFor(['climb-C']));
    await applyCircuits(applyTx, USER_ID, ops, climbOps, aliasCacheFor(['climb-C']));

    const rows = await readPlaylists(USER_ID);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].id)).toBe(String(legacyId));
    expect(rows[0].name).toBe('Kilter Name');
    expect(await readClimbs(legacyId)).toEqual(['climb-C']);
  });

  it('re-running the same batch never adds a row', async () => {
    await seedUser(USER_ID);
    await seedLegacyPlaylist({
      userId: USER_ID,
      uuid: 'legacy-uuid-5',
      auroraId: 'circuit-1',
      name: 'Warmups',
      editedDaysAgo: 30,
    });

    const ops = [circuitPut({ circuitUuid: 'circuit-1', name: 'Warmups' })];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await applyCircuits(applyTx, USER_ID, ops, [], new Map());
    }

    expect(await readPlaylists(USER_ID)).toHaveLength(1);
  });

  it('does not adopt another Boardsesh user’s legacy playlist', async () => {
    await seedUser(USER_ID);
    await seedUser(OTHER_USER_ID);
    const mineId = await seedLegacyPlaylist({
      userId: USER_ID,
      uuid: 'legacy-uuid-mine',
      auroraId: 'json-import-mine',
      name: 'Warmups',
      editedDaysAgo: 30,
    });
    const theirsId = await seedLegacyPlaylist({
      userId: OTHER_USER_ID,
      uuid: 'legacy-uuid-theirs',
      auroraId: 'json-import-theirs',
      name: 'Warmups',
      editedDaysAgo: 30,
    });

    await applyCircuits(applyTx, USER_ID, [circuitPut({ circuitUuid: 'circuit-1', name: 'Warmups' })], [], new Map());

    const mine = await readPlaylists(USER_ID);
    expect(mine).toHaveLength(1);
    expect(String(mine[0].id)).toBe(String(mineId));
    expect(mine[0].kilter_id).toBe('circuit-1');

    const theirs = await readPlaylists(OTHER_USER_ID);
    expect(theirs).toHaveLength(1);
    expect(String(theirs[0].id)).toBe(String(theirsId));
    expect(theirs[0].kilter_id).toBeNull();
  });

  it('inserts rather than guessing when two legacy playlists share a name', async () => {
    await seedUser(USER_ID);
    await seedLegacyPlaylist({
      userId: USER_ID,
      uuid: 'legacy-uuid-a',
      auroraId: 'json-import-a',
      name: 'Warmups',
      editedDaysAgo: 30,
    });
    await seedLegacyPlaylist({
      userId: USER_ID,
      uuid: 'legacy-uuid-b',
      auroraId: 'json-import-b',
      name: 'warmups',
      editedDaysAgo: 30,
    });

    await applyCircuits(applyTx, USER_ID, [circuitPut({ circuitUuid: 'circuit-1', name: 'Warmups' })], [], new Map());

    const rows = await readPlaylists(USER_ID);
    // Ambiguous, so nothing is merged: three rows, both originals untouched.
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.kilter_id === 'circuit-1')).toHaveLength(1);
    expect(rows.filter((row) => row.uuid.startsWith('legacy-uuid-')).every((row) => row.kilter_id === null)).toBe(true);
  });

  it('leaves a Boardsesh-native playlist alone even when the names match', async () => {
    await seedUser(USER_ID);
    // No upstream origin at all — built by hand in Boardsesh.
    const inserted = await db.execute(sql`
      INSERT INTO playlists (uuid, board_type, name, is_public, created_at, updated_at)
      VALUES ('native-uuid-1', 'kilter', 'Warmups', false, now() - interval '10 days', now() - interval '1 day')
      RETURNING id
    `);
    const nativeId = BigInt(String(Array.from(inserted as Iterable<{ id: string | number }>)[0].id));
    await db.execute(sql`
      INSERT INTO playlist_ownership (playlist_id, user_id, role) VALUES (${nativeId}, ${USER_ID}, 'owner')
    `);

    await applyCircuits(applyTx, USER_ID, [circuitPut({ circuitUuid: 'circuit-1', name: 'Warmups' })], [], new Map());

    const rows = await readPlaylists(USER_ID);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.uuid === 'native-uuid-1')?.kilter_id).toBeNull();
  });
});
