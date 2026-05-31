import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';

// saveTick fires several side effects (inferred-session assignment, stats
// recompute). We keep the REAL db so the ON CONFLICT (uuid) idempotency path
// runs against Postgres, but stub the fire-and-forget side effects so we can
// assert they run exactly once per distinct tick (and never on replay).
const inferredSessionSpy = vi.fn().mockResolvedValue(undefined);
const recomputeSpy = vi.fn();

vi.mock('../jobs/inferred-session-builder', () => ({
  assignInferredSession: (...args: unknown[]) => inferredSessionSpy(...args),
}));

vi.mock('../graphql/resolvers/ticks/debounced-climb-stats-publisher', () => ({
  queueClimbStatsRecompute: (...args: unknown[]) => recomputeSpy(...args),
}));

import { db } from '../db/client';
import { tickMutations } from '../graphql/resolvers/ticks/mutations';
import { favoriteMutations } from '../graphql/resolvers/favorites/mutations';
import { playlistMutations } from '../graphql/resolvers/playlists/mutations';

const USER_ID = 'sync-mut-user';

function ctx(userId: string = USER_ID): ConnectionContext {
  return {
    connectionId: 'sync-mut-conn',
    isAuthenticated: true,
    userId,
    sessionId: null,
    controllerId: null,
    controllerApiKey: null,
  } as unknown as ConnectionContext;
}

