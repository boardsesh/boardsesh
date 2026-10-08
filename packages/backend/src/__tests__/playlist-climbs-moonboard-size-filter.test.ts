import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { users, playlistOwnership } from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { playlistQueries } from '../graphql/resolvers/playlists/queries';
import { setterFollowQueries } from '../graphql/resolvers/social/setter-follows';

// Seeds use raw `sql` rather than `db.insert(...)` because the integration test
// DB is built from a minimal hand-maintained DDL (schema-sql.ts), not the full
// Drizzle schema — the query builder emits every default-bearing column (e.g.
// quality_normalized) which that DDL omits, so a builder insert fails. Naming
// only the columns the test DDL declares is the genuine raw-SQL exception.

// Integration test (real DB) for the MoonBoard playlist-activation bug: the
// specific-board playlistClimbs query filtered on compatible_size_ids, which
// MoonBoard climbs never have populated (single fixed size), so `1 = ANY(NULL)`
// dropped every row and activating a playlist climb left the queue with only
// the tapped climb. The size filter must skip non-size-scoped boards while
// still applying to Aurora boards. setterClimbsFull had the identical filter.

const MOON_PLAYLIST_UUID = 'pl-moon-size-filter';
const KILTER_PLAYLIST_UUID = 'pl-kilter-size-filter';

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'conn-1',
    isAuthenticated: false,
    userId: null,
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
    ...overrides,
  } as ConnectionContext;
}

