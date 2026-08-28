import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
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

async function seedGrade(boardType: string, uuid: string, angle: number, universalGrade: number, confidence: string) {
  // Upsert on the (board_type, climb_uuid, angle) PK — board_climb_grades isn't
  // in setup.ts's per-file reset list, so an aborted run can leave a row that
  // would PK-conflict the next run's INSERT. Mirrors insertBoardClimbGrade in
  // tick-queries.test.ts.
  await db.execute(sql`
    INSERT INTO board_climb_grades (board_type, climb_uuid, angle, local_grade, universal_grade, confidence, model_version, coeff_version)
    VALUES (${boardType}, ${uuid}, ${angle}, ${universalGrade}, ${universalGrade}, ${confidence}, 'test', 'test')
    ON CONFLICT (board_type, climb_uuid, angle) DO UPDATE SET
      local_grade = excluded.local_grade,
      universal_grade = excluded.universal_grade,
      confidence = excluded.confidence
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

    // climb-D (kilter): stats at BOTH 40° (few ascents) and 60° (most ascents).
    // Boardsesh grade row exists ONLY at 60° — the climb's most-ascended /
    // playlist-added-at angle. Used to pin the grades join in
    // hydrateClimbsByRefs to the SAME resolved climbStats.angle the stats join
    // used (not the raw requested/stored angle), for #boardsesh-grade-ui.
    await seedClimb('kilter', 'climb-d', 'Grade only at most-ascended angle');
    await seedStats('kilter', 'climb-d', 40, 15, 4);
    await seedStats('kilter', 'climb-d', 60, 23, 400);
    await seedGrade('kilter', 'climb-d', 60, 23.4, 'confirmed');

    // Explicit id keeps the playlist_climbs FK references below trivial; the
    // TRUNCATE ... RESTART IDENTITY above frees id 1.
    await db.execute(sql`
      INSERT INTO playlists (id, uuid, board_type, layout_id, name, is_public)
      VALUES (1, ${PLAYLIST_UUID}, 'kilter', 1, 'Active angle', true)
    `);
    await db.execute(sql`
      INSERT INTO playlist_climbs (playlist_id, climb_uuid, angle, position)
      VALUES (1, 'climb-a', 50, 0), (1, 'climb-b', 50, 1), (1, 'climb-c', 30, 2), (1, 'climb-d', 60, 3)
    `);
  });

  afterAll(async () => {
    // board_climb_grades isn't in setup.ts's per-file TABLES_TO_RESET list (no
    // FK back to board_climbs to cascade the cleanup), so a leftover row here
    // would survive into the next file that reuses this worker's DB and could
    // collide with a re-run of this file's own seed (PK is board_type +
    // climb_uuid + angle).
    await db.execute(sql`DELETE FROM board_climb_grades WHERE board_type = ${'kilter'} AND climb_uuid = ${'climb-d'}`);
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

  it('accepts a negative activeAngle (Aurora boards support negative tilt) and falls back like any other unmatched angle', async () => {
    // No board_climb_stats row at -5° for any on-board climb, so the EXISTS
    // guard drops the override and each on-board climb falls back to its
    // most-ascended angle — same behaviour as a positive angle with no stats.
    const result = await playlistQueries.playlistClimbs(
      null,
      { input: { playlistId: PLAYLIST_UUID, activeBoardName: 'kilter', activeAngle: -5 } },
      makeCtx(),
    );

    const byUuid = Object.fromEntries(result.climbs.map((climb) => [climb.uuid, climb]));
    expect(byUuid['climb-a'].angle).toBe(50);
    expect(byUuid['climb-b'].angle).toBe(50);
  });

  it('rejects activeAngle -91 (outside the -90..90 board-tilt range)', async () => {
    await expect(
      playlistQueries.playlistClimbs(
        null,
        { input: { playlistId: PLAYLIST_UUID, activeBoardName: 'kilter', activeAngle: -91 } },
        makeCtx(),
      ),
    ).rejects.toThrow();
  });

  it('without an active board, on-board climbs still default to the most-ascents angle (unchanged behaviour)', async () => {
    const result = await playlistQueries.playlistClimbs(null, { input: { playlistId: PLAYLIST_UUID } }, makeCtx());

    const byUuid = Object.fromEntries(result.climbs.map((climb) => [climb.uuid, climb]));

    // climb-A has a stored playlist angle of 50°, which wins as the override.
    expect(byUuid['climb-a'].angle).toBe(50);
    // climb-C keeps its stored 30°.
    expect(byUuid['climb-c'].angle).toBe(30);
  });

  // The grades join in hydrateClimbsByRefs binds to `climbStats.angle` — the
  // SAME resolved (override-else-most-ascended) angle the stats join lands
  // on — not the raw requested/stored angle. climb-D has a Boardsesh grade
  // row at ONLY one angle (60°, its most-ascended angle); these two cases
  // drive the resolved effective angle to 60° and to 40° respectively and
  // confirm the grade fields track it.
  describe('boardsesh grade join follows the resolved stats angle, not the requested angle', () => {
    it('surfaces boardseshDifficulty when the grade row is at the resolved effective angle', async () => {
      // No active-board override → angleOverrides falls back to the playlist's
      // stored angle (60°), which is also climb-D's most-ascended angle — the
      // same angle the lone board_climb_grades row was seeded at.
      const result = await playlistQueries.playlistClimbs(null, { input: { playlistId: PLAYLIST_UUID } }, makeCtx());

      const climbD = result.climbs.find((climb) => climb.uuid === 'climb-d');
      expect(climbD).toBeDefined();
      expect(climbD!.angle).toBe(60);
      expect(climbD!.boardseshDifficulty).toBeCloseTo(23.4);
      expect(climbD!.boardseshConfidence).toBe('confirmed');
    });

    it('surfaces null when the grade row exists only at a different angle than the resolved one', async () => {
      // activeAngle=40 redirects the override to 40° — climb-D has a stats row
      // there too, so the EXISTS guard lets the override win and the stats join
      // resolves climbStats.angle to 40°. The grade row lives only at 60°, so
      // the grades join (which reuses that SAME resolved 40°) must come back
      // null rather than leaking the 60° grade.
      const result = await playlistQueries.playlistClimbs(
        null,
        { input: { playlistId: PLAYLIST_UUID, activeBoardName: 'kilter', activeAngle: 40 } },
        makeCtx(),
      );

      const climbD = result.climbs.find((climb) => climb.uuid === 'climb-d');
      expect(climbD).toBeDefined();
      expect(climbD!.angle).toBe(40);
      expect(climbD!.boardseshDifficulty).toBeNull();
      expect(climbD!.boardseshConfidence).toBeNull();
    });
  });
});
