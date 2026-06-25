import { describe, it, expect, beforeAll, afterEach } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { tickQueries } from '../graphql/resolvers/ticks/queries';

/**
 * Integration tests for the tick query resolvers, covering the three behavior
 * fixes added in the playlists-default-logbook PR:
 *
 *   1. `flashOnly: true` returns ONLY flashes (not flashes + attempts).
 *   2. `climbName` searches escape LIKE wildcards (`%` / `_` are literal).
 *   3. `userGroupedAscentsFeed` paginates groups in SQL with the correct
 *      totalCount and bucket-by-day grouping (no UTC timezone shifts).
 */

const TEST_USER_ID = 'tick-queries-test-user';
const OTHER_USER_ID = 'tick-queries-other-user';
const CLIMB_PREFIX = 'tick-queries-test-climb-';

type FeedItem = {
  uuid: string;
  status: string;
  climbName: string;
  climbedAt: string;
  difficulty: number | null;
  difficultyName: string | null;
  consensusDifficulty: number | null;
  consensusDifficultyName: string | null;
};

type FeedResult = {
  items: FeedItem[];
  totalCount: number;
  hasMore: boolean;
};

type GroupedItem = {
  uuid: string;
  status: string;
  climbedAt: string;
};

type Group = {
  climbUuid: string;
  climbName: string;
  date: string;
  items: GroupedItem[];
  flashCount: number;
  sendCount: number;
  attemptCount: number;
};

type GroupedResult = {
  groups: Group[];
  totalCount: number;
  hasMore: boolean;
};

const callUserAscentsFeed = (userId: string, input: Record<string, unknown>) =>
  tickQueries.userAscentsFeed(undefined, { userId, input }) as Promise<FeedResult>;

const callUserGroupedAscentsFeed = (userId: string, input: Record<string, unknown>) =>
  tickQueries.userGroupedAscentsFeed(undefined, { userId, input }) as Promise<GroupedResult>;

const callUserAscentCaptionMatches = (userId: string, caption: string) =>
  tickQueries.userAscentCaptionMatches(undefined, { userId, caption }) as Promise<
    Array<{ uuid: string; climbUuid: string; climbName: string; status: string; frames: string | null }>
  >;

const callUserClimbPercentile = (userId: string) =>
  tickQueries.userClimbPercentile(
    undefined,
    { userId },
    {
      connectionId: 'tick-queries-test-conn',
      isAuthenticated: false,
      userId: undefined,
      sessionId: undefined,
      controllerId: undefined,
      controllerApiKey: undefined,
    },
  ) as Promise<{
    totalDistinctClimbs: number;
    percentile: number;
    totalActiveUsers: number;
  }>;

const insertUser = async (id: string) => {
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'Test ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
};

const insertClimb = async (uuid: string, name: string, options: { boardType?: string; layoutId?: number } = {}) => {
  const boardType = options.boardType ?? 'kilter';
  const layoutId = options.layoutId ?? 1;
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, frames, frames_count, is_draft, is_listed, edge_left, edge_right, edge_bottom, edge_top, created_at)
    VALUES (${uuid}, ${boardType}, ${layoutId}, 'test-setter', ${name}, 'p1r1', 1, false, true, 0, 100, 0, 150, '2024-01-01')
    ON CONFLICT (uuid) DO NOTHING
  `);
};

const insertTick = async (params: {
  uuid: string;
  userId?: string;
  climbUuid: string;
  climbedAt: string;
  status: 'flash' | 'send' | 'attempt';
  attemptCount?: number;
  boardType?: string;
  difficulty?: number;
  angle?: number;
}) => {
  const userId = params.userId ?? TEST_USER_ID;
  const attemptCount = params.attemptCount ?? 1;
  const boardType = params.boardType ?? 'kilter';
  const angle = params.angle ?? 40;
  await db.execute(sql`
    INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, attempt_count, difficulty, climbed_at)
    VALUES (${params.uuid}, ${userId}, ${boardType}, ${params.climbUuid}, ${angle}, ${params.status}, ${attemptCount}, ${params.difficulty ?? null}, ${params.climbedAt})
  `);
};

const insertAlias = async (params: {
  aliasUuid: string;
  canonicalUuid: string;
  boardType?: string;
  source?: string;
}) => {
  const boardType = params.boardType ?? 'kilter';
  const source = params.source ?? 'test';
  await db.execute(sql`
    INSERT INTO board_climb_aliases (board_type, alias_uuid, canonical_uuid, source, first_seen_at, last_seen_at)
    VALUES (${boardType}, ${params.aliasUuid}, ${params.canonicalUuid}, ${source}, now(), now())
    ON CONFLICT (board_type, alias_uuid) DO UPDATE SET canonical_uuid = excluded.canonical_uuid
  `);
};

const insertBoardClimbStats = async (params: {
  climbUuid: string;
  boardType?: string;
  angle?: number;
  displayDifficulty: number;
}) => {
  const boardType = params.boardType ?? 'kilter';
  const angle = params.angle ?? 40;
  await db.execute(sql`
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, ascensionist_count, difficulty_average, quality_average)
    VALUES (${boardType}, ${params.climbUuid}, ${angle}, ${params.displayDifficulty}, 10, ${params.displayDifficulty}, 4)
    ON CONFLICT (board_type, climb_uuid, angle) DO UPDATE SET display_difficulty = excluded.display_difficulty
  `);
};

const cleanup = async () => {
  await db.execute(sql`DELETE FROM user_climb_percentiles WHERE user_id IN (${TEST_USER_ID}, ${OTHER_USER_ID})`);
  await db.execute(sql`DELETE FROM boardsesh_ticks WHERE user_id IN (${TEST_USER_ID}, ${OTHER_USER_ID})`);
  await db.execute(sql`DELETE FROM board_climb_stats WHERE climb_uuid LIKE ${CLIMB_PREFIX + '%'}`);
  await db.execute(
    sql`DELETE FROM board_climb_aliases WHERE alias_uuid LIKE ${CLIMB_PREFIX + '%'} OR canonical_uuid LIKE ${CLIMB_PREFIX + '%'}`,
  );
  await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE ${CLIMB_PREFIX + '%'}`);
};

