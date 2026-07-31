import { describe, it, expect, beforeAll } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { playlistQueries } from '../graphql/resolvers/playlists/queries';

// Seeds use raw `sql` rather than `db.insert(...)` because the integration test
// DB is built from a minimal hand-maintained DDL (schema-sql.ts), not the full
// Drizzle schema — the query builder emits every default-bearing column that
// DDL omits, so a builder insert fails. Naming only the columns the test DDL
// declares is the genuine raw-SQL exception (see playlist-climbs-board-scope.test.ts).

// Integration test (real DB) for #4000: `playlistClimbs.totalCount` must
// respect the same filters `climbs` is joined against, in both specific-board
// and all-boards mode. Before the fix, `totalCount` was a bare
// `count(*) FROM playlist_climbs WHERE playlist_id = ...` with no join at all,
// so it counted rows the `climbs` query would never return — a paginating
// client would expect a page that could never arrive.

const CROSS_BOARD_PLAYLIST_UUID = 'pl-total-count-cross-board';
const LAYOUT_MISMATCH_PLAYLIST_UUID = 'pl-total-count-layout';
const ORPHANED_REF_PLAYLIST_UUID = 'pl-total-count-orphaned';

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

async function seedClimb(boardType: string, uuid: string, name: string, layoutId: number) {
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, description, frames, is_listed)
    VALUES (${uuid}, ${boardType}, ${layoutId}, 'setter', ${name}, '', 'p1r1', true)
  `);
}

async function seedStats(boardType: string, uuid: string, angle: number) {
  await db.execute(sql`
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, difficulty_average, quality_average, ascensionist_count, benchmark_difficulty)
    VALUES (${boardType}, ${uuid}, ${angle}, 18, 18, 3.0, 10, 0)
  `);
}

describe('playlistClimbs — totalCount respects query filters (real DB, #4000)', () => {
  beforeAll(async () => {
    // Playlist tables aren't in the global per-file reset list, so own the cleanup.
    await db.execute(sql`TRUNCATE TABLE playlist_climbs, playlist_ownership, playlists RESTART IDENTITY CASCADE`);

    // --- Cross-board playlist: 2 kilter climbs, 1 tension climb ---
    await seedClimb('kilter', 'cb-kilter-1', 'Kilter One', 1);
    await seedClimb('kilter', 'cb-kilter-2', 'Kilter Two', 1);
    await seedClimb('tension', 'cb-tension-1', 'Tension One', 1);
    await seedStats('kilter', 'cb-kilter-1', 40);
    await seedStats('kilter', 'cb-kilter-2', 40);
    await seedStats('tension', 'cb-tension-1', 40);

    // --- Layout-mismatch playlist: 2 climbs on layout 1, 1 climb on layout 2, all kilter ---
    await seedClimb('kilter', 'lm-layout1-a', 'Layout1 A', 1);
    await seedClimb('kilter', 'lm-layout1-b', 'Layout1 B', 1);
    await seedClimb('kilter', 'lm-layout2', 'Layout2', 2);
    await seedStats('kilter', 'lm-layout1-a', 40);
    await seedStats('kilter', 'lm-layout1-b', 40);
    await seedStats('kilter', 'lm-layout2', 40);

    // --- Orphaned-ref playlist: 1 real climb, 1 playlist_climbs row whose
    // climb_uuid has no matching board_climbs row at all (deleted/never-synced) ---
    await seedClimb('kilter', 'or-real', 'Real Climb', 1);
    await seedStats('kilter', 'or-real', 40);

    await db.execute(sql`
      INSERT INTO playlists (id, uuid, board_type, layout_id, name, is_public)
      VALUES (1, ${CROSS_BOARD_PLAYLIST_UUID}, 'kilter', 1, 'Cross-board set', true),
             (2, ${LAYOUT_MISMATCH_PLAYLIST_UUID}, 'kilter', 1, 'Layout mismatch set', true),
             (3, ${ORPHANED_REF_PLAYLIST_UUID}, 'kilter', 1, 'Orphaned ref set', true)
    `);
    await db.execute(sql`
      INSERT INTO playlist_climbs (playlist_id, climb_uuid, angle, position)
      VALUES (1, 'cb-kilter-1', 40, 0), (1, 'cb-kilter-2', 40, 1), (1, 'cb-tension-1', 40, 2),
             (2, 'lm-layout1-a', 40, 0), (2, 'lm-layout1-b', 40, 1), (2, 'lm-layout2', 40, 2),
             (3, 'or-real', 40, 0), (3, 'missing-climb-uuid', 40, 1)
    `);
  });

  it('specific-board mode: totalCount only counts climbs on the requested board, not the whole playlist', async () => {
    const result = await playlistQueries.playlistClimbs(
      null,
      { input: { playlistId: CROSS_BOARD_PLAYLIST_UUID, boardName: 'kilter', layoutId: 1, angle: 40 } },
      makeCtx(),
    );

    // playlist_climbs has 3 rows for this playlist, but only 2 are kilter.
    expect(result.climbs.map((climb) => climb.uuid).sort()).toEqual(['cb-kilter-1', 'cb-kilter-2']);
    expect(result.totalCount).toBe(2);
  });

  it('all-boards mode: totalCount counts every board, matching the unfiltered climbs list', async () => {
    const result = await playlistQueries.playlistClimbs(
      null,
      { input: { playlistId: CROSS_BOARD_PLAYLIST_UUID, activeBoardName: 'kilter', activeAngle: 40 } },
      makeCtx(),
    );

    expect(result.climbs).toHaveLength(3);
    expect(result.totalCount).toBe(3);
  });

  it('specific-board mode: totalCount respects the layoutId filter', async () => {
    const result = await playlistQueries.playlistClimbs(
      null,
      { input: { playlistId: LAYOUT_MISMATCH_PLAYLIST_UUID, boardName: 'kilter', layoutId: 1, angle: 40 } },
      makeCtx(),
    );

    // 3 rows in playlist_climbs, but only 2 are on layout 1.
    expect(result.climbs.map((climb) => climb.uuid).sort()).toEqual(['lm-layout1-a', 'lm-layout1-b']);
    expect(result.totalCount).toBe(2);
  });

  it('all-boards mode: totalCount excludes a playlist_climbs row whose climb no longer exists', async () => {
    const result = await playlistQueries.playlistClimbs(
      null,
      { input: { playlistId: ORPHANED_REF_PLAYLIST_UUID, activeBoardName: 'kilter', activeAngle: 40 } },
      makeCtx(),
    );

    // playlist_climbs has 2 rows for this playlist; one points at a climb_uuid
    // with no board_climbs row (never synced / deleted). It cannot be hydrated
    // into `climbs`, so it must not inflate totalCount either.
    expect(result.climbs.map((climb) => climb.uuid)).toEqual(['or-real']);
    expect(result.totalCount).toBe(1);
  });
});