async function insertUser(id: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'Test ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

type TickRow = { uuid: string; status: string; comment: string };

const fixedUuid = '11111111-1111-4111-8111-111111111111';

beforeEach(async () => {
  vi.clearAllMocks();
  // Clear the sync write surface so row-count assertions below are deterministic
  // across tests (the shared setup only truncates session tables per test).
  await db.execute(sql`
    TRUNCATE TABLE sync_deletions, user_favorites, playlist_climbs, playlist_ownership, playlists, boardsesh_ticks
    RESTART IDENTITY CASCADE
  `);
  await insertUser(USER_ID);
});

describe('addFavorite / removeFavorite idempotency', () => {
  const fav = { boardName: 'kilter', climbUuid: 'fav-climb-1', angle: 40 };

  it('addFavorite is idempotent: double-add yields exactly one row', async () => {
    const first = await favoriteMutations.addFavorite(undefined, { input: fav }, ctx());
    const second = await favoriteMutations.addFavorite(undefined, { input: fav }, ctx());

    expect(first).toBe(true);
    expect(second).toBe(true);

    const rows = await db.execute(sql`
      SELECT count(*)::int AS count FROM user_favorites
      WHERE user_id = ${USER_ID} AND board_name = ${fav.boardName}
        AND climb_uuid = ${fav.climbUuid} AND angle = ${fav.angle}
    `);
    expect(Number((rows as unknown as Array<{ count: number }>)[0].count)).toBe(1);
  });

  it('removeFavorite on a nonexistent row is a no-op (no error, returns true)', async () => {
    const result = await favoriteMutations.removeFavorite(
      undefined,
      { input: { boardName: 'tension', climbUuid: 'never-existed', angle: 25 } },
      ctx(),
    );
    expect(result).toBe(true);
  });

  it('add then remove leaves zero rows; a second remove is still a no-op', async () => {
    await favoriteMutations.addFavorite(undefined, { input: fav }, ctx());
    await favoriteMutations.removeFavorite(undefined, { input: fav }, ctx());
    await favoriteMutations.removeFavorite(undefined, { input: fav }, ctx());

    const rows = await db.execute(sql`
      SELECT count(*)::int AS count FROM user_favorites WHERE user_id = ${USER_ID}
    `);
    expect(Number((rows as unknown as Array<{ count: number }>)[0].count)).toBe(0);
  });
});

describe('saveTick idempotent replay', () => {
  const baseInput = {
    boardType: 'kilter',
    climbUuid: 'tick-climb-1',
    angle: 40,
    isMirror: false,
    status: 'attempt' as const,
    attemptCount: 3,
    isBenchmark: false,
    comment: 'first try',
    climbedAt: new Date('2026-05-01T10:00:00Z').toISOString(),
  };

  it('replaying the same client uuid yields one row and fires side effects once', async () => {
    const input = { ...baseInput, uuid: fixedUuid };

    const first = (await tickMutations.saveTick(undefined, { input }, ctx())) as TickRow;
    // A naive retry would change the comment; the stored (original) row must win.
    const second = (await tickMutations.saveTick(
      undefined,
      { input: { ...input, comment: 'second try (should be ignored)' } },
      ctx(),
    )) as TickRow;

    expect(first.uuid).toBe(fixedUuid);
    expect(second.uuid).toBe(fixedUuid);
    // Replay returns the ORIGINAL row, not the mutated input.
    expect(second.comment).toBe('first try');

    const rows = await db.execute(sql`
      SELECT count(*)::int AS count FROM boardsesh_ticks WHERE uuid = ${fixedUuid}
    `);
    expect(Number((rows as unknown as Array<{ count: number }>)[0].count)).toBe(1);

    // Side effects fired for the real insert, NOT for the conflict no-op replay.
    expect(recomputeSpy).toHaveBeenCalledTimes(1);
    expect(inferredSessionSpy).toHaveBeenCalledTimes(1);
  });

  it('omitting uuid generates a fresh server uuid per call (two distinct rows)', async () => {
    const a = (await tickMutations.saveTick(undefined, { input: baseInput }, ctx())) as TickRow;
    const b = (await tickMutations.saveTick(undefined, { input: baseInput }, ctx())) as TickRow;

    expect(a.uuid).not.toBe(b.uuid);
    expect(recomputeSpy).toHaveBeenCalledTimes(2);
  });
});

describe('createPlaylist idempotent replay', () => {
  const playlistUuid = '22222222-2222-4222-8222-222222222222';
  const baseInput = {
    uuid: playlistUuid,
    boardType: 'kilter',
    layoutId: 1,
    name: 'Projects',
  };

  type PlaylistResult = { uuid: string; name: string; userRole: string | null };

  it('replaying the same client uuid yields one playlist + one ownership row', async () => {
    const first = (await playlistMutations.createPlaylist(undefined, { input: baseInput }, ctx())) as PlaylistResult;
    const second = (await playlistMutations.createPlaylist(
      undefined,
      { input: { ...baseInput, name: 'Renamed (ignored)' } },
      ctx(),
    )) as PlaylistResult;

    expect(first.uuid).toBe(playlistUuid);
    expect(second.uuid).toBe(playlistUuid);
    // Replay returns the ORIGINAL playlist, name unchanged.
    expect(second.name).toBe('Projects');
    expect(second.userRole).toBe('owner');

    const playlistRows = await db.execute(sql`
      SELECT count(*)::int AS count FROM playlists WHERE uuid = ${playlistUuid}
    `);
    expect(Number((playlistRows as unknown as Array<{ count: number }>)[0].count)).toBe(1);

    const ownershipRows = await db.execute(sql`
      SELECT count(*)::int AS count FROM playlist_ownership po
      JOIN playlists p ON p.id = po.playlist_id
      WHERE p.uuid = ${playlistUuid}
    `);
    expect(Number((ownershipRows as unknown as Array<{ count: number }>)[0].count)).toBe(1);
  });
});

describe('deletePlaylist with climbs (cascade deletion trigger)', () => {
  const playlistUuid = '33333333-3333-4333-8333-333333333333';

  it('deletes a playlist that has climbs without aborting, and logs an owner-scoped tombstone', async () => {
    await playlistMutations.createPlaylist(
      undefined,
      { input: { uuid: playlistUuid, boardType: 'kilter', layoutId: 1, name: 'To Delete' } },
      ctx(),
    );

    const playlistIdRows = (await db.execute(sql`
      SELECT id FROM playlists WHERE uuid = ${playlistUuid}
    `)) as unknown as Array<{ id: string | number }>;
    const playlistId = playlistIdRows[0].id;

    // Two climbs so the FK cascade fires the playlist_climbs deletion trigger per row
    // after the parent playlists row is already gone — the exact path that used to abort.
    await db.execute(sql`
      INSERT INTO playlist_climbs (playlist_id, climb_uuid, angle, position)
      VALUES (${playlistId}, ${'climb-a'}, 40, 0), (${playlistId}, ${'climb-b'}, 40, 1)
    `);

    const result = await playlistMutations.deletePlaylist(undefined, { playlistId: playlistUuid }, ctx());
    expect(result).toBe(true);

    const remaining = (await db.execute(sql`
      SELECT count(*)::int AS count FROM playlists WHERE uuid = ${playlistUuid}
    `)) as unknown as Array<{ count: number }>;
    expect(Number(remaining[0].count)).toBe(0);

    // Playlist-level tombstone is owner-scoped (not NULL) — BEFORE DELETE captured the owner.
    const playlistTombstones = (await db.execute(sql`
      SELECT user_id FROM sync_deletions
      WHERE table_name = 'playlists' AND record_id = ${playlistUuid}
    `)) as unknown as Array<{ user_id: string | null }>;
    expect(playlistTombstones.length).toBe(1);
    expect(playlistTombstones[0].user_id).toBe(USER_ID);

    // Per-climb tombstones are skipped in the whole-playlist cascade (guard on NULL parent),
    // so the child trigger neither errors nor emits redundant records.
    const climbTombstones = (await db.execute(sql`
      SELECT count(*)::int AS count FROM sync_deletions WHERE table_name = 'playlist_climbs'
    `)) as unknown as Array<{ count: number }>;
    expect(Number(climbTombstones[0].count)).toBe(0);
  });
});
