import { describe, it, expect, beforeEach, afterAll } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { playlistMutations } from '../graphql/resolvers/playlists/mutations';

// Integration test (real DB) for #3993: addClimbToPlaylist did a plain
// pre-check SELECT for an existing (playlistId, climbUuid) row, and only
// opened a transaction afterward to assign a position and insert. Two
// concurrent calls for the same not-yet-present climb both see an empty
// pre-check, both reach the INSERT, and the loser hits the
// `unique_playlist_climb` unique index as a raw 23505 unique-violation
// instead of the intended idempotent no-op. Seeds use raw `sql` because the
// test DB is a minimal DDL (schema-sql.ts), so a builder insert
// over-specifies columns — same pattern as playlist-reorder-integration.test.ts.

const PLAYLIST_UUID = 'pl-race-3993';
const OWNER_ID = 'user-123'; // seeded by setup.ts

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'conn-1',
    isAuthenticated: true,
    userId: OWNER_ID,
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
    ...overrides,
  } as ConnectionContext;
}

async function playlistClimbRows(climbUuid: string): Promise<{ id: string; position: number }[]> {
  const result = await db.execute(sql`
    SELECT id, position FROM playlist_climbs
    WHERE playlist_id = 1 AND climb_uuid = ${climbUuid}
  `);
  return Array.from(result as Iterable<{ id: string; position: number }>);
}

describe('addClimbToPlaylist — real DB (#3993)', () => {
  // Playlist tables aren't in setup.ts's per-file reset list, so own the reset.
  // RESTART IDENTITY frees id=1 for a stable, trivially-referenced playlist.
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE playlist_climbs, playlist_ownership, playlists RESTART IDENTITY CASCADE`);
    await db.execute(sql`
      INSERT INTO playlists (id, uuid, board_type, layout_id, name, is_public)
      VALUES (1, ${PLAYLIST_UUID}, 'kilter', 1, 'Race', true)
    `);
    await db.execute(sql`
      INSERT INTO playlist_ownership (playlist_id, user_id)
      VALUES (1, ${OWNER_ID})
    `);
  });

  afterAll(async () => {
    await db.execute(sql`TRUNCATE TABLE playlist_climbs, playlist_ownership, playlists RESTART IDENTITY CASCADE`);
  });

  it('resolves both concurrent adds of the same climb without throwing, inserting exactly one row', async () => {
    // Fires two genuinely concurrent DB round-trips (Promise.all, not
    // sequential awaits). On the pre-fix check-then-insert code, one of the
    // two branches throws a raw 23505 unique-violation instead of
    // resolving — reverting the fix reproduces that throw here.
    const [resultA, resultB] = await Promise.all([
      playlistMutations.addClimbToPlaylist(
        null,
        { input: { playlistId: PLAYLIST_UUID, climbUuid: 'climb-racer', angle: 40 } },
        makeCtx(),
      ),
      playlistMutations.addClimbToPlaylist(
        null,
        { input: { playlistId: PLAYLIST_UUID, climbUuid: 'climb-racer', angle: 40 } },
        makeCtx(),
      ),
    ]);

    const rows = await playlistClimbRows('climb-racer');
    expect(rows).toHaveLength(1);

    // Both results describe the same underlying row.
    expect(resultA).toMatchObject({ climbUuid: 'climb-racer', position: rows[0].position });
    expect(resultB).toMatchObject({ climbUuid: 'climb-racer', position: rows[0].position });
    expect((resultA as { id: string }).id).toBe((resultB as { id: string }).id);
  });

  it('inserts both rows without error when two different climbs are added concurrently', async () => {
    // `position` has no unique constraint (playlist_climbs_position_idx is a
    // plain index, not unique) — two racers can legitimately compute the same
    // maxPosition under READ COMMITTED and both land on it. Every read path
    // (playlist-climbs.ts, playlist-reorder-integration.test.ts's own
    // orderedClimbs helper) already orders by `(position ASC, added_at ASC)`,
    // so a duplicate position resolves deterministically via addedAt and
    // never breaks display order. This test guards that neither insert
    // throws and both rows persist — not position uniqueness, which the
    // schema doesn't provide and the codebase doesn't require.
    const [resultA, resultB] = await Promise.all([
      playlistMutations.addClimbToPlaylist(
        null,
        { input: { playlistId: PLAYLIST_UUID, climbUuid: 'climb-one', angle: 40 } },
        makeCtx(),
      ),
      playlistMutations.addClimbToPlaylist(
        null,
        { input: { playlistId: PLAYLIST_UUID, climbUuid: 'climb-two', angle: 40 } },
        makeCtx(),
      ),
    ]);

    const rows = await db.execute(sql`
      SELECT climb_uuid, position FROM playlist_climbs
      WHERE playlist_id = 1
      ORDER BY position ASC, added_at ASC
    `);
    const materializedRows = Array.from(rows as Iterable<{ climb_uuid: string; position: number }>);

    expect(materializedRows).toHaveLength(2);
    expect(materializedRows.map((row) => row.climb_uuid).sort()).toEqual(['climb-one', 'climb-two']);
    expect([resultA, resultB].map((result) => (result as { climbUuid: string }).climbUuid).sort()).toEqual([
      'climb-one',
      'climb-two',
    ]);
  });

  it('returns the pre-existing row unchanged when the climb is already present (no duplicate insert, no position bump)', async () => {
    await db.execute(sql`
      INSERT INTO playlist_climbs (playlist_id, climb_uuid, angle, position)
      VALUES (1, 'climb-existing', 40, 7)
    `);
    const [seededRow] = await playlistClimbRows('climb-existing');

    const result = (await playlistMutations.addClimbToPlaylist(
      null,
      { input: { playlistId: PLAYLIST_UUID, climbUuid: 'climb-existing', angle: 40 } },
      makeCtx(),
    )) as { id: string; position: number };

    expect(result.id).toBe(seededRow.id);
    expect(result.position).toBe(7);

    const rows = await playlistClimbRows('climb-existing');
    expect(rows).toHaveLength(1);
  });
});
