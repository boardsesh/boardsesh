/**
 * The popular sort's ranking table end to end, against the real test Postgres:
 * the full and incremental refresh, the readiness gate that keeps the old
 * aggregation until a board is built, and the walk plus its tail fallback.
 * Design: docs/climb-popularity.md.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import {
  isClimbPopularityReady,
  refreshClimbPopularityForBoard,
  resetClimbPopularityReadinessForTests,
} from '@boardsesh/db/queries';
import { db } from '../db/client';
import { searchClimbs, type ParsedBoardRouteParameters } from '../db/queries/climbs/index';

const BOARD = 'kilter' as const;
const PREFIX = 'climb-popularity-test-';
const LAYOUT = 9701;
const PARAMS: ParsedBoardRouteParameters = {
  board_name: BOARD,
  layout_id: LAYOUT,
  size_id: 77,
  set_ids: [77],
  angle: 40,
};

const id = (name: string) => PREFIX + name;

async function insertClimbs(names: string[]): Promise<void> {
  await db.insert(dbSchema.boardClimbs).values(
    names.map((name) => ({
      uuid: id(name),
      boardType: BOARD,
      layoutId: LAYOUT,
      setterUsername: 'setter',
      name,
      frames: 'p1r12',
      framesCount: 1,
      isDraft: false,
      isListed: true,
      edgeLeft: 10,
      edgeRight: 100,
      edgeBottom: 10,
      edgeTop: 150,
      requiredSetIds: [77],
      compatibleSizeIds: [77],
    })),
  );
}

async function insertStats(rows: Array<{ climb: string; angle: number; ascents: number; grade?: number }>) {
  await db.insert(dbSchema.boardClimbStats).values(
    rows.map((row) => ({
      boardType: BOARD,
      climbUuid: id(row.climb),
      angle: row.angle,
      ascensionistCount: row.ascents,
      displayDifficulty: row.grade ?? 20,
      difficultyAverage: row.grade ?? 20,
      qualityAverage: 3,
    })),
  );
}

async function popularityRows(): Promise<Array<{ climb: string; angle: number; total: number }>> {
  const rows = await db
    .select({
      climb: dbSchema.boardClimbPopularity.climbUuid,
      angle: dbSchema.boardClimbPopularity.angle,
      total: dbSchema.boardClimbPopularity.totalAscensionistCount,
    })
    .from(dbSchema.boardClimbPopularity)
    .where(
      and(
        eq(dbSchema.boardClimbPopularity.boardType, BOARD),
        like(dbSchema.boardClimbPopularity.climbUuid, `${PREFIX}%`),
      ),
    )
    .orderBy(dbSchema.boardClimbPopularity.climbUuid, dbSchema.boardClimbPopularity.angle);
  return rows.map((row) => ({ ...row, climb: row.climb.slice(PREFIX.length), total: Number(row.total) }));
}

async function popularPage(page: number, pageSize: number, extra: Record<string, unknown> = {}): Promise<string[]> {
  const result = await searchClimbs(PARAMS, { page, pageSize, sortBy: 'popular', sortOrder: 'desc', ...extra });
  return result.climbs.map((climb) => climb.uuid.slice(PREFIX.length));
}

async function clearPopularity(): Promise<void> {
  await db.delete(dbSchema.boardClimbPopularity).where(eq(dbSchema.boardClimbPopularity.boardType, BOARD));
  await db.delete(dbSchema.boardClimbPopularityRuns).where(eq(dbSchema.boardClimbPopularityRuns.boardType, BOARD));
  resetClimbPopularityReadinessForTests();
}

describe('board_climb_popularity', () => {
  beforeAll(async () => {
    await clearPopularity();
    // total = SUM(ascents) over every angle:
    //   alpha 150 (40 + 45), bravo 120 (40 only), charlie 500 (45 only),
    //   delta no stats at all.
    await insertClimbs(['alpha', 'bravo', 'charlie', 'delta']);
    await insertStats([
      { climb: 'alpha', angle: 40, ascents: 100 },
      { climb: 'alpha', angle: 45, ascents: 50 },
      { climb: 'bravo', angle: 40, ascents: 120 },
      { climb: 'charlie', angle: 45, ascents: 500 },
    ]);
  });

  afterAll(async () => {
    // Later files in this worker share the database: leave no built board
    // behind, or their popular searches would read this table.
    await clearPopularity();
    await db.delete(dbSchema.boardClimbStats).where(like(dbSchema.boardClimbStats.climbUuid, `${PREFIX}%`));
    await db.delete(dbSchema.boardClimbs).where(like(dbSchema.boardClimbs.uuid, `${PREFIX}%`));
  });

  beforeEach(() => {
    resetClimbPopularityReadinessForTests();
  });

  it('keeps the old aggregation until the board has a full build', async () => {
    expect(await isClimbPopularityReady(db, BOARD)).toBe(false);
    // The old order: cross-angle total, whatever the browsed angle has.
    expect(await popularPage(0, 10)).toEqual(['charlie', 'alpha', 'bravo', 'delta']);
  });

  it('builds one row per stats row, each carrying the climb total', async () => {
    const result = await refreshClimbPopularityForBoard(db, BOARD);
    expect(result.mode).toBe('full');

    expect(await popularityRows()).toEqual([
      { climb: 'alpha', angle: 40, total: 150 },
      { climb: 'alpha', angle: 45, total: 150 },
      { climb: 'bravo', angle: 40, total: 120 },
      { climb: 'charlie', angle: 45, total: 500 },
    ]);
    expect(await isClimbPopularityReady(db, BOARD)).toBe(true);
  });

  it('walks the table, then appends the climbs the walk cannot see', async () => {
    // Walk rows first (a stats row at the browsed angle), then the tail in the
    // old order. Charlie has no stats at 40, so it now follows every climb
    // logged at 40, as the ascents sort has always done.
    expect(await popularPage(0, 10)).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
    // Page by page: page 0 is served by the walk alone (it found a next row),
    // pages 1 and 2 by the fallback, with no row skipped or repeated.
    expect(await popularPage(0, 1)).toEqual(['alpha']);
    expect(await popularPage(1, 1)).toEqual(['bravo']);
    expect(await popularPage(2, 1)).toEqual(['charlie']);
    expect(await popularPage(3, 1)).toEqual(['delta']);
  });

  it('applies a grade band and minimum ascents the way the old path did', async () => {
    // Bravo is 20 (V-grade id), alpha is 20 as well; a band that excludes 20
    // leaves only the stats-less delta, which the grade fallback finds no grade for.
    expect(await popularPage(0, 10, { minGrade: 25, maxGrade: 28 })).toEqual([]);
    expect(await popularPage(0, 10, { minAscents: 110 })).toEqual(['bravo']);
  });

  it('re-reads only the climbs whose stats changed', async () => {
    await insertStats([{ climb: 'bravo', angle: 45, ascents: 100 }]);
    // Alpha loses its 45 row; touching its 40 row is what makes the run see it.
    await db
      .delete(dbSchema.boardClimbStats)
      .where(
        and(
          eq(dbSchema.boardClimbStats.boardType, BOARD),
          eq(dbSchema.boardClimbStats.climbUuid, id('alpha')),
          eq(dbSchema.boardClimbStats.angle, 45),
        ),
      );
    await db
      .update(dbSchema.boardClimbStats)
      .set({ updatedAt: sql`now()` })
      .where(
        and(
          eq(dbSchema.boardClimbStats.boardType, BOARD),
          inArray(dbSchema.boardClimbStats.climbUuid, [id('alpha')]),
          eq(dbSchema.boardClimbStats.angle, 40),
        ),
      );

    const result = await refreshClimbPopularityForBoard(db, BOARD);
    expect(result.mode).toBe('incremental');

    expect(await popularityRows()).toEqual([
      { climb: 'alpha', angle: 40, total: 100 },
      { climb: 'bravo', angle: 40, total: 220 },
      { climb: 'bravo', angle: 45, total: 220 },
      { climb: 'charlie', angle: 45, total: 500 },
    ]);
    expect(await popularPage(0, 10)).toEqual(['bravo', 'alpha', 'charlie', 'delta']);
  });
});
