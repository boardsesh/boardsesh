import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';

// saveTick fires side effects after a real insert. We keep the REAL db so the
// UUID idempotency path runs against Postgres, but stub recompute so we can
// assert it runs exactly once per distinct tick and never on replay.
const recomputeSpy = vi.fn();
// The inline (#4798) recompute gets its own spy so the replay test can prove it
// fires once per REAL insert too, not on the conflict no-op replay.
const inlineRecomputeSpy = vi.fn();

vi.mock('../graphql/resolvers/ticks/debounced-climb-stats-publisher', () => ({
  queueClimbStatsRecompute: (...args: unknown[]) => recomputeSpy(...args),
  recomputeClimbStatsNow: async (...args: unknown[]) => {
    inlineRecomputeSpy(...args);
  },
}));

import { db } from '../db/client';
import { tickMutations } from '../graphql/resolvers/ticks/mutations';
import { favoriteMutations } from '../graphql/resolvers/favorites/mutations';
import { playlistMutations } from '../graphql/resolvers/playlists/mutations';
import { logger } from '../utils/logger';

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

type TickRow = { uuid: string; status: string; comment: string; sessionId: string | null };

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

describe('toggleFavorite insert-first upsert', () => {
  const fav = { boardName: 'kilter', climbUuid: 'toggle-climb-1', angle: 40 };

  async function favoriteCount(): Promise<number> {
    const rows = await db.execute(sql`
      SELECT count(*)::int AS count FROM user_favorites
      WHERE user_id = ${USER_ID} AND board_name = ${fav.boardName}
        AND climb_uuid = ${fav.climbUuid} AND angle = ${fav.angle}
    `);
    return Number((rows as unknown as Array<{ count: number }>)[0].count);
  }

  it('toggles on then off: true with one row, then false with zero rows', async () => {
    const on = await favoriteMutations.toggleFavorite(undefined, { input: fav }, ctx());
    expect(on).toEqual({ favorited: true });
    expect(await favoriteCount()).toBe(1);

    const off = await favoriteMutations.toggleFavorite(undefined, { input: fav }, ctx());
    expect(off).toEqual({ favorited: false });
    expect(await favoriteCount()).toBe(0);
  });

  it('removes a favorite created via addFavorite (conflict path, not a unique violation)', async () => {
    await favoriteMutations.addFavorite(undefined, { input: fav }, ctx());

    const result = await favoriteMutations.toggleFavorite(undefined, { input: fav }, ctx());
    expect(result).toEqual({ favorited: false });
    expect(await favoriteCount()).toBe(0);
  });
});

describe('deleteTick / updateTick typed errors', () => {
  const missingUuid = '99999999-9999-4999-8999-999999999999';
  const OTHER_USER = 'sync-mut-other-user';

  async function expectGraphQLCode(promise: Promise<unknown>, code: string): Promise<void> {
    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }
    expect(caught, `expected a GraphQLError with code ${code}`).toBeDefined();
    const extensions = (caught as { extensions?: { code?: string } }).extensions;
    expect(extensions?.code).toBe(code);
  }

  async function saveTickAs(userId: string): Promise<string> {
    const saved = (await tickMutations.saveTick(
      undefined,
      {
        input: {
          boardType: 'kilter',
          climbUuid: 'typed-error-climb',
          angle: 40,
          isMirror: false,
          status: 'flash' as const,
          attemptCount: 1,
          isBenchmark: false,
          comment: 'typed-error fixture',
          climbedAt: new Date('2026-05-01T10:00:00Z').toISOString(),
        },
      },
      ctx(userId),
    )) as TickRow;
    return saved.uuid;
  }

  it('deleteTick on a missing uuid throws TICK_NOT_FOUND', async () => {
    await expectGraphQLCode(tickMutations.deleteTick(undefined, { uuid: missingUuid }, ctx()), 'TICK_NOT_FOUND');
  });

  it("deleteTick on another user's tick throws FORBIDDEN", async () => {
    await insertUser(OTHER_USER);
    const uuid = await saveTickAs(OTHER_USER);
    await expectGraphQLCode(tickMutations.deleteTick(undefined, { uuid }, ctx()), 'FORBIDDEN');
  });

  it('updateTick on a missing uuid throws TICK_NOT_FOUND', async () => {
    await expectGraphQLCode(
      tickMutations.updateTick(undefined, { uuid: missingUuid, input: { comment: 'nope' } }, ctx()),
      'TICK_NOT_FOUND',
    );
  });

  it("updateTick on another user's tick throws FORBIDDEN", async () => {
    await insertUser(OTHER_USER);
    const uuid = await saveTickAs(OTHER_USER);
    await expectGraphQLCode(
      tickMutations.updateTick(undefined, { uuid, input: { comment: 'nope' } }, ctx()),
      'FORBIDDEN',
    );
  });
});

