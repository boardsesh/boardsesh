import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { newClimbSubscriptionResolvers } from '../graphql/resolvers/social/new-climb-subscriptions';
import { climbStatsJoinConditions } from '../db/queries/util/climb-stats-join';

const BOARD_TYPE = 'moonboard' as const;
const LAYOUT_ID = 990220;
const CLIMB_PREFIX = 'climb-stats-angle-fallback-';

const GRADE_HARD = { difficulty: 20, name: 'V5-fallback-test' };
const GRADE_EASY = { difficulty: 10, name: 'V2-fallback-test' };

async function insertClimb(uuid: string, angle: number | null) {
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, name, angle, is_listed, is_draft, created_at)
    VALUES (${uuid}, ${BOARD_TYPE}, ${LAYOUT_ID}, ${uuid}, ${angle}, true, false, '2026-01-01')
  `);
}

async function insertStats(uuid: string, angle: number, displayDifficulty: number, ascensionistCount: number) {
  await db.execute(sql`
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, ascensionist_count)
    VALUES (${BOARD_TYPE}, ${uuid}, ${angle}, ${displayDifficulty}, ${ascensionistCount})
  `);
}

async function insertGrade(difficulty: number, boulderName: string) {
  await db.execute(sql`
    INSERT INTO board_difficulty_grades (board_type, difficulty, boulder_name, is_listed)
    VALUES (${BOARD_TYPE}, ${difficulty}, ${boulderName}, true)
    ON CONFLICT (board_type, difficulty) DO UPDATE SET boulder_name = excluded.boulder_name
  `);
}

async function cleanupClimbs() {
  await db.execute(sql`DELETE FROM board_climb_stats WHERE climb_uuid LIKE ${CLIMB_PREFIX + '%'}`);
  await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE ${CLIMB_PREFIX + '%'}`);
}

async function feedItemFor(uuid: string) {
  const result = await newClimbSubscriptionResolvers.Query.newClimbFeed(null, {
    input: { boardType: BOARD_TYPE, layoutId: LAYOUT_ID, limit: 50, offset: 0 },
  });
  return result.items.find((item) => item.uuid === uuid);
}

describe('board_climb_stats angle resolution for angle-agnostic climbs', () => {
  beforeAll(async () => {
    await cleanupClimbs();
    await insertGrade(GRADE_HARD.difficulty, GRADE_HARD.name);
    await insertGrade(GRADE_EASY.difficulty, GRADE_EASY.name);
  });

  afterEach(async () => {
    await cleanupClimbs();
  });

  afterAll(async () => {
    await cleanupClimbs();
    await db.execute(sql`
      DELETE FROM board_difficulty_grades
      WHERE board_type = ${BOARD_TYPE} AND difficulty IN (${GRADE_HARD.difficulty}, ${GRADE_EASY.difficulty})
    `);
  });

  it('falls back to the most-ascended stats row when the climb has no angle', async () => {
    const uuid = `${CLIMB_PREFIX}null-angle`;
    await insertClimb(uuid, null);
    await insertStats(uuid, 40, GRADE_HARD.difficulty, 12);
    await insertStats(uuid, 25, GRADE_EASY.difficulty, 3);

    const item = await feedItemFor(uuid);

    expect(item?.difficultyName).toBe(GRADE_HARD.name);
    expect(item?.angle).toBe(40);
  });

  it('keeps using the climb angle when it is set, even if another angle has more ascents', async () => {
    const uuid = `${CLIMB_PREFIX}own-angle`;
    await insertClimb(uuid, 25);
    await insertStats(uuid, 40, GRADE_HARD.difficulty, 12);
    await insertStats(uuid, 25, GRADE_EASY.difficulty, 3);

    const item = await feedItemFor(uuid);

    expect(item?.difficultyName).toBe(GRADE_EASY.name);
    expect(item?.angle).toBe(25);
  });

  it('breaks ascent ties on the lower angle so repeated reads agree', async () => {
    const uuid = `${CLIMB_PREFIX}tie`;
    await insertClimb(uuid, null);
    await insertStats(uuid, 40, GRADE_HARD.difficulty, 7);
    await insertStats(uuid, 25, GRADE_EASY.difficulty, 7);

    const item = await feedItemFor(uuid);

    expect(item?.difficultyName).toBe(GRADE_EASY.name);
    expect(item?.angle).toBe(25);
  });

  it('leaves the grade null when an angle-less climb has no stats rows at all', async () => {
    const uuid = `${CLIMB_PREFIX}no-stats`;
    await insertClimb(uuid, null);

    const item = await feedItemFor(uuid);

    expect(item).toBeDefined();
    expect(item?.difficultyName).toBeNull();
    expect(item?.angle).toBeNull();
  });
});

describe('climbStatsJoinConditions SQL shape', () => {
  it('still emits the COALESCE fallback ordered by ascensionist_count', () => {
    const { sql: emitted } = db
      .select({ uuid: dbSchema.boardClimbs.uuid })
      .from(dbSchema.boardClimbs)
      .leftJoin(dbSchema.boardClimbStats, and(...climbStatsJoinConditions()))
      .toSQL();

    const normalized = emitted.toLowerCase().replace(/\s+/g, ' ');
    expect(normalized).toContain('coalesce');
    expect(normalized).toContain('order by s.ascensionist_count desc nulls last, s.angle asc');
  });

  it('does not change the non-angle join predicates', () => {
    const conditions = climbStatsJoinConditions();
    expect(conditions).toHaveLength(3);
    expect(conditions[0]).toEqual(eq(dbSchema.boardClimbStats.boardType, dbSchema.boardClimbs.boardType));
    expect(conditions[1]).toEqual(eq(dbSchema.boardClimbStats.climbUuid, dbSchema.boardClimbs.uuid));
  });
});
