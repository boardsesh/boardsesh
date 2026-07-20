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
  boardseshDifficulty: number | null;
  boardseshConfidence: string | null;
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
  isBenchmark: boolean;
};

type Group = {
  climbUuid: string;
  climbName: string;
  date: string;
  items: GroupedItem[];
  flashCount: number;
  sendCount: number;
  attemptCount: number;
  isBenchmark: boolean;
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
    Array<{
      uuid: string;
      climbUuid: string;
      climbName: string;
      status: string;
      frames: string | null;
      hasBetaVideo: boolean;
    }>
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

const callTicks = (input: { boardType: string; climbUuids?: string[] }, userId: string = TEST_USER_ID) =>
  tickQueries.ticks(
    undefined,
    { input },
    {
      connectionId: 'tick-queries-test-conn',
      isAuthenticated: true,
      userId,
      sessionId: undefined,
      controllerId: undefined,
      controllerApiKey: undefined,
    },
  ) as Promise<Array<{ uuid: string; quality: number | null; effectiveQuality: number | null }>>;

const callUserTicks = (userId: string, boardType: string) =>
  tickQueries.userTicks(undefined, { userId, boardType }) as Promise<
    Array<{ uuid: string; quality: number | null; effectiveQuality: number | null }>
  >;

const callUserTickCountsByBoard = (userId: string) =>
  tickQueries.userTickCountsByBoard(undefined, { userId }) as Promise<Array<{ boardType: string; count: number }>>;

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
  boardId?: number;
}) => {
  const userId = params.userId ?? TEST_USER_ID;
  const attemptCount = params.attemptCount ?? 1;
  const boardType = params.boardType ?? 'kilter';
  const angle = params.angle ?? 40;
  await db.execute(sql`
    INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, attempt_count, difficulty, climbed_at, board_id)
    VALUES (${params.uuid}, ${userId}, ${boardType}, ${params.climbUuid}, ${angle}, ${params.status}, ${attemptCount}, ${params.difficulty ?? null}, ${params.climbedAt}, ${params.boardId ?? null})
  `);
};

const insertPrivateBoard = async (name: string): Promise<number> => {
  const rows = (await db.execute(sql`
    INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, is_public)
    VALUES (${`${CLIMB_PREFIX}board-${name}`}, ${`${CLIMB_PREFIX}slug-${name}`}, ${TEST_USER_ID}, 'kilter', 1, 1, '1', ${name}, false)
    RETURNING id
  `)) as unknown as Array<{ id: number }>;
  return Number(rows[0].id);
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
  benchmarkDifficulty?: number;
}) => {
  const boardType = params.boardType ?? 'kilter';
  const angle = params.angle ?? 40;
  await db.execute(sql`
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, benchmark_difficulty, ascensionist_count, difficulty_average, quality_average)
    VALUES (${boardType}, ${params.climbUuid}, ${angle}, ${params.displayDifficulty}, ${params.benchmarkDifficulty ?? null}, 10, ${params.displayDifficulty}, 4)
    ON CONFLICT (board_type, climb_uuid, angle) DO UPDATE SET display_difficulty = excluded.display_difficulty, benchmark_difficulty = excluded.benchmark_difficulty
  `);
};

const insertBoardClimbGrade = async (params: {
  climbUuid: string;
  boardType?: string;
  angle?: number;
  localGrade?: number | null;
  universalGrade?: number | null;
  confidence?: string;
}) => {
  const boardType = params.boardType ?? 'kilter';
  const angle = params.angle ?? 40;
  await db.execute(sql`
    INSERT INTO board_climb_grades (board_type, climb_uuid, angle, local_grade, universal_grade, confidence, ascensionist_count, model_version, coeff_version, computed_at)
    VALUES (${boardType}, ${params.climbUuid}, ${angle}, ${params.localGrade ?? null}, ${params.universalGrade ?? null}, ${params.confidence ?? 'confirmed'}, 25, 'test-model', 'test-coeff', now())
    ON CONFLICT (board_type, climb_uuid, angle) DO UPDATE SET
      local_grade = excluded.local_grade,
      universal_grade = excluded.universal_grade,
      confidence = excluded.confidence
  `);
};

