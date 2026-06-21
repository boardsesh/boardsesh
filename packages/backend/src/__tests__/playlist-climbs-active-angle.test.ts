import { describe, it, expect, beforeAll } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { playlistQueries } from '../graphql/resolvers/playlists/queries';

// Seeds use raw `sql` rather than `db.insert(...)` because the integration test
// DB is built from a minimal hand-maintained DDL (schema-sql.ts), not the full
// Drizzle schema — the query builder emits every default-bearing column (e.g.
// quality_normalized) which that DDL omits, so a builder insert fails. Naming
// only the columns the test DDL declares is the genuine raw-SQL exception.

// Integration test (real DB) for #1596: in all-boards mode the playlist climbs
// resolver must render on-active-board climbs' grades at the user's SELECTED
// wall angle — not the angle with the most ascents. This exercises the actual
// COALESCE(override-if-stats-exist, most-ascents) + EXISTS guard SQL in
// hydrateClimbsByRefs, which the mocked unit tests can't reach.
//
// The returned `angle` follows the stats row the query actually joined, so it
// is a faithful proxy for "which angle's grade is displayed".

const PLAYLIST_UUID = 'pl-active-angle-1596';

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

async function seedClimb(boardType: string, uuid: string, name: string) {
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, description, frames, is_listed)
    VALUES (${uuid}, ${boardType}, 1, 'setter', ${name}, '', 'p1r1', true)
  `);
}

async function seedStats(boardType: string, uuid: string, angle: number, displayDifficulty: number, ascents: number) {
  await db.execute(sql`
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, difficulty_average, quality_average, ascensionist_count, benchmark_difficulty)
    VALUES (${boardType}, ${uuid}, ${angle}, ${displayDifficulty}, ${displayDifficulty}, 3.0, ${ascents}, 0)
  `);
}

describe('playlistClimbs — active-angle override (real DB)', () => {
  beforeAll(async () => {
    // Playlist tables aren't in the global per-file reset list, so own the cleanup.
    await db.execute(sql`TRUNCATE TABLE playlist_climbs, playlist_ownership, playlists RESTART IDENTITY CASCADE`);

    // climb-A (kilter): graded at BOTH 40° and 50°. 50° has far more ascents, so
    // "most-ascents" = 50°. Added to the playlist at 50°.
    await seedClimb('kilter', 'climb-a', 'On-board, has 40 stats');
    await seedStats('kilter', 'climb-a', 40, 18, 5);
    await seedStats('kilter', 'climb-a', 50, 22, 500);

    // climb-B (kilter): graded ONLY at 50° (no 40° row). Added at 50°.
    await seedClimb('kilter', 'climb-b', 'On-board, no 40 stats');
    await seedStats('kilter', 'climb-b', 50, 21, 300);

    // climb-C (tension): off the active board. Graded at 30°. Added at 30°.
    await seedClimb('tension', 'climb-c', 'Off-board');
    await seedStats('tension', 'climb-c', 30, 16, 50);

    // Explicit id keeps the playlist_climbs FK references below trivial; the
    // TRUNCATE ... RESTART IDENTITY above frees id 1.
    await db.execute(sql`
      INSERT INTO playlists (id, uuid, board_type, layout_id, name, is_public)
      VALUES (1, ${PLAYLIST_UUID}, 'kilter', 1, 'Active angle', true)
    `);
    await db.execute(sql`
      INSERT INTO playlist_climbs (playlist_id, climb_uuid, angle, position)
      VALUES (1, 'climb-a', 50, 0), (1, 'climb-b', 50, 1), (1, 'climb-c', 30, 2)
    `);
  });

  it('renders on-active-board grades at the selected angle, falls back when stats are missing, and leaves off-board climbs alone', async () => {
    const result = await playlistQueries.playlistClimbs(
      null,
      { input: { playlistId: PLAYLIST_UUID, activeBoardName: 'kilter', activeAngle: 40 } },
      makeCtx(),
    );

    const byUuid = Object.fromEntries(result.climbs.map((climb) => [climb.uuid, climb]));

    // climb-A: selected angle 40° beats the added-at (50°) AND the most-ascents
    // angle (50°). The grade shown is the 40° grade, not the 50° one.
    expect(byUuid['climb-a'].angle).toBe(40);
    expect(byUuid['climb-a'].difficulty).toBeTruthy();

    // climb-B: no stats at 40° → the EXISTS guard drops the override and the
    // join falls back to most-ascents (50°). Crucially the grade is NOT blank.
    expect(byUuid['climb-b'].angle).toBe(50);
    expect(byUuid['climb-b'].difficulty).toBeTruthy();

    // climb-C: different board → untouched by the kilter active board, stays 30°.
    expect(byUuid['climb-c'].angle).toBe(30);
    expect(byUuid['climb-c'].difficulty).toBeTruthy();
  });

  it('without an active board, on-board climbs still default to the most-ascents angle (unchanged behaviour)', async () => {
    const result = await playlistQueries.playlistClimbs(null, { input: { playlistId: PLAYLIST_UUID } }, makeCtx());

    const byUuid = Object.fromEntries(result.climbs.map((climb) => [climb.uuid, climb]));

    // climb-A has a stored playlist angle of 50°, which wins as the override.
    expect(byUuid['climb-a'].angle).toBe(50);
    // climb-C keeps its stored 30°.
    expect(byUuid['climb-c'].angle).toBe(30);
  });
});