describe('tickQueries — behavior fixes', () => {
  beforeAll(async () => {
    await insertUser(TEST_USER_ID);
    await insertUser(OTHER_USER_ID);
  });

  afterEach(async () => {
    await cleanup();
  });

  describe('userAscentsFeed — hardest sort', () => {
    it('orders by effective grade (logged, else consensus) desc, date breaking ties', async () => {
      // consensus / logged -> effective grade (logged, else consensus):
      //   D 12 / -  -> 12
      //   E 11 / 10 -> 10
      //   A 10 / 11 -> 11
      //   B 10 / -  -> 10   (ungraded ranks as if logged == consensus)
      //   C 10 / 9  -> 9
      // hardest = effective grade desc, date breaks ties -> D, A, E, B, C
      const seeded: Array<{ key: string; consensus: number; logged: number | null }> = [
        { key: 'D', consensus: 12, logged: null },
        { key: 'E', consensus: 11, logged: 10 },
        { key: 'A', consensus: 10, logged: 11 },
        { key: 'B', consensus: 10, logged: null },
        { key: 'C', consensus: 10, logged: 9 },
      ];
      for (const climb of seeded) {
        const climbUuid = CLIMB_PREFIX + 'hardest-' + climb.key;
        await insertClimb(climbUuid, climb.key);
        await insertBoardClimbStats({ climbUuid, displayDifficulty: climb.consensus });
        await insertTick({
          uuid: 'tick-hardest-' + climb.key,
          climbUuid,
          climbedAt: '2026-02-01 10:00:00',
          status: 'send',
          difficulty: climb.logged ?? undefined,
        });
      }

      const result = await callUserAscentsFeed(TEST_USER_ID, { sortBy: 'hardest' });

      expect(result.items.map((item) => item.climbName)).toEqual(['D', 'A', 'E', 'B', 'C']);
    });

    it('breaks ties on ascent date (more recent first) when the effective grade matches', async () => {
      // Same consensus, both ungraded (effective == consensus), so only climbedAt
      // separates them — exercises the climbedAt tiebreaker after the effective-grade key.
      const older = CLIMB_PREFIX + 'tiebreak-older';
      const newer = CLIMB_PREFIX + 'tiebreak-newer';
      await insertClimb(older, 'Older');
      await insertClimb(newer, 'Newer');
      await insertBoardClimbStats({ climbUuid: older, displayDifficulty: 15 });
      await insertBoardClimbStats({ climbUuid: newer, displayDifficulty: 15 });
      await insertTick({
        uuid: 'tick-tiebreak-older',
        climbUuid: older,
        climbedAt: '2026-02-01 10:00:00',
        status: 'send',
      });
      await insertTick({
        uuid: 'tick-tiebreak-newer',
        climbUuid: newer,
        climbedAt: '2026-03-15 10:00:00',
        status: 'send',
      });

      const result = await callUserAscentsFeed(TEST_USER_ID, { sortBy: 'hardest' });

      expect(result.items.map((item) => item.climbName)).toEqual(['Newer', 'Older']);
    });
  });

  describe('userAscentsFeed — easiest sort', () => {
    it('orders by effective grade asc, so ungraded ticks sort by consensus not last', async () => {
      // All ungraded, so effective grade == consensus. Before the fix, easiest
      // sorted by the (NULL) logged grade and these would tie/float; effective
      // grade orders them by consensus.
      const seeded: Array<{ key: string; consensus: number }> = [
        { key: 'Hard', consensus: 15 },
        { key: 'Easy', consensus: 5 },
        { key: 'Mid', consensus: 10 },
      ];
      for (const climb of seeded) {
        const climbUuid = CLIMB_PREFIX + 'easiest-' + climb.key;
        await insertClimb(climbUuid, climb.key);
        await insertBoardClimbStats({ climbUuid, displayDifficulty: climb.consensus });
        await insertTick({
          uuid: 'tick-easiest-' + climb.key,
          climbUuid,
          climbedAt: '2026-02-01 10:00:00',
          status: 'send',
        });
      }

      const result = await callUserAscentsFeed(TEST_USER_ID, { sortBy: 'easiest' });

      expect(result.items.map((item) => item.climbName)).toEqual(['Easy', 'Mid', 'Hard']);
    });

    it('interleaves a graded and an ungraded tick by effective grade', async () => {
      // The graded tick logs hard (12); the ungraded one's consensus is easy (5).
      // effective-grade asc puts the ungraded (5) first — the old loggedGrade asc
      // would have floated the NULL-logged ungraded tick to the end instead.
      const graded = CLIMB_PREFIX + 'easiest-mixed-graded';
      const ungraded = CLIMB_PREFIX + 'easiest-mixed-ungraded';
      await insertClimb(graded, 'Graded');
      await insertClimb(ungraded, 'Ungraded');
      await insertBoardClimbStats({ climbUuid: graded, displayDifficulty: 8 });
      await insertBoardClimbStats({ climbUuid: ungraded, displayDifficulty: 5 });
      await insertTick({
        uuid: 'tick-easiest-mixed-graded',
        climbUuid: graded,
        climbedAt: '2026-02-01 10:00:00',
        status: 'send',
        difficulty: 12,
      });
      await insertTick({
        uuid: 'tick-easiest-mixed-ungraded',
        climbUuid: ungraded,
        climbedAt: '2026-02-01 10:00:00',
        status: 'send',
      });

      const result = await callUserAscentsFeed(TEST_USER_ID, { sortBy: 'easiest' });

      expect(result.items.map((item) => item.climbName)).toEqual(['Ungraded', 'Graded']);
    });
  });

  describe('userAscentsFeed — flashOnly filter', () => {
    it('returns only flashes when flashOnly=true regardless of statusMode', async () => {
      const climbUuid = CLIMB_PREFIX + 'flash-only';
      await insertClimb(climbUuid, 'Flash Only Test');

      await insertTick({
        uuid: 'tick-flash-1',
        climbUuid,
        climbedAt: '2026-01-01 10:00:00',
        status: 'flash',
      });
      await insertTick({
        uuid: 'tick-send-1',
        climbUuid,
        climbedAt: '2026-01-02 10:00:00',
        status: 'send',
        attemptCount: 3,
      });
      await insertTick({
        uuid: 'tick-attempt-1',
        climbUuid,
        climbedAt: '2026-01-03 10:00:00',
        status: 'attempt',
        attemptCount: 5,
      });

      // statusMode=both + flashOnly=true: previously this returned flash + attempts.
      const result = await callUserAscentsFeed(TEST_USER_ID, {
        statusMode: 'both',
        flashOnly: true,
        limit: 50,
      });

      expect(result.items.every((item) => item.status === 'flash')).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.totalCount).toBe(1);
    });

    it('returns flash+send when flashOnly=false and statusMode=send', async () => {
      const climbUuid = CLIMB_PREFIX + 'send-mode';
      await insertClimb(climbUuid, 'Send Mode Test');

      await insertTick({
        uuid: 'tick-flash-2',
        climbUuid,
        climbedAt: '2026-01-01 10:00:00',
        status: 'flash',
      });
      await insertTick({
        uuid: 'tick-send-2',
        climbUuid,
        climbedAt: '2026-01-02 10:00:00',
        status: 'send',
        attemptCount: 2,
      });
      await insertTick({
        uuid: 'tick-attempt-2',
        climbUuid,
        climbedAt: '2026-01-03 10:00:00',
        status: 'attempt',
        attemptCount: 4,
      });

      const result = await callUserAscentsFeed(TEST_USER_ID, {
        statusMode: 'send',
        flashOnly: false,
        limit: 50,
      });

      const statuses = result.items.map((item) => item.status).sort();
      expect(statuses).toEqual(['flash', 'send']);
    });

    it('returns only attempts when statusMode=attempt', async () => {
      const climbUuid = CLIMB_PREFIX + 'attempt-mode';
      await insertClimb(climbUuid, 'Attempt Mode Test');

      await insertTick({
        uuid: 'tick-flash-3',
        climbUuid,
        climbedAt: '2026-01-01 10:00:00',
        status: 'flash',
      });
      await insertTick({
        uuid: 'tick-attempt-3',
        climbUuid,
        climbedAt: '2026-01-02 10:00:00',
        status: 'attempt',
        attemptCount: 2,
      });

      const result = await callUserAscentsFeed(TEST_USER_ID, { statusMode: 'attempt', limit: 50 });

      expect(result.items.every((item) => item.status === 'attempt')).toBe(true);
      expect(result.items).toHaveLength(1);
    });
  });

  describe('userAscentsFeed — MoonBoard grade ids', () => {
    it('resolves MoonBoard 6B ticks from shared difficulty id 18', async () => {
      const climbUuid = CLIMB_PREFIX + 'moonboard-6b';
      await db.execute(sql`
        INSERT INTO board_difficulty_grades (board_type, difficulty, boulder_name, route_name, is_listed)
        VALUES ('moonboard', 18, '6b/V4', NULL, true)
        ON CONFLICT (board_type, difficulty)
        DO UPDATE SET
          boulder_name = EXCLUDED.boulder_name,
          route_name = EXCLUDED.route_name,
          is_listed = EXCLUDED.is_listed
      `);
      await insertClimb(climbUuid, 'On fire - the real 6B', { boardType: 'moonboard', layoutId: 5 });
      await db.execute(sql`
        INSERT INTO board_climb_stats (
          board_type,
          climb_uuid,
          angle,
          display_difficulty,
          ascensionist_count,
          difficulty_average,
          quality_average
        )
        VALUES ('moonboard', ${climbUuid}, 40, 18, 1, 18, 4)
        ON CONFLICT (board_type, climb_uuid, angle)
        DO UPDATE SET
          display_difficulty = EXCLUDED.display_difficulty,
          ascensionist_count = EXCLUDED.ascensionist_count,
          difficulty_average = EXCLUDED.difficulty_average,
          quality_average = EXCLUDED.quality_average
      `);

      await insertTick({
        uuid: 'tick-moonboard-6b',
        climbUuid,
        boardType: 'moonboard',
        difficulty: 18,
        climbedAt: '2026-01-01 10:00:00',
        status: 'send',
      });

      const result = await callUserAscentsFeed(TEST_USER_ID, { boardType: 'moonboard', limit: 50 });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].difficulty).toBe(18);
      expect(result.items[0].difficultyName).toBe('6b/V4');
      expect(result.items[0].consensusDifficulty).toBe(18);
      expect(result.items[0].consensusDifficultyName).toBe('6b/V4');
    });
  });

  describe('userAscentsFeed — climbName LIKE escaping', () => {
    it('matches a literal % in the search string instead of treating it as a wildcard', async () => {
      const literalUuid = CLIMB_PREFIX + 'literal-percent';
      const decoyUuid = CLIMB_PREFIX + 'decoy';
      await insertClimb(literalUuid, '100% Crimps');
      await insertClimb(decoyUuid, 'All Jugs');

      await insertTick({
        uuid: 'tick-literal-1',
        climbUuid: literalUuid,
        climbedAt: '2026-01-01 10:00:00',
        status: 'send',
      });
      await insertTick({
        uuid: 'tick-decoy-1',
        climbUuid: decoyUuid,
        climbedAt: '2026-01-02 10:00:00',
        status: 'send',
      });

      const result = await callUserAscentsFeed(TEST_USER_ID, { climbName: '100%', limit: 50 });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].climbName).toBe('100% Crimps');
    });

    it('treats _ as a literal underscore, not a single-char wildcard', async () => {
      const literalUuid = CLIMB_PREFIX + 'literal-underscore';
      const decoyUuid = CLIMB_PREFIX + 'decoy-underscore';
      await insertClimb(literalUuid, 'V_Five');
      await insertClimb(decoyUuid, 'VxFive'); // would match `V_Five` if _ were a wildcard

      await insertTick({
        uuid: 'tick-underscore-1',
        climbUuid: literalUuid,
        climbedAt: '2026-01-01 10:00:00',
        status: 'send',
      });
      await insertTick({
        uuid: 'tick-underscore-2',
        climbUuid: decoyUuid,
        climbedAt: '2026-01-02 10:00:00',
        status: 'send',
      });

      const result = await callUserAscentsFeed(TEST_USER_ID, { climbName: 'V_Five', limit: 50 });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].climbName).toBe('V_Five');
    });

    it('still matches plain substrings', async () => {
      const climbUuid = CLIMB_PREFIX + 'plain-substring';
      await insertClimb(climbUuid, 'Sloper Madness');

      await insertTick({
        uuid: 'tick-plain-1',
        climbUuid,
        climbedAt: '2026-01-01 10:00:00',
        status: 'send',
      });

      const result = await callUserAscentsFeed(TEST_USER_ID, { climbName: 'Sloper', limit: 50 });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].climbName).toBe('Sloper Madness');
    });
  });

  describe('userGroupedAscentsFeed — pagination & grouping', () => {
    it('returns empty groups + totalCount=0 when the user has no ticks', async () => {
      const result = await callUserGroupedAscentsFeed(TEST_USER_ID, { limit: 20, offset: 0 });

      expect(result.groups).toEqual([]);
      expect(result.totalCount).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it('returns one group with one item for a single tick', async () => {
      const climbUuid = CLIMB_PREFIX + 'single-tick';
      await insertClimb(climbUuid, 'Single Tick Climb');
      await insertTick({
        uuid: 'tick-single-1',
        climbUuid,
        climbedAt: '2026-02-01 10:00:00',
        status: 'send',
      });

      const result = await callUserGroupedAscentsFeed(TEST_USER_ID, { limit: 20, offset: 0 });

      expect(result.groups).toHaveLength(1);
      expect(result.totalCount).toBe(1);
      expect(result.hasMore).toBe(false);
      expect(result.groups[0].climbUuid).toBe(climbUuid);
      expect(result.groups[0].items).toHaveLength(1);
      expect(result.groups[0].sendCount).toBe(1);
      expect(result.groups[0].date).toBe('2026-02-01');
    });

    it('groups multiple ticks on the same climb on the same day into a single group', async () => {
      const climbUuid = CLIMB_PREFIX + 'multi-attempt';
      await insertClimb(climbUuid, 'Project');

      await insertTick({
        uuid: 'tick-proj-1',
        climbUuid,
        climbedAt: '2026-02-05 09:00:00',
        status: 'attempt',
        attemptCount: 3,
      });
      await insertTick({
        uuid: 'tick-proj-2',
        climbUuid,
        climbedAt: '2026-02-05 14:00:00',
        status: 'attempt',
        attemptCount: 2,
      });
      await insertTick({
        uuid: 'tick-proj-3',
        climbUuid,
        climbedAt: '2026-02-05 16:00:00',
        status: 'send',
        attemptCount: 4,
      });

      const result = await callUserGroupedAscentsFeed(TEST_USER_ID, { limit: 20, offset: 0 });

      expect(result.groups).toHaveLength(1);
      expect(result.totalCount).toBe(1);
      expect(result.groups[0].items).toHaveLength(3);
      expect(result.groups[0].sendCount).toBe(1);
      expect(result.groups[0].attemptCount).toBe(2);
      expect(result.groups[0].date).toBe('2026-02-05');
    });

    it('keeps ticks on the same climb on different days as separate groups', async () => {
      const climbUuid = CLIMB_PREFIX + 'multi-day';
      await insertClimb(climbUuid, 'Multi Day Project');

      await insertTick({
        uuid: 'tick-md-1',
        climbUuid,
        climbedAt: '2026-03-01 11:00:00',
        status: 'attempt',
        attemptCount: 3,
      });
      await insertTick({
        uuid: 'tick-md-2',
        climbUuid,
        climbedAt: '2026-03-02 11:00:00',
        status: 'attempt',
        attemptCount: 2,
      });
      await insertTick({
        uuid: 'tick-md-3',
        climbUuid,
        climbedAt: '2026-03-03 11:00:00',
        status: 'send',
        attemptCount: 1,
      });

      const result = await callUserGroupedAscentsFeed(TEST_USER_ID, { limit: 20, offset: 0 });

      expect(result.groups).toHaveLength(3);
      expect(result.totalCount).toBe(3);
      // Newest first
      expect(result.groups.map((g) => g.date)).toEqual(['2026-03-03', '2026-03-02', '2026-03-01']);
    });

    it('does NOT shift the day for ticks logged late at night (no UTC timezone bug)', async () => {
      // The previous implementation used `to_char(...AT TIME ZONE 'UTC', 'YYYY-MM-DD')`
      // which could shift wall-clock-late-at-night ticks into the next UTC day.
      // climbed_at is `timestamp without time zone` and stores wall-clock time, so
      // grouping should reflect the literal stored date with no zone math.
      const climbUuid = CLIMB_PREFIX + 'late-night';
      await insertClimb(climbUuid, 'Late Night Send');

      await insertTick({
        uuid: 'tick-late-1',
        climbUuid,
        climbedAt: '2026-04-01 23:30:00',
        status: 'send',
        attemptCount: 1,
      });
      await insertTick({
        uuid: 'tick-late-2',
        climbUuid,
        climbedAt: '2026-04-02 00:30:00',
        status: 'send',
        attemptCount: 1,
      });

      const result = await callUserGroupedAscentsFeed(TEST_USER_ID, { limit: 20, offset: 0 });

      expect(result.groups).toHaveLength(2);
      expect(result.groups.map((g) => g.date).sort()).toEqual(['2026-04-01', '2026-04-02']);
    });

    it('paginates groups in SQL with correct totalCount and hasMore', async () => {
      // Create 5 distinct (climb, day) groups with one tick each.
      for (let i = 0; i < 5; i++) {
        const climbUuid = `${CLIMB_PREFIX}page-${i}`;
        await insertClimb(climbUuid, `Page Climb ${i}`);
        await insertTick({
          uuid: `tick-page-${i}`,
          climbUuid,
          // i=0 is oldest, i=4 is newest — descending order in the response should be 4,3,2,1,0
          climbedAt: `2026-05-0${i + 1} 12:00:00`,
          status: 'send',
        });
      }

      const page1 = await callUserGroupedAscentsFeed(TEST_USER_ID, { limit: 2, offset: 0 });
      expect(page1.groups).toHaveLength(2);
      expect(page1.totalCount).toBe(5);
      expect(page1.hasMore).toBe(true);
      expect(page1.groups.map((g) => g.date)).toEqual(['2026-05-05', '2026-05-04']);

      const page2 = await callUserGroupedAscentsFeed(TEST_USER_ID, { limit: 2, offset: 2 });
      expect(page2.groups).toHaveLength(2);
      expect(page2.totalCount).toBe(5);
      expect(page2.hasMore).toBe(true);
      expect(page2.groups.map((g) => g.date)).toEqual(['2026-05-03', '2026-05-02']);

      const page3 = await callUserGroupedAscentsFeed(TEST_USER_ID, { limit: 2, offset: 4 });
      expect(page3.groups).toHaveLength(1);
      expect(page3.totalCount).toBe(5);
      expect(page3.hasMore).toBe(false);
      expect(page3.groups.map((g) => g.date)).toEqual(['2026-05-01']);
    });

    it('only returns groups for the requested user', async () => {
      const climbUuid = CLIMB_PREFIX + 'multi-user';
      await insertClimb(climbUuid, 'Shared Climb');

      await insertTick({
        uuid: 'tick-mine',
        userId: TEST_USER_ID,
        climbUuid,
        climbedAt: '2026-06-01 10:00:00',
        status: 'send',
      });
      await insertTick({
        uuid: 'tick-theirs',
        userId: OTHER_USER_ID,
        climbUuid,
        climbedAt: '2026-06-01 10:00:00',
        status: 'send',
      });

      const result = await callUserGroupedAscentsFeed(TEST_USER_ID, { limit: 20, offset: 0 });

      expect(result.totalCount).toBe(1);
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].items).toHaveLength(1);
      expect(result.groups[0].items[0].uuid).toBe('tick-mine');
    });
  });

  describe('userClimbPercentile — snapshot reads', () => {
    it('returns the stored percentile snapshot for the requested user', async () => {
      await db.execute(sql`
        INSERT INTO user_climb_percentiles (user_id, total_distinct_climbs, percentile, total_active_users, computed_at)
        VALUES (${TEST_USER_ID}, 42, 87.5, 200, NOW())
      `);

      const result = await callUserClimbPercentile(TEST_USER_ID);

      expect(result).toEqual({
        totalDistinctClimbs: 42,
        percentile: 87.5,
        totalActiveUsers: 200,
      });
    });

    it('falls back to zero percentile while preserving the active-user count when a user has no snapshot row', async () => {
      await db.execute(sql`
        INSERT INTO user_climb_percentiles (user_id, total_distinct_climbs, percentile, total_active_users, computed_at)
        VALUES (${OTHER_USER_ID}, 12, 55, 88, NOW())
      `);

      const result = await callUserClimbPercentile(TEST_USER_ID);

      expect(result).toEqual({
        totalDistinctClimbs: 0,
        percentile: 0,
        totalActiveUsers: 88,
      });
    });
  });

  // Hard invariant from docs/ascents-and-attempts.md: a tick with
  // `difficulty IS NULL` must bucket under the climb's consensus grade,
  // not be silently dropped from per-grade aggregates / range filters.
  describe('NULL-difficulty ticks fall back to consensus grade', () => {
    it('userTicks exposes raw difficulty and effectiveDifficulty (consensus fallback)', async () => {
      const climbUuid = CLIMB_PREFIX + 'null-diff-userticks';
      await insertClimb(climbUuid, 'Null-diff via userTicks');
      await insertBoardClimbStats({ climbUuid, displayDifficulty: 22.4 });

      // User-graded tick on the same climb at a different angle
      await insertTick({
        uuid: 'tick-null-diff-graded',
        climbUuid,
        climbedAt: '2026-04-01 10:00:00',
        status: 'flash',
        difficulty: 18,
        angle: 30,
      });

      // Ungraded tick — should bucket at consensus (ROUND(22.4) = 22)
      await insertTick({
        uuid: 'tick-null-diff-ungraded',
        climbUuid,
        climbedAt: '2026-04-02 10:00:00',
        status: 'send',
        attemptCount: 2,
      });

      const ticks = (await tickQueries.userTicks(undefined, {
        userId: TEST_USER_ID,
        boardType: 'kilter',
      })) as Array<{
        uuid: string;
        difficulty: number | null;
        effectiveDifficulty: number | null;
      }>;

      const graded = ticks.find((t) => t.uuid === 'tick-null-diff-graded');
      const ungraded = ticks.find((t) => t.uuid === 'tick-null-diff-ungraded');

      // Raw field preserves user-state: null vs. explicit override.
      expect(graded?.difficulty).toBe(18);
      expect(ungraded?.difficulty).toBeNull();
      // Effective field falls back to consensus for the ungraded tick.
      expect(graded?.effectiveDifficulty).toBe(18);
      expect(ungraded?.effectiveDifficulty).toBe(22);
    });

    it('userProfileStats buckets NULL-difficulty ticks under the consensus grade', async () => {
      const gradedClimb = CLIMB_PREFIX + 'null-diff-stats-graded';
      const ungradedClimb = CLIMB_PREFIX + 'null-diff-stats-ungraded';
      await insertClimb(gradedClimb, 'graded climb');
      await insertClimb(ungradedClimb, 'ungraded climb');
      await insertBoardClimbStats({ climbUuid: ungradedClimb, displayDifficulty: 19.8 });

      await insertTick({
        uuid: 'tick-stats-graded',
        climbUuid: gradedClimb,
        climbedAt: '2026-04-01 10:00:00',
        status: 'flash',
        difficulty: 16,
      });
      await insertTick({
        uuid: 'tick-stats-ungraded',
        climbUuid: ungradedClimb,
        climbedAt: '2026-04-02 10:00:00',
        status: 'flash',
      });

      const stats = (await tickQueries.userProfileStats(undefined, { userId: TEST_USER_ID })) as {
        totalDistinctClimbs: number;
        layoutStats: Array<{
          layoutKey: string;
          distinctClimbCount: number;
          gradeCounts: Array<{ grade: string; count: number }>;
        }>;
      };

      const kilter1 = stats.layoutStats.find((l) => l.layoutKey === 'kilter-1');
      expect(kilter1).toBeDefined();
      // Both climbs counted distinctly.
      expect(kilter1?.distinctClimbCount).toBe(2);
      // Both grades present — the ungraded one bucketed at ROUND(19.8) = 20.
      const gradeMap = new Map(kilter1?.gradeCounts.map((gc) => [gc.grade, gc.count]) ?? []);
      expect(gradeMap.get('16')).toBe(1);
      expect(gradeMap.get('20')).toBe(1);
    });

    it('userAscentsFeed minDifficulty includes NULL-difficulty ticks whose consensus is in range', async () => {
      const climbUuid = CLIMB_PREFIX + 'null-diff-feed-filter';
      await insertClimb(climbUuid, 'feed filter test');
      await insertBoardClimbStats({ climbUuid, displayDifficulty: 24.1 });

      // Tick has no user grade; consensus rounds to 24
      await insertTick({
        uuid: 'tick-feed-ungraded',
        climbUuid,
        climbedAt: '2026-04-03 10:00:00',
        status: 'flash',
      });

      const inRange = await callUserAscentsFeed(TEST_USER_ID, { minDifficulty: 22, maxDifficulty: 26, limit: 50 });
      expect(inRange.items.map((i) => i.uuid)).toContain('tick-feed-ungraded');

      const outOfRange = await callUserAscentsFeed(TEST_USER_ID, { minDifficulty: 26, limit: 50 });
      expect(outOfRange.items.map((i) => i.uuid)).not.toContain('tick-feed-ungraded');
    });
  });

  // The catalog dedup picks one UUID as canonical (a board_climbs row) and
  // records the rest as aliases (board_climb_aliases rows with NO board_climbs
  // row). A tick on a deduped-away alias UUID must resolve to the canonical
  // climb's name/grade/stats via the alias hop — otherwise it renders
  // "Unknown Climb". See the alias resolution in resolvers/ticks/queries.ts.
  describe('dedup-merged alias ticks resolve to the canonical climb', () => {
    it('userAscentsFeed surfaces the canonical name + consensus grade for an aliased tick', async () => {
      const canonicalUuid = CLIMB_PREFIX + 'alias-canonical';
      const aliasUuid = CLIMB_PREFIX + 'alias-merged-away';

      // Only the canonical exists in board_climbs; the alias UUID has no climb row.
      await insertClimb(canonicalUuid, 'The Canonical Climb');
      await insertBoardClimbStats({ climbUuid: canonicalUuid, displayDifficulty: 21 });
      await insertAlias({ aliasUuid, canonicalUuid });

      // Tick points at the deduped-away alias UUID.
      await insertTick({
        uuid: 'tick-aliased-1',
        climbUuid: aliasUuid,
        climbedAt: '2026-07-01 10:00:00',
        status: 'send',
      });

      const result = await callUserAscentsFeed(TEST_USER_ID, { limit: 50 });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].uuid).toBe('tick-aliased-1');
      // Without alias resolution this would be "Unknown Climb".
      expect(result.items[0].climbName).toBe('The Canonical Climb');
      // Stats live on the canonical, so the consensus grade must resolve too.
      expect(result.items[0].consensusDifficulty).toBe(21);
    });

    it('userTicks populates layoutId for an aliased tick via the canonical', async () => {
      const canonicalUuid = CLIMB_PREFIX + 'alias-canonical-layout';
      const aliasUuid = CLIMB_PREFIX + 'alias-merged-layout';

      await insertClimb(canonicalUuid, 'Canonical With Layout', { layoutId: 8 });
      await insertAlias({ aliasUuid, canonicalUuid });

      await insertTick({
        uuid: 'tick-aliased-layout',
        climbUuid: aliasUuid,
        climbedAt: '2026-07-02 10:00:00',
        status: 'flash',
      });

      const ticks = (await tickQueries.userTicks(undefined, {
        userId: TEST_USER_ID,
        boardType: 'kilter',
      })) as Array<{ uuid: string; climbUuid: string; layoutId: number | null }>;
      const aliased = ticks.find((t) => t.uuid === 'tick-aliased-layout');

      expect(aliased).toBeDefined();
      // climbUuid stays the raw tick value (downstream maps it), but the
      // board_climbs join must resolve via the canonical to populate layoutId.
      expect(aliased?.climbUuid).toBe(aliasUuid);
      expect(aliased?.layoutId).toBe(8);
    });

    it('userGroupedAscentsFeed names the group from the canonical for an aliased tick', async () => {
      const canonicalUuid = CLIMB_PREFIX + 'alias-canonical-grouped';
      const aliasUuid = CLIMB_PREFIX + 'alias-merged-grouped';

      await insertClimb(canonicalUuid, 'Canonical Grouped Climb');
      await insertAlias({ aliasUuid, canonicalUuid });

      await insertTick({
        uuid: 'tick-aliased-grouped',
        climbUuid: aliasUuid,
        climbedAt: '2026-07-03 10:00:00',
        status: 'send',
      });

      const result = await callUserGroupedAscentsFeed(TEST_USER_ID, { limit: 20, offset: 0 });

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].climbName).toBe('Canonical Grouped Climb');
    });

    it('a tick already on a canonical UUID is unchanged (no alias row needed)', async () => {
      const canonicalUuid = CLIMB_PREFIX + 'canonical-no-alias';
      await insertClimb(canonicalUuid, 'Direct Canonical Climb');

      await insertTick({
        uuid: 'tick-direct-canonical',
        climbUuid: canonicalUuid,
        climbedAt: '2026-07-04 10:00:00',
        status: 'send',
      });

      const result = await callUserAscentsFeed(TEST_USER_ID, { limit: 50 });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].climbName).toBe('Direct Canonical Climb');
    });
  });

  describe('userAscentCaptionMatches — quoted-name caption suggestions', () => {
    it('matches the quoted climb name anywhere in the logbook and returns board art', async () => {
      const climbUuid = CLIMB_PREFIX + 'caption-purple';
      await insertClimb(climbUuid, 'Purple Nurple');
      // An old send (not "recent") — must still surface from a caption match.
      await insertTick({ uuid: 'tick-caption-1', climbUuid, climbedAt: '2024-01-01 10:00:00', status: 'send' });

      // Boardsesh's caption format: name in quotes, with the user's words around it.
      const result = await callUserAscentCaptionMatches(TEST_USER_ID, 'Finally sent "Purple Nurple" @ 40° 🔥');

      expect(result).toHaveLength(1);
      expect(result[0].climbName).toBe('Purple Nurple');
      expect(result[0].uuid).toBe('tick-caption-1');
      // Full ascent row, so the board art (frames) is present for the picker.
      expect(result[0].frames).toBe('p1r1');
    });

    it('matches a climb logged ONLY as a flash (statusMode send includes flashes)', async () => {
      const climbUuid = CLIMB_PREFIX + 'caption-flash-only';
      await insertClimb(climbUuid, 'Flash Only Send');
      await insertTick({ uuid: 'tick-caption-flash', climbUuid, climbedAt: '2024-01-01 10:00:00', status: 'flash' });

      const result = await callUserAscentCaptionMatches(TEST_USER_ID, 'flashed "Flash Only Send" first go');

      expect(result).toHaveLength(1);
      expect(result[0].climbUuid).toBe(climbUuid);
      expect(result[0].status).toBe('flash');
    });

    it('returns nothing when the caption has no quoted name', async () => {
      const climbUuid = CLIMB_PREFIX + 'caption-noquote';
      await insertClimb(climbUuid, 'Purple Nurple');
      await insertTick({ uuid: 'tick-caption-nq', climbUuid, climbedAt: '2024-01-01 10:00:00', status: 'send' });

      // Name present but unquoted (e.g. a non-Boardsesh / MoonBoard caption).
      expect(await callUserAscentCaptionMatches(TEST_USER_ID, 'finally sent Purple Nurple today')).toEqual([]);
    });

    it('does not suggest attempt-only climbs (beta attaches to sends/flashes)', async () => {
      const climbUuid = CLIMB_PREFIX + 'caption-attempt';
      await insertClimb(climbUuid, 'Crimp Master');
      await insertTick({ uuid: 'tick-caption-att', climbUuid, climbedAt: '2024-01-01 10:00:00', status: 'attempt' });

      const result = await callUserAscentCaptionMatches(TEST_USER_ID, 'still projecting "Crimp Master"');

      expect(result).toEqual([]);
    });

    it('returns one suggestion per matched climb even with multiple sends', async () => {
      const climbUuid = CLIMB_PREFIX + 'caption-dup';
      await insertClimb(climbUuid, 'Slab Master');
      await insertTick({ uuid: 'tick-dup-1', climbUuid, climbedAt: '2024-01-01 10:00:00', status: 'send' });
      await insertTick({ uuid: 'tick-dup-2', climbUuid, climbedAt: '2024-02-01 10:00:00', status: 'flash' });

      const result = await callUserAscentCaptionMatches(TEST_USER_ID, 'sent "Slab Master" again');

      expect(result).toHaveLength(1);
      expect(result[0].climbUuid).toBe(climbUuid);
    });

    it('returns nothing for a blank caption', async () => {
      expect(await callUserAscentCaptionMatches(TEST_USER_ID, '   ')).toEqual([]);
    });

    it("only matches the requested user's logbook", async () => {
      const climbUuid = CLIMB_PREFIX + 'caption-user';
      await insertClimb(climbUuid, 'Shared Caption Climb');
      await insertTick({
        uuid: 'tick-caption-other',
        userId: OTHER_USER_ID,
        climbUuid,
        climbedAt: '2024-01-01 10:00:00',
        status: 'send',
      });

      const result = await callUserAscentCaptionMatches(TEST_USER_ID, 'sent "Shared Caption Climb"');

      expect(result).toEqual([]);
    });

    it('surfaces the canonical name for an aliased (deduped-away) send', async () => {
      const canonicalUuid = CLIMB_PREFIX + 'caption-canonical';
      const aliasUuid = CLIMB_PREFIX + 'caption-alias';
      await insertClimb(canonicalUuid, 'Mega Classic');
      await insertAlias({ aliasUuid, canonicalUuid });
      await insertTick({
        uuid: 'tick-caption-alias',
        climbUuid: aliasUuid,
        climbedAt: '2024-01-01 10:00:00',
        status: 'send',
      });

      const result = await callUserAscentCaptionMatches(TEST_USER_ID, 'sent "Mega Classic" finally');

      expect(result).toHaveLength(1);
      expect(result[0].climbName).toBe('Mega Classic');
    });
  });
});