describe('saveTick persistence and idempotent replay', () => {
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
    expect(inlineRecomputeSpy).toHaveBeenCalledTimes(1);
  });

  it('omitting uuid generates a fresh server uuid per call (two distinct rows)', async () => {
    const a = (await tickMutations.saveTick(undefined, { input: baseInput }, ctx())) as TickRow;
    const b = (await tickMutations.saveTick(undefined, { input: baseInput }, ctx())) as TickRow;

    expect(a.uuid).not.toBe(b.uuid);
    expect(recomputeSpy).toHaveBeenCalledTimes(2);
    expect(inlineRecomputeSpy).toHaveBeenCalledTimes(2);
  });

  it('preserves six climbedAt fractional digits while normalizing its offset', async () => {
    const saved = (await tickMutations.saveTick(
      undefined,
      { input: { ...baseInput, climbedAt: '2026-05-02T01:02:03.123456-07:00' } },
      ctx(),
    )) as TickRow;

    const rows = await db.execute(sql`
      SELECT climbed_at::text AS climbed_at
      FROM boardsesh_ticks
      WHERE uuid = ${saved.uuid}
    `);
    expect(rows).toEqual([{ climbed_at: '2026-05-02 08:02:03.123456' }]);
  });
});

// Regression coverage for #2386: a stale/unknown sessionId must never lose the
// tick to a raw FK violation. Runs against the real Postgres FK so a
// regression here reproduces the original bug (INSERT rejected), not just a
// mock mismatch.
describe('saveTick with a stale sessionId (#2386)', () => {
  function buildInput(climbUuid: string) {
    return {
      boardType: 'kilter',
      climbUuid,
      angle: 40,
      isMirror: false,
      status: 'attempt' as const,
      attemptCount: 1,
      isBenchmark: false,
      comment: 'session fk regression',
      climbedAt: new Date('2026-05-25T02:43:00Z').toISOString(),
    };
  }

  async function insertSession(id: string): Promise<void> {
    await db.execute(sql`
      INSERT INTO "board_sessions" (id, board_path)
      VALUES (${id}, ${'/kilter/1/2/3/40'})
      ON CONFLICT (id) DO NOTHING
    `);
  }

  async function deleteSession(id: string): Promise<void> {
    await db.execute(sql`DELETE FROM "board_sessions" WHERE id = ${id}`);
  }

  async function deleteTick(uuid: string): Promise<void> {
    await db.execute(sql`DELETE FROM boardsesh_ticks WHERE uuid = ${uuid}`);
  }

  it('drops a nonexistent sessionId and still saves the tick', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const staleSessionId = 'session-that-never-existed-2386';

    let result: TickRow | undefined;
    try {
      result = (await tickMutations.saveTick(
        undefined,
        { input: { ...buildInput('tick-climb-session-fk-missing'), sessionId: staleSessionId } },
        ctx(),
      )) as TickRow;

      expect(result.sessionId).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(staleSessionId));

      const rows = await db.execute(sql`
        SELECT session_id FROM boardsesh_ticks WHERE uuid = ${result.uuid}
      `);
      expect((rows as unknown as Array<{ session_id: string | null }>)[0].session_id).toBeNull();
    } finally {
      warnSpy.mockRestore();
      if (result) await deleteTick(result.uuid);
    }
  });

  it('keeps a real sessionId association', async () => {
    const sessionId = 'session-2386-real';
    await insertSession(sessionId);

    let result: TickRow | undefined;
    try {
      result = (await tickMutations.saveTick(
        undefined,
        { input: { ...buildInput('tick-climb-session-fk-real'), sessionId } },
        ctx(),
      )) as TickRow;

      expect(result.sessionId).toBe(sessionId);

      const rows = await db.execute(sql`
        SELECT session_id FROM boardsesh_ticks WHERE uuid = ${result.uuid}
      `);
      expect((rows as unknown as Array<{ session_id: string | null }>)[0].session_id).toBe(sessionId);
    } finally {
      if (result) await deleteTick(result.uuid);
      await deleteSession(sessionId);
    }
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

  it('skips the tombstone when playlist_ownership is orphaned (never emits a global NULL-scope row)', async () => {
    const orphanUuid = '55555555-5555-4555-8555-555555555555';
    await playlistMutations.createPlaylist(
      undefined,
      { input: { uuid: orphanUuid, boardType: 'kilter', layoutId: 1, name: 'Orphaned' } },
      ctx(),
    );

    const playlistIdRows = (await db.execute(sql`
      SELECT id FROM playlists WHERE uuid = ${orphanUuid}
    `)) as unknown as Array<{ id: string | number }>;
    const playlistId = playlistIdRows[0].id;

    await db.execute(sql`
      INSERT INTO playlist_climbs (playlist_id, climb_uuid, angle, position)
      VALUES (${playlistId}, ${'climb-orphan'}, 40, 0)
    `);

    // Orphan the playlist, then delete the climb row directly (the only path
    // that reaches the owner lookup with no ownership row).
    await db.execute(sql`DELETE FROM playlist_ownership WHERE playlist_id = ${playlistId}`);
    await db.execute(sql`DELETE FROM playlist_climbs WHERE playlist_id = ${playlistId}`);

    // sync_deletions.user_id = NULL means "visible to ALL clients"; an orphaned
    // ownership must skip the tombstone entirely rather than emit a global one.
    const climbTombstones = (await db.execute(sql`
      SELECT count(*)::int AS count FROM sync_deletions WHERE table_name = 'playlist_climbs'
    `)) as unknown as Array<{ count: number }>;
    expect(Number(climbTombstones[0].count)).toBe(0);
  });

  it('skips the playlist-level tombstone too when ownership is orphaned (0147 parity guard)', async () => {
    const orphanUuid = '66666666-6666-4666-8666-666666666666';
    await playlistMutations.createPlaylist(
      undefined,
      { input: { uuid: orphanUuid, boardType: 'kilter', layoutId: 1, name: 'Orphaned Parent' } },
      ctx(),
    );

    const playlistIdRows = (await db.execute(sql`
      SELECT id FROM playlists WHERE uuid = ${orphanUuid}
    `)) as unknown as Array<{ id: string | number }>;
    const playlistId = playlistIdRows[0].id;

    // Orphan the playlist, then delete it directly — deletePlaylist requires an
    // owner, so raw SQL is the only path that reaches the trigger ownerless.
    await db.execute(sql`DELETE FROM playlist_ownership WHERE playlist_id = ${playlistId}`);
    await db.execute(sql`DELETE FROM playlists WHERE id = ${playlistId}`);

    const playlistTombstones = (await db.execute(sql`
      SELECT count(*)::int AS count FROM sync_deletions
      WHERE table_name = 'playlists' AND record_id = ${orphanUuid}
    `)) as unknown as Array<{ count: number }>;
    expect(Number(playlistTombstones[0].count)).toBe(0);
  });
});

describe('board_climbs deletion tombstone (reference data)', () => {
  const climbUuid = '44444444-4444-4444-8444-444444444444';

  it('deleting a board climb logs a tombstone with user_id NULL (reference-data scope)', async () => {
    // Raw insert/delete: there is no climb-deletion mutation — catalog rows are
    // removed by ingest jobs — but the trigger must still tombstone them so
    // offline clients drop the row on their next deletions pull.
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, name)
      VALUES (${climbUuid}, 'kilter', 1, 'Trigger Fixture')
    `);
    await db.execute(sql`DELETE FROM board_climbs WHERE uuid = ${climbUuid}`);

    const tombstones = (await db.execute(sql`
      SELECT record_id, user_id FROM sync_deletions WHERE table_name = 'board_climbs'
    `)) as unknown as Array<{ record_id: string; user_id: string | null }>;
    expect(tombstones.length).toBe(1);
    expect(tombstones[0].record_id).toBe(climbUuid);
    expect(tombstones[0].user_id).toBeNull();
  });
});
