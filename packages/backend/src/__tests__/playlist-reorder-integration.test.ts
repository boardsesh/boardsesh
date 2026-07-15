import { describe, it, expect, beforeEach, afterAll } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { playlistMutations } from '../graphql/resolvers/playlists/mutations';

// Integration test (real DB) for #3607: the batched reorder UPDATE cast its
// CASE `THEN` positions as untyped params, so Postgres typed the CASE `text` and
// rejected the assignment to the integer `position` column (42804). The mocked
// playlist-reorder.test.ts only checks the `.set()` shape, never running the SQL
// — this drives the real statement. Seeds use raw `sql` because the test DB is a
// minimal DDL (schema-sql.ts), so a builder insert over-specifies columns.

const PLAYLIST_UUID = 'pl-reorder-3607';
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

async function orderedClimbs(): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT climb_uuid FROM playlist_climbs
    WHERE playlist_id = 1
    ORDER BY position ASC, added_at ASC
  `);
  return Array.from(result as Iterable<{ climb_uuid: string }>).map((row) => row.climb_uuid);
}

describe('reorderPlaylistClimb — real DB (#3607)', () => {
  // Playlist tables aren't in setup.ts's per-file reset list, so own the reset.
  // RESTART IDENTITY frees id=1 for a stable, trivially-referenced playlist.
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE playlist_climbs, playlist_ownership, playlists RESTART IDENTITY CASCADE`);
    await db.execute(sql`
      INSERT INTO playlists (id, uuid, board_type, layout_id, name, is_public)
      VALUES (1, ${PLAYLIST_UUID}, 'kilter', 1, 'Reorder', true)
    `);
    await db.execute(sql`
      INSERT INTO playlist_ownership (playlist_id, user_id)
      VALUES (1, ${OWNER_ID})
    `);
    await db.execute(sql`
      INSERT INTO playlist_climbs (playlist_id, climb_uuid, angle, position)
      VALUES (1, 'climb-a', 40, 0), (1, 'climb-b', 40, 1), (1, 'climb-c', 40, 2)
    `);
  });

  afterAll(async () => {
    await db.execute(sql`TRUNCATE TABLE playlist_climbs, playlist_ownership, playlists RESTART IDENTITY CASCADE`);
  });

  it('persists a move to the front (the batched CASE update that threw 42804)', async () => {
    const result = await playlistMutations.reorderPlaylistClimb(
      null,
      { input: { playlistId: PLAYLIST_UUID, climbUuid: 'climb-c', newIndex: 0 } },
      makeCtx(),
    );

    expect(result).toBe(true);
    expect(await orderedClimbs()).toEqual(['climb-c', 'climb-a', 'climb-b']);
  });

  it('persists an interior move', async () => {
    const result = await playlistMutations.reorderPlaylistClimb(
      null,
      { input: { playlistId: PLAYLIST_UUID, climbUuid: 'climb-a', newIndex: 2 } },
      makeCtx(),
    );

    expect(result).toBe(true);
    expect(await orderedClimbs()).toEqual(['climb-b', 'climb-c', 'climb-a']);
  });

  it('is a no-op when the climb is already at the target index', async () => {
    const result = await playlistMutations.reorderPlaylistClimb(
      null,
      { input: { playlistId: PLAYLIST_UUID, climbUuid: 'climb-a', newIndex: 0 } },
      makeCtx(),
    );

    expect(result).toBe(true);
    expect(await orderedClimbs()).toEqual(['climb-a', 'climb-b', 'climb-c']);
  });

  it('rejects a non-owner and leaves the order untouched', async () => {
    await expect(
      playlistMutations.reorderPlaylistClimb(
        null,
        { input: { playlistId: PLAYLIST_UUID, climbUuid: 'climb-c', newIndex: 0 } },
        makeCtx({ userId: 'not-the-owner' }),
      ),
    ).rejects.toThrow('do not have permission');

    expect(await orderedClimbs()).toEqual(['climb-a', 'climb-b', 'climb-c']);
  });
});