async function seedClimb(boardType: string, uuid: string, name: string, setter: string, sizeIdsSql: string) {
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, description, frames, is_listed, compatible_size_ids)
    VALUES (${uuid}, ${boardType}, 1, ${setter}, ${name}, '', 'p1r1', true, ${sql.raw(sizeIdsSql)})
  `);
}

async function seedStats(boardType: string, uuid: string, angle: number, displayDifficulty: number, ascents: number) {
  await db.execute(sql`
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, difficulty_average, quality_average, ascensionist_count, benchmark_difficulty)
    VALUES (${boardType}, ${uuid}, ${angle}, ${displayDifficulty}, ${displayDifficulty}, 3.0, ${ascents}, 0)
  `);
}

describe('playlistClimbs / setterClimbsFull — size filter skips non-size-scoped boards (real DB)', () => {
  beforeAll(async () => {
    // Playlist tables aren't in the global per-file reset list, so own the
    // cleanup. Truncating is safe here: every vitest worker runs against its own
    // throwaway database (worker-db.ts, keyed on VITEST_POOL_ID) and files
    // inside a worker run one at a time, so no other file is mid-seed.
    await db.execute(sql`TRUNCATE TABLE playlist_climbs, playlist_ownership, playlists RESTART IDENTITY CASCADE`);

    // MoonBoard climbs: compatible_size_ids stays NULL, as in production —
    // populate-denormalized-columns skips the size-edges step for moonboard.
    await seedClimb('moonboard', 'moon-climb-1', 'Moon one', 'moon-setter', 'NULL');
    await seedStats('moonboard', 'moon-climb-1', 40, 20, 50);
    await seedClimb('moonboard', 'moon-climb-2', 'Moon two', 'moon-setter', 'NULL');
    await seedStats('moonboard', 'moon-climb-2', 40, 22, 30);

    // Kilter climbs: one compatible with size 10, one only with size 99 — the
    // size filter must still apply to size-scoped boards. The size-10 climb has
    // stats ONLY at 50°, so a 40° request also exercises the most-ascents
    // fallback the specific-board path gained by moving onto hydrateClimbsByRefs.
    await seedClimb('kilter', 'kilter-sized-climb', 'Fits size 10', 'kilter-setter', 'ARRAY[10]::integer[]');
    await seedStats('kilter', 'kilter-sized-climb', 50, 18, 100);
    await seedClimb('kilter', 'kilter-other-size-climb', 'Fits size 99 only', 'kilter-setter', 'ARRAY[99]::integer[]');
    await seedStats('kilter', 'kilter-other-size-climb', 40, 19, 80);

    await db.execute(sql`
      INSERT INTO playlists (id, uuid, board_type, layout_id, name, is_public)
      VALUES (1, ${MOON_PLAYLIST_UUID}, 'moonboard', 1, 'Moon circuit', true),
             (2, ${KILTER_PLAYLIST_UUID}, 'kilter', 1, 'Kilter circuit', true)
    `);
    // Public discovery still requires a real owner whose account permits it.
    const ownerId = 'playlist-climbs-moonboard-size-filter-owner';
    await db
      .insert(users)
      .values({ id: ownerId, email: `${ownerId}@test.invalid` })
      .onConflictDoNothing();
    await db
      .insert(playlistOwnership)
      .values([1, 2].map((playlistId) => ({ playlistId: BigInt(playlistId), userId: ownerId, role: 'owner' })));
    await db.execute(sql`
      INSERT INTO playlist_climbs (playlist_id, climb_uuid, angle, position)
      VALUES (1, 'moon-climb-1', 40, 0), (1, 'moon-climb-2', 40, 1),
             (2, 'kilter-sized-climb', 40, 0), (2, 'kilter-other-size-climb', 40, 1)
    `);
  });

  // Hand the worker DB back clean: `playlists` isn't in setup.ts's reset list
  // and the explicit ids above don't advance the sequence, so leaving rows
  // behind would collide with the next file that inserts without an id.
  afterAll(async () => {
    await db.execute(sql`TRUNCATE TABLE playlist_climbs, playlist_ownership, playlists RESTART IDENTITY CASCADE`);
  });

  it('returns every MoonBoard playlist climb in specific-board mode even when a sizeId is passed', async () => {
    const result = await playlistQueries.playlistClimbs(
      null,
      { input: { playlistId: MOON_PLAYLIST_UUID, boardName: 'moonboard', layoutId: 1, sizeId: 1, angle: 40 } },
      makeCtx(),
    );

    expect(result.climbs.map((climb) => climb.uuid)).toEqual(['moon-climb-1', 'moon-climb-2']);
    expect(result.climbs[0].difficulty).toBeTruthy();
    expect(result.hasMore).toBe(false);
  });

  it('still size-filters Aurora boards, and keeps the requested angle while the grade falls back', async () => {
    const result = await playlistQueries.playlistClimbs(
      null,
      { input: { playlistId: KILTER_PLAYLIST_UUID, boardName: 'kilter', layoutId: 1, sizeId: 10, angle: 40 } },
      makeCtx(),
    );

    expect(result.climbs.map((climb) => climb.uuid)).toEqual(['kilter-sized-climb']);
    // No 40° stats row → the EXISTS guard drops the override and the join
    // falls back to the most-ascents angle (50°) instead of blanking the grade…
    expect(result.climbs[0].difficulty).toBeTruthy();
    // …but the reported angle stays the wall the user asked for. These climbs
    // are queued straight from playlist activation, and the tick badge, the
    // board-presence report and the logged ascent all read `climb.angle` as
    // the angle of the wall in front of the user.
    expect(result.climbs[0].angle).toBe(40);
  });

  it('setterClimbsFull returns MoonBoard climbs in specific-board mode even when a sizeId is passed', async () => {
    const result = await setterFollowQueries.setterClimbsFull(
      null,
      { input: { username: 'moon-setter', boardType: 'moonboard', layoutId: 1, sizeId: 1, angle: 40 } },
      makeCtx(),
    );

    expect(result.totalCount).toBe(2);
    expect(result.climbs.map((climb) => climb.uuid).sort()).toEqual(['moon-climb-1', 'moon-climb-2']);
  });

  it('setterClimbsFull still size-filters Aurora boards', async () => {
    const result = await setterFollowQueries.setterClimbsFull(
      null,
      { input: { username: 'kilter-setter', boardType: 'kilter', layoutId: 1, sizeId: 10, angle: 40 } },
      makeCtx(),
    );

    expect(result.climbs.map((climb) => climb.uuid)).toEqual(['kilter-sized-climb']);
    expect(result.totalCount).toBe(1);
  });
});