const insertClimbRating = async (params: {
  climbUuid: string;
  rating: number | null;
  userId?: string;
  boardType?: string;
  angle?: number;
}) => {
  const userId = params.userId ?? TEST_USER_ID;
  const boardType = params.boardType ?? 'kilter';
  const angle = params.angle ?? 40;
  await db.execute(sql`
    INSERT INTO board_climb_ratings (board_type, climb_uuid, angle, user_id, rating)
    VALUES (${boardType}, ${params.climbUuid}, ${angle}, ${userId}, ${params.rating})
    ON CONFLICT (board_type, climb_uuid, angle, user_id) DO UPDATE SET rating = excluded.rating
  `);
};

const cleanup = async () => {
  await db.execute(sql`DELETE FROM user_climb_percentiles WHERE user_id IN (${TEST_USER_ID}, ${OTHER_USER_ID})`);
  await db.execute(sql`DELETE FROM board_climb_ratings WHERE user_id IN (${TEST_USER_ID}, ${OTHER_USER_ID})`);
  await db.execute(sql`DELETE FROM board_beta_links WHERE climb_uuid LIKE ${CLIMB_PREFIX + '%'}`);
  await db.execute(sql`DELETE FROM boardsesh_ticks WHERE user_id IN (${TEST_USER_ID}, ${OTHER_USER_ID})`);
  await db.execute(sql`DELETE FROM user_boards WHERE owner_id IN (${TEST_USER_ID}, ${OTHER_USER_ID})`);
  await db.execute(sql`DELETE FROM board_climb_grades WHERE climb_uuid LIKE ${CLIMB_PREFIX + '%'}`);
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

  describe('userAscentsFeed — hasBetaVideo', () => {
    it('marks every ascent of a climb with an attached beta link, and no others', async () => {
      // Climb-level semantics: "do I have beta for this climb" — a tick-attached
      // link lights up ALL of the user's ascents of that climb.
      const withBetaUuid = `${CLIMB_PREFIX}beta`;
      const withoutBetaUuid = `${CLIMB_PREFIX}no-beta`;
      await insertClimb(withBetaUuid, 'Beta Test Climb');
      await insertClimb(withoutBetaUuid, 'No Beta Climb');
      await insertTick({
        uuid: 'tick-beta-1',
        climbUuid: withBetaUuid,
        climbedAt: '2026-06-01T10:00:00',
        status: 'send',
      });
      await insertTick({
        uuid: 'tick-beta-2',
        climbUuid: withBetaUuid,
        climbedAt: '2026-06-02T10:00:00',
        status: 'send',
      });
      await insertTick({
        uuid: 'tick-beta-3',
        climbUuid: withoutBetaUuid,
        climbedAt: '2026-06-03T10:00:00',
        status: 'send',
      });
      await db.execute(sql`
        INSERT INTO board_beta_links (board_type, climb_uuid, link, tick_uuid)
        VALUES ('kilter', ${withBetaUuid}, 'https://instagram.com/p/test-beta', 'tick-beta-1')
      `);

      const result = await callUserAscentsFeed(TEST_USER_ID, { sortBy: 'recent' });
      const byUuid = new Map(
        (result.items as Array<FeedItem & { hasBetaVideo: boolean }>).map((item) => [item.uuid, item.hasBetaVideo]),
      );
      expect(byUuid.get('tick-beta-1')).toBe(true);
      expect(byUuid.get('tick-beta-2')).toBe(true);
      expect(byUuid.get('tick-beta-3')).toBe(false);
    });

    it('matches legacy links by createdByUserId when tick_uuid is null', async () => {
      // Aurora-synced/backfilled rows carry no tick_uuid — ownership matches
      // the shelf's userBetaLinks semantics instead.
      const legacyUuid = `${CLIMB_PREFIX}beta-legacy`;
      await insertClimb(legacyUuid, 'Legacy Beta Climb');
      await insertTick({
        uuid: 'tick-beta-legacy',
        climbUuid: legacyUuid,
        climbedAt: '2026-06-04T10:00:00',
        status: 'send',
      });
      await db.execute(sql`
        INSERT INTO board_beta_links (board_type, climb_uuid, link, created_by_user_id)
        VALUES ('kilter', ${legacyUuid}, 'https://instagram.com/p/test-beta-legacy', ${TEST_USER_ID})
      `);

      const result = await callUserAscentsFeed(TEST_USER_ID, { sortBy: 'recent' });
      const byUuid = new Map(
        (result.items as Array<FeedItem & { hasBetaVideo: boolean }>).map((item) => [item.uuid, item.hasBetaVideo]),
      );
      expect(byUuid.get('tick-beta-legacy')).toBe(true);
    });

    it('flows hasBetaVideo through the caption-matches shared builder', async () => {
      // Caption matches de-dupe by CLIMB (keeping the most recent send), so
      // use two climbs with one tick each — a same-climb pair would collapse
      // to the newest tick and hide the beta-carrying one.
      const withBetaUuid = `${CLIMB_PREFIX}beta-cap-with`;
      const withoutBetaUuid = `${CLIMB_PREFIX}beta-cap-without`;
      await insertClimb(withBetaUuid, 'Beta Caption With');
      await insertClimb(withoutBetaUuid, 'Beta Caption Without');
      await insertTick({
        uuid: 'tick-beta-cap-1',
        climbUuid: withBetaUuid,
        climbedAt: '2026-06-01T10:00:00',
        status: 'send',
      });
      await insertTick({
        uuid: 'tick-beta-cap-2',
        climbUuid: withoutBetaUuid,
        climbedAt: '2026-06-02T10:00:00',
        status: 'send',
      });
      await db.execute(sql`
        INSERT INTO board_beta_links (board_type, climb_uuid, link, tick_uuid)
        VALUES ('kilter', ${withBetaUuid}, 'https://instagram.com/p/test-beta-cap', 'tick-beta-cap-1')
      `);

      const matches = await callUserAscentCaptionMatches(
        TEST_USER_ID,
        'Sent "Beta Caption With" and "Beta Caption Without" @ 40°',
      );
      const byUuid = new Map(matches.map((match) => [match.uuid, match.hasBetaVideo]));
      expect(byUuid.get('tick-beta-cap-1')).toBe(true);
      expect(byUuid.get('tick-beta-cap-2')).toBe(false);
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

  describe('userTickCountsByBoard — grouped per-board counts', () => {
    it('returns one row per board type with the tick count, scoped to the user', async () => {
      const kilterClimb = CLIMB_PREFIX + 'counts-kilter';
      const tensionClimb = CLIMB_PREFIX + 'counts-tension';
      await insertClimb(kilterClimb, 'Counts kilter', { boardType: 'kilter' });
      await insertClimb(tensionClimb, 'Counts tension', { boardType: 'tension' });

      // 3 kilter + 1 tension for the test user; another user's ticks must not leak.
      await insertTick({ uuid: CLIMB_PREFIX + 'c1', climbUuid: kilterClimb, climbedAt: '2024-01-01', status: 'send' });
      await insertTick({ uuid: CLIMB_PREFIX + 'c2', climbUuid: kilterClimb, climbedAt: '2024-01-02', status: 'send' });
      await insertTick({
        uuid: CLIMB_PREFIX + 'c3',
        climbUuid: kilterClimb,
        climbedAt: '2024-01-03',
        status: 'attempt',
      });
      await insertTick({
        uuid: CLIMB_PREFIX + 'c4',
        climbUuid: tensionClimb,
        climbedAt: '2024-01-04',
        status: 'flash',
        boardType: 'tension',
      });
      await insertTick({
        uuid: CLIMB_PREFIX + 'c5',
        userId: OTHER_USER_ID,
        climbUuid: kilterClimb,
        climbedAt: '2024-01-05',
        status: 'send',
      });

      const rows = await callUserTickCountsByBoard(TEST_USER_ID);
      const byBoard = Object.fromEntries(rows.map((row) => [row.boardType, row.count]));

      expect(byBoard).toEqual({ kilter: 3, tension: 1 });
    });

    it('returns an empty array for a user with no ticks and for a blank userId', async () => {
      expect(await callUserTickCountsByBoard(OTHER_USER_ID)).toEqual([]);
      expect(await callUserTickCountsByBoard('')).toEqual([]);
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

  describe('userGroupedAscentsFeed — filters & enrichment', () => {
    const seedProjectDay = async () => {
      const sentUuid = `${CLIMB_PREFIX}grouped-sent`;
      const projectUuid = `${CLIMB_PREFIX}grouped-project`;
      await insertClimb(sentUuid, 'Grouped Sent Climb');
      await insertClimb(projectUuid, 'Grouped Project Climb');
      // Same climb, same day: two burns then the send — one group of three.
      await insertTick({
        uuid: 'grp-a1',
        climbUuid: sentUuid,
        climbedAt: '2026-06-20T10:00:00',
        status: 'attempt',
        attemptCount: 3,
      });
      await insertTick({
        uuid: 'grp-a2',
        climbUuid: sentUuid,
        climbedAt: '2026-06-20T11:00:00',
        status: 'attempt',
        attemptCount: 2,
      });
      await insertTick({
        uuid: 'grp-s1',
        climbUuid: sentUuid,
        climbedAt: '2026-06-20T12:00:00',
        status: 'send',
        attemptCount: 1,
      });
      // A different climb still projecting that day.
      await insertTick({
        uuid: 'grp-p1',
        climbUuid: projectUuid,
        climbedAt: '2026-06-20T13:00:00',
        status: 'attempt',
        attemptCount: 4,
      });
      return { sentUuid, projectUuid };
    };

    type EnrichedGroup = {
      key: string;
      climbUuid: string;
      items: Array<{ uuid: string; status: string; hasBetaVideo: boolean; consensusDifficulty: number | null }>;
      flashCount: number;
      sendCount: number;
      attemptCount: number;
    };
    const callGrouped = (input: Record<string, unknown>) =>
      tickQueries.userGroupedAscentsFeed(undefined, { userId: TEST_USER_ID, input }) as Promise<{
        groups: EnrichedGroup[];
        totalCount: number;
        hasMore: boolean;
      }>;

    it('applies statusMode to groups AND their aggregates (sends-only hides project groups)', async () => {
      const { sentUuid, projectUuid } = await seedProjectDay();

      const sendsOnly = await callGrouped({ statusMode: 'send' });
      const groupClimbs = sendsOnly.groups.map((group) => group.climbUuid);
      expect(groupClimbs).toContain(sentUuid);
      // The still-projecting climb has no sends — its group must not appear,
      // and totalCount must agree with the filtered group list.
      expect(groupClimbs).not.toContain(projectUuid);
      expect(sendsOnly.totalCount).toBe(1);

      // The surviving group's aggregates reflect only the visible entries.
      const sentGroup = sendsOnly.groups.find((group) => group.climbUuid === sentUuid);
      expect(sentGroup?.items.map((item) => item.uuid)).toEqual(['grp-s1']);
      expect(sentGroup?.sendCount).toBe(1);
      expect(sentGroup?.attemptCount).toBe(0);
    });

    it('keeps burns and the send in ONE group with both statuses visible', async () => {
      const { sentUuid } = await seedProjectDay();

      const both = await callGrouped({ statusMode: 'both' });
      const sentGroup = both.groups.find((group) => group.climbUuid === sentUuid);
      expect(sentGroup?.items).toHaveLength(3);
      expect(sentGroup?.sendCount).toBe(1);
      expect(sentGroup?.attemptCount).toBe(2);
      expect(both.totalCount).toBe(2);
    });

    it('filters by climbName without breaking group pagination counts', async () => {
      await seedProjectDay();

      const named = await callGrouped({ climbName: 'Grouped Project', statusMode: 'both' });
      expect(named.groups).toHaveLength(1);
      expect(named.totalCount).toBe(1);
      expect(named.hasMore).toBe(false);
    });

    it('gates board identity on group items by viewer, like the flat feed', async () => {
      const climbUuid = `${CLIMB_PREFIX}grouped-board`;
      await insertClimb(climbUuid, 'Grouped Board Climb');
      const boardId = await insertPrivateBoard('Secret Garage');
      await insertTick({ uuid: 'grp-b1', climbUuid, climbedAt: '2026-06-21T10:00:00', status: 'send', boardId });

      type BoardItem = { uuid: string; boardDisplayName: string | null };
      const asOwner = (await tickQueries.userGroupedAscentsFeed(
        undefined,
        { userId: TEST_USER_ID, input: {} },
        {
          connectionId: 'grouped-test-conn',
          isAuthenticated: true,
          userId: TEST_USER_ID,
          sessionId: undefined,
          controllerId: undefined,
          controllerApiKey: undefined,
        },
      )) as { groups: Array<{ climbUuid: string; items: BoardItem[] }> };
      const ownGroup = asOwner.groups.find((group) => group.climbUuid === climbUuid);
      expect(ownGroup?.items[0]?.boardDisplayName).toBe('Secret Garage');

      const asPublic = (await tickQueries.userGroupedAscentsFeed(undefined, {
        userId: TEST_USER_ID,
        input: {},
      })) as { groups: Array<{ climbUuid: string; items: BoardItem[] }> };
      const publicGroup = asPublic.groups.find((group) => group.climbUuid === climbUuid);
      expect(publicGroup?.items[0]?.boardDisplayName).toBeNull();
    });

    it('enriches group items with hasBetaVideo under ownership semantics', async () => {
      const { sentUuid, projectUuid } = await seedProjectDay();
      await db.execute(sql`
        INSERT INTO board_beta_links (board_type, climb_uuid, link, created_by_user_id)
        VALUES ('kilter', ${sentUuid}, 'https://instagram.com/p/grouped-beta', ${TEST_USER_ID})
      `);

      const both = await callGrouped({ statusMode: 'both' });
      const sentGroup = both.groups.find((group) => group.climbUuid === sentUuid);
      const projectGroup = both.groups.find((group) => group.climbUuid === projectUuid);
      expect(sentGroup?.items.every((item) => item.hasBetaVideo)).toBe(true);
      expect(projectGroup?.items.every((item) => !item.hasBetaVideo)).toBe(true);
    });

    it('flags the group header as benchmark when the consensus stats say so, matching its rows', async () => {
      // Consensus-benchmark climb (benchmark_difficulty > 0) ticked without the
      // tick's own is_benchmark flag. Both the header and the rows must resolve
      // to benchmark — regression guard for #3393 (header was on the raw flag).
      const climbUuid = `${CLIMB_PREFIX}grouped-benchmark`;
      await insertClimb(climbUuid, 'Consensus Benchmark');
      await insertBoardClimbStats({ climbUuid, displayDifficulty: 15, benchmarkDifficulty: 15 });
      await insertTick({
        uuid: 'grp-bench-1',
        climbUuid,
        climbedAt: '2026-06-25T10:00:00',
        status: 'send',
      });

      const result = await callUserGroupedAscentsFeed(TEST_USER_ID, { limit: 20, offset: 0 });
      const group = result.groups.find((candidate) => candidate.climbUuid === climbUuid);

      expect(group?.isBenchmark).toBe(true);
      expect(group?.items.every((item) => item.isBenchmark)).toBe(true);
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

  // The Boardsesh grade rides along on ascent rows so the UI can fall back to it
  // for ungraded ascents. COALESCE(universal_grade, local_grade) at the tick's
  // OWN angle; nullable everywhere (no grade row = keep the legacy grade).
  describe('userAscentsFeed — Boardsesh grade fallback fields', () => {
    it('surfaces COALESCE(universal, local) + confidence at the tick angle', async () => {
      const climbUuid = CLIMB_PREFIX + 'bsgrade-universal';
      await insertClimb(climbUuid, 'Universal Graded');
      await insertBoardClimbStats({ climbUuid, displayDifficulty: 15 });
      // Both grades present at the ticked angle → universal wins.
      await insertBoardClimbGrade({
        climbUuid,
        angle: 40,
        localGrade: 18.4,
        universalGrade: 17.9,
        confidence: 'confirmed',
      });
      await insertTick({
        uuid: 'tick-bsgrade-universal',
        climbUuid,
        climbedAt: '2026-07-01 10:00:00',
        status: 'send',
      });

      const result = await callUserAscentsFeed(TEST_USER_ID, { limit: 50 });
      const item = result.items.find((row) => row.uuid === 'tick-bsgrade-universal');
      expect(item?.boardseshDifficulty).toBeCloseTo(17.9);
      expect(item?.boardseshConfidence).toBe('confirmed');
    });

    it('falls back to local_grade when universal_grade is null', async () => {
      const climbUuid = CLIMB_PREFIX + 'bsgrade-local';
      await insertClimb(climbUuid, 'Local Only Graded');
      await insertBoardClimbGrade({
        climbUuid,
        angle: 40,
        localGrade: 12.0,
        universalGrade: null,
        confidence: 'provisional',
      });
      await insertTick({
        uuid: 'tick-bsgrade-local',
        climbUuid,
        climbedAt: '2026-07-02 10:00:00',
        status: 'send',
      });

      const result = await callUserAscentsFeed(TEST_USER_ID, { limit: 50 });
      const item = result.items.find((row) => row.uuid === 'tick-bsgrade-local');
      expect(item?.boardseshDifficulty).toBeCloseTo(12.0);
      expect(item?.boardseshConfidence).toBe('provisional');
    });

    it('returns null grade fields when no board_climb_grades row exists at the tick angle', async () => {
      const climbUuid = CLIMB_PREFIX + 'bsgrade-none';
      await insertClimb(climbUuid, 'Ungraded Climb');
      // Grade computed for a DIFFERENT angle only — the ticked angle has none.
      await insertBoardClimbGrade({ climbUuid, angle: 20, localGrade: 14, universalGrade: 14 });
      await insertTick({
        uuid: 'tick-bsgrade-none',
        climbUuid,
        angle: 40,
        climbedAt: '2026-07-03 10:00:00',
        status: 'send',
      });

      const result = await callUserAscentsFeed(TEST_USER_ID, { limit: 50 });
      const item = result.items.find((row) => row.uuid === 'tick-bsgrade-none');
      expect(item?.boardseshDifficulty).toBeNull();
      expect(item?.boardseshConfidence).toBeNull();
    });

    it('exposes the fields on userTicks (Tick shape) too', async () => {
      const climbUuid = CLIMB_PREFIX + 'bsgrade-userticks';
      await insertClimb(climbUuid, 'UserTicks Graded');
      await insertBoardClimbGrade({
        climbUuid,
        angle: 40,
        localGrade: 20.0,
        universalGrade: 19.2,
        confidence: 'confirmed',
      });
      await insertTick({
        uuid: 'tick-bsgrade-userticks',
        climbUuid,
        climbedAt: '2026-07-04 10:00:00',
        status: 'send',
      });

      const ticks = (await tickQueries.userTicks(undefined, {
        userId: TEST_USER_ID,
        boardType: 'kilter',
      })) as Array<{ uuid: string; boardseshDifficulty: number | null; boardseshConfidence: string | null }>;
      const graded = ticks.find((tick) => tick.uuid === 'tick-bsgrade-userticks');
      expect(graded?.boardseshDifficulty).toBeCloseTo(19.2);
      expect(graded?.boardseshConfidence).toBe('confirmed');
    });

    it('names the grade from the canonical climb for an aliased (deduped-away) tick', async () => {
      const canonicalUuid = CLIMB_PREFIX + 'bsgrade-alias-canonical';
      const aliasUuid = CLIMB_PREFIX + 'bsgrade-alias-merged';
      await insertClimb(canonicalUuid, 'Canonical Graded');
      await insertAlias({ aliasUuid, canonicalUuid });
      // Grade lives on the canonical UUID; the tick points at the alias.
      await insertBoardClimbGrade({
        climbUuid: canonicalUuid,
        angle: 40,
        localGrade: 16,
        universalGrade: 16.3,
        confidence: 'confirmed',
      });
      await insertTick({
        uuid: 'tick-bsgrade-aliased',
        climbUuid: aliasUuid,
        climbedAt: '2026-07-05 10:00:00',
        status: 'send',
      });

      const result = await callUserAscentsFeed(TEST_USER_ID, { limit: 50 });
      const item = result.items.find((row) => row.uuid === 'tick-bsgrade-aliased');
      expect(item?.boardseshDifficulty).toBeCloseTo(16.3);
    });
  });

  // A tick pulled from Kilter carries no per-tick quality, but the climber's
  // own star rating for that (climb, angle) may already live in
  // board_climb_ratings. The tick read paths LEFT JOIN it and expose
  // `effectiveQuality` = COALESCE(quality, rating). Ratings are 1-5 native — no
  // rescaling. See resolvers/ticks/queries.ts (boardClimbRatingsJoinCondition).
  describe('synced star-rating fallback (board_climb_ratings) → effectiveQuality', () => {
    type QualityRow = { uuid: string; quality: number | null; effectiveQuality: number | null };
    const feedItems = (result: FeedResult) => result.items as unknown as QualityRow[];

    it('userAscentsFeed: null tick quality falls back to the synced rating', async () => {
      const climbUuid = CLIMB_PREFIX + 'rating-fallback';
      await insertClimb(climbUuid, 'Rating Fallback');
      await insertTick({ uuid: 'tick-rating-null', climbUuid, climbedAt: '2026-05-01 10:00:00', status: 'send' });
      await insertClimbRating({ climbUuid, rating: 4 });

      const row = feedItems(await callUserAscentsFeed(TEST_USER_ID, { limit: 50 })).find(
        (item) => item.uuid === 'tick-rating-null',
      );
      // Raw quality preserved as null; effective falls back to the 1-5 rating.
      expect(row?.quality).toBeNull();
      expect(row?.effectiveQuality).toBe(4);
    });

    it('userAscentsFeed: a tick with its own quality is unchanged by the rating', async () => {
      const climbUuid = CLIMB_PREFIX + 'rating-override';
      await insertClimb(climbUuid, 'Rating Override');
      // Tick has its own quality 5; a stale synced rating of 2 must NOT win.
      await db.execute(sql`
        INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, attempt_count, quality, climbed_at)
        VALUES ('tick-rating-own', ${TEST_USER_ID}, 'kilter', ${climbUuid}, 40, 'send', 1, 5, '2026-05-02 10:00:00')
      `);
      await insertClimbRating({ climbUuid, rating: 2 });

      const row = feedItems(await callUserAscentsFeed(TEST_USER_ID, { limit: 50 })).find(
        (item) => item.uuid === 'tick-rating-own',
      );
      expect(row?.quality).toBe(5);
      expect(row?.effectiveQuality).toBe(5);
    });

    it('userAscentsFeed: no rating row leaves effectiveQuality null', async () => {
      const climbUuid = CLIMB_PREFIX + 'rating-absent';
      await insertClimb(climbUuid, 'Rating Absent');
      await insertTick({ uuid: 'tick-rating-absent', climbUuid, climbedAt: '2026-05-03 10:00:00', status: 'send' });

      const row = feedItems(await callUserAscentsFeed(TEST_USER_ID, { limit: 50 })).find(
        (item) => item.uuid === 'tick-rating-absent',
      );
      expect(row?.quality).toBeNull();
      expect(row?.effectiveQuality).toBeNull();
    });

    it('userAscentsFeed: a rating at a different angle does not apply', async () => {
      const climbUuid = CLIMB_PREFIX + 'rating-angle';
      await insertClimb(climbUuid, 'Rating Angle');
      // Tick at 40°, rating logged at 30° — the (climb, angle) join must not match.
      await insertTick({
        uuid: 'tick-rating-angle',
        climbUuid,
        climbedAt: '2026-05-04 10:00:00',
        status: 'send',
        angle: 40,
      });
      await insertClimbRating({ climbUuid, rating: 3, angle: 30 });

      const row = feedItems(await callUserAscentsFeed(TEST_USER_ID, { limit: 50 })).find(
        (item) => item.uuid === 'tick-rating-angle',
      );
      expect(row?.effectiveQuality).toBeNull();
    });

    it("userAscentsFeed: another user's rating does not leak into this user's ticks", async () => {
      const climbUuid = CLIMB_PREFIX + 'rating-leak';
      await insertClimb(climbUuid, 'Rating Leak');
      await insertTick({ uuid: 'tick-rating-mine', climbUuid, climbedAt: '2026-05-05 10:00:00', status: 'send' });
      // Only OTHER_USER has a rating for this climb+angle.
      await insertClimbRating({ climbUuid, rating: 5, userId: OTHER_USER_ID });

      const row = feedItems(await callUserAscentsFeed(TEST_USER_ID, { limit: 50 })).find(
        (item) => item.uuid === 'tick-rating-mine',
      );
      expect(row?.effectiveQuality).toBeNull();
    });

    it('ticks (own logbook): null tick quality falls back to the synced rating', async () => {
      const climbUuid = CLIMB_PREFIX + 'rating-ticks';
      await insertClimb(climbUuid, 'Rating Ticks');
      await insertTick({ uuid: 'tick-rating-ticks', climbUuid, climbedAt: '2026-05-06 10:00:00', status: 'send' });
      await insertClimbRating({ climbUuid, rating: 2 });

      const rows = await callTicks({ boardType: 'kilter' });
      const row = rows.find((item) => item.uuid === 'tick-rating-ticks');
      expect(row?.quality).toBeNull();
      expect(row?.effectiveQuality).toBe(2);
    });

    it("userTicks (public): null tick quality falls back to the tick OWNER's synced rating", async () => {
      const climbUuid = CLIMB_PREFIX + 'rating-userticks';
      await insertClimb(climbUuid, 'Rating UserTicks');
      await insertTick({ uuid: 'tick-rating-public', climbUuid, climbedAt: '2026-05-08 10:00:00', status: 'send' });
      // The owner's rating applies; another user's rating at the same key must not.
      await insertClimbRating({ climbUuid, rating: 4 });
      await insertClimbRating({ climbUuid, rating: 1, userId: OTHER_USER_ID });

      const rows = await callUserTicks(TEST_USER_ID, 'kilter');
      const row = rows.find((item) => item.uuid === 'tick-rating-public');
      // Raw quality stays null (edit flows read it); effective is the owner's 4.
      expect(row?.quality).toBeNull();
      expect(row?.effectiveQuality).toBe(4);
    });

    it('userGroupedAscentsFeed: bestQuality reflects the synced rating for a null-quality tick', async () => {
      const climbUuid = CLIMB_PREFIX + 'rating-grouped';
      await insertClimb(climbUuid, 'Rating Grouped');
      await insertTick({ uuid: 'tick-rating-grp', climbUuid, climbedAt: '2026-05-07 10:00:00', status: 'send' });
      await insertClimbRating({ climbUuid, rating: 3 });

      const result = await callUserGroupedAscentsFeed(TEST_USER_ID, { limit: 20, offset: 0 });
      const group = result.groups.find((candidate) => candidate.climbUuid === climbUuid) as
        | (Group & { bestQuality: number | null })
        | undefined;
      expect(group?.bestQuality).toBe(3);
    });
  });
});
