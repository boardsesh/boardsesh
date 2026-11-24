import { describe, it, expect, beforeEach, afterAll, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db, runWithDatabaseTransaction } from '../db/client';
import { gymStatsSnapshotSql, socialGymInsightsQueries } from '../graphql/resolvers/social/gym-insights';
import {
  readGymReportingCoverage,
  readReportingBoundaries,
  reportingActivityInWindowSql,
  reportingActivitySql,
  withGymReportingScope,
} from '../graphql/resolvers/social/gym-reporting';
import { gymReportingSettingsMutations } from '../graphql/resolvers/social/gym-reporting-settings';
import { tickReportingTime } from '../services/reporting-time';
import { reserveAndPersistBoardClimbEvent } from '../graphql/resolvers/board-presence/mutations';
import { socialGymMutations, socialGymQueries } from '../graphql/resolvers/social/gyms';
import { socialGymStrayBoardMutations } from '../graphql/resolvers/social/gym-stray-boards';
import { tickMutations } from '../graphql/resolvers/ticks/mutations';
import { listManagedGyms, resolveGymForTool } from '../mcp/gyms/domain';

/**
 * Real-DB coverage for the owner Insights query (gymStats):
 *   - the read gate (owner / gym admin / gym editor allowed; plain member,
 *     stranger, anon rejected);
 *   - the current-vs-previous-window aggregation (unique climbers, ascents,
 *     top climbs with resolved name + consensus grade, busiest days);
 *   - the scoping guards: only the gym's boards count, only flash/send ticks
 *     count, and ticks outside both windows are excluded;
 *   - the empty-gym path (no boards / no ticks → zeros + empty lists).
 *
 * Seeds via raw SQL and calls the resolver directly against the per-worker test
 * DB, mirroring gym-kiosks.test.ts.
 */

const OWNER = 'gi-owner';
const ADMIN = 'gi-admin';
const EDITOR = 'gi-editor';
const MEMBER = 'gi-member';
const RANDOM = 'gi-random';
const ALL_USERS = [OWNER, ADMIN, EDITOR, MEMBER, RANDOM];

const CLIMB_PREFIX = 'gym-insights-test-climb-';
const BOARD_TYPE = 'kilter';

// A synthetic grade id well outside the real (kilter, 1..~40) catalog range, so
// seeding/clearing our consensus-grade row can never touch a difficulty another
// test in the same worker DB reads. display 99.2 → ROUND → 99 joins this row.
const SYNTHETIC_GRADE_ID = 99;
const SYNTHETIC_DISPLAY_DIFFICULTY = 99.2;

let connectionCounter = 0;
const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}-${connectionCounter++}`, isAuthenticated: true, userId }) as ConnectionContext;
const anonCtx = (): ConnectionContext =>
  ({ connectionId: `conn-anon-${connectionCounter++}`, isAuthenticated: false }) as ConnectionContext;

const daysAgoIso = (days: number): string => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

const insertGym = async (opts: {
  ownerId: string;
  name: string;
  slug: string;
  isPublic?: boolean;
}): Promise<{ id: number; uuid: string; slug: string }> => {
  const { ownerId, name, slug, isPublic = true } = opts;
  const uuid = uuidv4();
  const result = await db.execute(sql`
    INSERT INTO gyms (uuid, name, slug, owner_id, is_public, created_at, updated_at)
    VALUES (${uuid}, ${name}, ${slug}, ${ownerId}, ${isPublic}, now(), now())
    RETURNING id
  `);
  return { id: Number(Array.from(result as Iterable<{ id: number }>)[0].id), uuid, slug };
};

let boardConfigCounter = 0;
const insertBoard = async (opts: {
  gymId: number;
  ownerId: string;
  name: string;
}): Promise<{ id: number; uuid: string }> => {
  const { gymId, ownerId, name } = opts;
  const uuid = uuidv4();
  const sizeId = 100 + boardConfigCounter++;
  const result = await db.execute(sql`
    INSERT INTO user_boards
      (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, gym_id, is_public, created_at, updated_at)
    VALUES (${uuid}, ${uuid}, ${ownerId}, ${BOARD_TYPE}, 1, ${sizeId}, '1,2', ${name}, ${gymId}, true, now(), now())
    RETURNING id
  `);
  return { id: Number(Array.from(result as Iterable<{ id: number }>)[0].id), uuid };
};

const insertGymMember = (gymId: number, userId: string, role: string) =>
  db.execute(sql`
    INSERT INTO gym_members (gym_id, user_id, role, created_at)
    VALUES (${gymId}, ${userId}, ${role}, now())
  `);

const insertClimb = (uuid: string, name: string) =>
  db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, name, is_listed, is_draft)
    VALUES (${uuid}, ${BOARD_TYPE}, 1, ${name}, true, false)
    ON CONFLICT (uuid) DO NOTHING
  `);

const insertClimbStats = (climbUuid: string, angle: number, displayDifficulty: number) =>
  db.execute(sql`
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty)
    VALUES (${BOARD_TYPE}, ${climbUuid}, ${angle}, ${displayDifficulty})
  `);

const insertGrade = (difficulty: number, boulderName: string) =>
  db.execute(sql`
    INSERT INTO board_difficulty_grades (board_type, difficulty, boulder_name, is_listed)
    VALUES (${BOARD_TYPE}, ${difficulty}, ${boulderName}, true)
    ON CONFLICT (board_type, difficulty) DO UPDATE SET boulder_name = excluded.boulder_name
  `);

const insertTick = (options: {
  uuid?: string;
  userId: string;
  boardId: number;
  climbUuid: string;
  climbedAt: string;
  status?: 'flash' | 'send' | 'attempt';
  attemptCount?: number;
  angle?: number;
  origin?: 'native' | 'aurora_pull';
  attributed?: boolean;
  precision?: 'instant' | 'day' | null;
  reportingDate?: string;
  reportingTimeZone?: string;
}) =>
  db.execute(sql`
  INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, attempt_count,
    climbed_at, board_id, origin, reporting_board_id, reporting_gym_id, reporting_attribution,
    reporting_time_precision, reporting_date, reporting_date_time_zone, reporting_climbed_at)
  SELECT ${options.uuid ?? uuidv4()}, ${options.userId}, board.board_type, ${options.climbUuid}, ${options.angle ?? 40},
    ${options.status ?? 'send'}::tick_status, ${options.attemptCount ?? 1}, ${options.climbedAt}::timestamptz AT TIME ZONE 'UTC', board.id,
    ${options.origin ?? 'native'}::tick_origin, CASE WHEN ${options.attributed !== false} THEN board.id END,
    CASE WHEN ${options.attributed !== false} THEN board.gym_id END,
    CASE WHEN ${options.attributed !== false} THEN 'uuid' END,
    ${options.precision === undefined ? 'instant' : options.precision}, ${options.reportingDate ?? null}::date,
    ${options.reportingTimeZone ?? null},
    CASE WHEN ${options.precision !== null} THEN ${options.climbedAt}::timestamptz AT TIME ZONE 'UTC' END
  FROM user_boards board WHERE board.id = ${options.boardId}
  ON CONFLICT (uuid) DO NOTHING
`);

const insertDisplay = (options: {
  boardId: number;
  userId: string | null;
  source?: 'boardsesh' | 'kilter';
  captured?: boolean;
  angle?: number;
  confirmedAt?: string;
}) =>
  db.execute(sql`
  INSERT INTO board_climb_events (board_id, board_type, climb_uuid, angle, source, user_id, seq, confirmed_at,
    identity_policy_version, reporting_board_id, reporting_gym_id)
  SELECT board.id, board.board_type, ${CLIMB_X}, ${options.angle ?? 40}, ${options.source ?? 'boardsesh'}, ${options.userId},
    COALESCE((SELECT MAX(seq) FROM board_climb_events WHERE board_id = board.id), 0) + 1,
    ${options.confirmedAt ?? daysAgoIso(1)}::timestamptz AT TIME ZONE 'UTC', 1,
    CASE WHEN ${options.captured !== false} THEN board.id END,
    CASE WHEN ${options.captured !== false} THEN board.gym_id END
  FROM user_boards board WHERE board.id = ${options.boardId}
`);

const readStats = (userId = OWNER, boardUuid?: string) =>
  socialGymInsightsQueries.gymStats({}, { input: { gymUuid: publicGym.uuid, boardUuid } }, authCtx(userId));

const CLIMB_X = `${CLIMB_PREFIX}x`;
const CLIMB_Y = `${CLIMB_PREFIX}y`;

let publicGym: { id: number; uuid: string; slug: string };
let boardA: { id: number; uuid: string };
let boardB: { id: number; uuid: string };
let otherGymBoard: { id: number; uuid: string };

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE
      "gym_kiosks", "gym_members", "gym_follows", "gym_claims",
      "board_follows", "boardsesh_ticks", "user_boards", "gyms"
    RESTART IDENTITY CASCADE
  `);
  await db.execute(sql`DELETE FROM board_climb_stats WHERE climb_uuid LIKE ${CLIMB_PREFIX + '%'}`);
  await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE ${CLIMB_PREFIX + '%'}`);
  await db.execute(
    sql`DELETE FROM board_difficulty_grades WHERE board_type = ${BOARD_TYPE} AND difficulty = ${SYNTHETIC_GRADE_ID}`,
  );

  await Promise.all(ALL_USERS.map(insertUser));

  publicGym = await insertGym({ ownerId: OWNER, name: 'Insights Gym', slug: 'insights-gym' });
  await insertGymMember(publicGym.id, ADMIN, 'admin');
  await insertGymMember(publicGym.id, EDITOR, 'editor');
  await insertGymMember(publicGym.id, MEMBER, 'member');
  boardA = await insertBoard({ gymId: publicGym.id, ownerId: OWNER, name: 'A Wall' });
  boardB = await insertBoard({ gymId: publicGym.id, ownerId: OWNER, name: 'B Wall' });

  const otherGym = await insertGym({ ownerId: RANDOM, name: 'Other Gym', slug: 'other-gym' });
  otherGymBoard = await insertBoard({ gymId: otherGym.id, ownerId: RANDOM, name: 'Elsewhere Wall' });

  // Catalog: two climbs; CLIMB_X carries a consensus grade (display 99.2 → 99 → "V4").
  await insertClimb(CLIMB_X, 'Crimpy Traverse');
  await insertClimb(CLIMB_Y, 'Sloper Heaven');
  await insertClimbStats(CLIMB_X, 40, SYNTHETIC_DISPLAY_DIFFICULTY);
  await insertGrade(SYNTHETIC_GRADE_ID, 'V4');

  // Current window (last 7 days): 3 ascents, 3 distinct climbers, CLIMB_X twice.
  await insertTick({ userId: OWNER, boardId: boardA.id, climbUuid: CLIMB_X, climbedAt: daysAgoIso(1) });
  await insertTick({
    userId: ADMIN,
    boardId: boardA.id,
    climbUuid: CLIMB_X,
    climbedAt: daysAgoIso(2),
    status: 'flash',
  });
  await insertTick({ userId: EDITOR, boardId: boardB.id, climbUuid: CLIMB_Y, climbedAt: daysAgoIso(3) });

  // Previous window (7–14 days ago): 2 ascents, 2 distinct climbers.
  await insertTick({ userId: OWNER, boardId: boardA.id, climbUuid: CLIMB_X, climbedAt: daysAgoIso(9) });
  await insertTick({ userId: MEMBER, boardId: boardA.id, climbUuid: CLIMB_Y, climbedAt: daysAgoIso(11) });

  // Excluded: too old, an attempt, and a tick on another gym's board.
  await insertTick({ userId: OWNER, boardId: boardA.id, climbUuid: CLIMB_X, climbedAt: daysAgoIso(20) });
  await insertTick({
    userId: OWNER,
    boardId: boardA.id,
    climbUuid: CLIMB_X,
    climbedAt: daysAgoIso(1),
    status: 'attempt',
  });
  await insertTick({ userId: RANDOM, boardId: otherGymBoard.id, climbUuid: CLIMB_X, climbedAt: daysAgoIso(1) });
});

// Leave the shared worker DB as we found it: drop the synthetic grade row the
// last test left behind (beforeEach clears it between tests, not after the last).
afterAll(async () => {
  await db.execute(
    sql`DELETE FROM board_difficulty_grades WHERE board_type = ${BOARD_TYPE} AND difficulty = ${SYNTHETIC_GRADE_ID}`,
  );
});

describe('gymStats access guard', () => {
  it('serializes independent MCP writers at gym authorization before a lock upgrade can deadlock', async () => {
    let releaseOwner = () => {};
    let markOwnerLocked = () => {};
    let markAdminStarted = (pid: number) => {
      void pid;
    };
    const ownerReleased = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const ownerLocked = new Promise<void>((resolve) => {
      markOwnerLocked = resolve;
    });
    const adminStarted = new Promise<number>((resolve) => {
      markAdminStarted = resolve;
    });
    let adminAuthorized = false;
    const ownerTransaction = runWithDatabaseTransaction(async () => {
      await resolveGymForTool(publicGym.uuid, OWNER, true, true);
      markOwnerLocked();
      await ownerReleased;
    });
    await ownerLocked;
    const adminTransaction = runWithDatabaseTransaction(async () => {
      const pidRows = await db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      markAdminStarted(Array.from(pidRows)[0]!.pid);
      await resolveGymForTool(publicGym.uuid, ADMIN, true, true);
      adminAuthorized = true;
    });
    try {
      const adminPid = await adminStarted;
      let waitsForLock = false;
      for (let attempt = 0; attempt < 50 && !adminAuthorized && !waitsForLock; attempt += 1) {
        const activity = await db.execute<{ waitType: string | null }>(sql`
          SELECT wait_event_type AS "waitType" FROM pg_stat_activity WHERE pid = ${adminPid}
        `);
        waitsForLock = Array.from(activity)[0]?.waitType === 'Lock';
        if (!waitsForLock && !adminAuthorized) await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(waitsForLock).toBe(true);
      expect(adminAuthorized).toBe(false);
    } finally {
      releaseOwner();
      await Promise.all([ownerTransaction, adminTransaction]);
    }
    expect(adminAuthorized).toBe(true);
  });

  it('MCP management discovery excludes ordinary members before counting and pagination', async () => {
    const owned = await insertGym({ ownerId: MEMBER, name: 'My gym', slug: 'mcp-owned-gym' });
    expect(await listManagedGyms(MEMBER, 1, 0)).toMatchObject({
      gyms: [expect.objectContaining({ uuid: owned.uuid, canEdit: true })],
      totalCount: 1,
      hasMore: false,
    });
    expect(await listManagedGyms(MEMBER, 1, 1)).toMatchObject({ gyms: [], totalCount: 1, hasMore: false });
    for (const userId of [OWNER, ADMIN, EDITOR]) {
      expect(await listManagedGyms(userId, 1, 0)).toMatchObject({
        gyms: [expect.objectContaining({ uuid: publicGym.uuid, canEdit: true })],
        totalCount: 1,
      });
    }
  });

  it('MCP pages every scoped community-managed gym without including an uncovered membership', async () => {
    const leader = 'gi-mcp-community-leader';
    await insertUser(leader);
    await db.execute(sql`INSERT INTO community_roles (user_id, role, board_type)
      VALUES (${leader}, 'community_leader', 'kilter') ON CONFLICT DO NOTHING`);
    const uncovered = await insertGym({ ownerId: OWNER, name: 'Uncovered', slug: 'mcp-uncovered' });
    await insertGymMember(uncovered.id, leader, 'member');
    const first = await listManagedGyms(leader, 1, 0);
    const second = await listManagedGyms(leader, 1, 1);
    expect(first).toMatchObject({ totalCount: 2, hasMore: true });
    expect(second).toMatchObject({ totalCount: 2, hasMore: false });
    const combined = [...(first.gyms as Array<{ uuid: string }>), ...(second.gyms as Array<{ uuid: string }>)];
    expect(new Set(combined.map((gym) => gym.uuid)).size).toBe(2);
    expect(combined).toContainEqual(expect.objectContaining({ uuid: publicGym.uuid }));
    expect(combined).not.toContainEqual(expect.objectContaining({ uuid: uncovered.uuid }));
  });

  it('lets the owner, a gym admin, and a gym editor read stats', async () => {
    for (const user of [OWNER, ADMIN, EDITOR]) {
      const stats = await socialGymInsightsQueries.gymStats({}, { input: { gymUuid: publicGym.uuid } }, authCtx(user));
      expect(stats.gymUuid).toBe(publicGym.uuid);
    }
  });

  it('lists the gyms covered by an actual scoped community leader in the opt-in My gyms query', async () => {
    const leader = 'gi-community-leader';
    await insertUser(leader);
    await db.execute(sql`INSERT INTO community_roles (user_id, role, board_type)
      VALUES (${leader}, 'community_leader', 'kilter') ON CONFLICT DO NOTHING`);
    const uncoveredGym = await insertGym({ ownerId: OWNER, name: 'Tension gym', slug: 'uncovered-tension' });
    const uncoveredBoard = await insertBoard({ gymId: uncoveredGym.id, ownerId: OWNER, name: 'Tension wall' });
    await db.execute(sql`UPDATE user_boards SET board_type = 'tension' WHERE id = ${uncoveredBoard.id}`);
    const original = await socialGymQueries.myGyms({}, { input: {} }, authCtx(leader));
    expect(original.gyms).toEqual([]);
    const firstPage = await socialGymQueries.myGyms({}, { input: { includeManaged: true, limit: 1 } }, authCtx(leader));
    const secondPage = await socialGymQueries.myGyms(
      {},
      { input: { includeManaged: true, limit: 1, offset: 1 } },
      authCtx(leader),
    );
    expect(firstPage).toMatchObject({ totalCount: 2, hasMore: true });
    expect(secondPage).toMatchObject({ totalCount: 2, hasMore: false });
    expect([...firstPage.gyms, ...secondPage.gyms]).toContainEqual(
      expect.objectContaining({
        uuid: publicGym.uuid,
        canEdit: true,
      }),
    );
    expect((await readStats(leader)).gymUuid).toBe(publicGym.uuid);
    await expect(
      socialGymInsightsQueries.gymStats({}, { input: { gymUuid: uncoveredGym.uuid } }, authCtx(leader)),
    ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });

  it('denies fresh reports and settings after governance removes an editor', async () => {
    expect((await readStats(EDITOR)).gymUuid).toBe(publicGym.uuid);
    await socialGymMutations.revokeGymWriteAccess(
      {},
      { input: { gymUuid: publicGym.uuid, userId: EDITOR } },
      authCtx(OWNER),
    );
    await expect(readStats(EDITOR)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    await expect(
      gymReportingSettingsMutations.setGymReportingTimeZone(
        {},
        { input: { gymUuid: publicGym.uuid, timeZone: 'America/Denver' } },
        authCtx(EDITOR),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect((await readStats(ADMIN)).gymUuid).toBe(publicGym.uuid);
  });

  it('rejects a plain member', async () => {
    await expect(
      socialGymInsightsQueries.gymStats({}, { input: { gymUuid: publicGym.uuid } }, authCtx(MEMBER)),
    ).rejects.toThrow(/not authorized/i);
  });

  it('rejects a stranger', async () => {
    await expect(
      socialGymInsightsQueries.gymStats({}, { input: { gymUuid: publicGym.uuid } }, authCtx(RANDOM)),
    ).rejects.toThrow(/not authorized/i);
  });

  it('rejects an anonymous caller', async () => {
    await expect(
      socialGymInsightsQueries.gymStats({}, { input: { gymUuid: publicGym.uuid } }, anonCtx()),
    ).rejects.toThrow(/authentication required/i);
  });
});

describe('gymStats aggregation', () => {
  it('reports current and previous window counts, scoped to the gym and flash/send', async () => {
    const stats = await socialGymInsightsQueries.gymStats({}, { input: { gymUuid: publicGym.uuid } }, authCtx(OWNER));

    expect(stats.periodDays).toBe(7);
    // Current: 3 flash/send ascents by OWNER, ADMIN, EDITOR. The attempt and the
    // other-gym board tick are excluded.
    expect(stats.current.ascentCount).toBe(3);
    expect(stats.current.uniqueClimbers).toBe(3);
    // Previous: 2 ascents by OWNER + MEMBER (the 20-days-ago tick is out of range).
    expect(stats.previous.ascentCount).toBe(2);
    expect(stats.previous.uniqueClimbers).toBe(2);
  });

  it('ranks top climbs by ascents with resolved name and consensus grade', async () => {
    const stats = await socialGymInsightsQueries.gymStats({}, { input: { gymUuid: publicGym.uuid } }, authCtx(OWNER));

    expect(stats.topClimbs.length).toBe(2);
    const [top, second] = stats.topClimbs;
    expect(top.climbUuid).toBe(CLIMB_X);
    expect(top.ascentCount).toBe(2);
    expect(top.name).toBe('Crimpy Traverse');
    expect(top.gradeName).toBe('V4');
    expect(top.angle).toBe(40);

    expect(second.climbUuid).toBe(CLIMB_Y);
    expect(second.ascentCount).toBe(1);
    // CLIMB_Y has no stats row → grade falls back to null (safe degradation).
    expect(second.gradeName).toBeNull();
  });

  it('buckets busiest days so they sum to the current ascent count', async () => {
    const stats = await socialGymInsightsQueries.gymStats({}, { input: { gymUuid: publicGym.uuid } }, authCtx(OWNER));

    const total = stats.busiestDays.reduce((sum, day) => sum + day.ascentCount, 0);
    expect(total).toBe(stats.current.ascentCount);
    for (const day of stats.busiestDays) {
      expect(day.dayOfWeek).toBeGreaterThanOrEqual(0);
      expect(day.dayOfWeek).toBeLessThanOrEqual(6);
    }
  });

  it('honours the month period (30-day window)', async () => {
    const stats = await socialGymInsightsQueries.gymStats(
      {},
      { input: { gymUuid: publicGym.uuid, period: 'month' } },
      authCtx(OWNER),
    );
    expect(stats.periodDays).toBe(30);
    // The 30-day current window now also captures the two prior-week ticks and
    // the 20-days-ago tick: 3 + 2 + 1 = 6 flash/send ascents on gym boards.
    expect(stats.current.ascentCount).toBe(6);
  });
});

describe('gymStats empty gym', () => {
  it('returns zeros and empty lists for a gym with no boards', async () => {
    const emptyGym = await insertGym({ ownerId: OWNER, name: 'Empty Gym', slug: 'empty-gym' });
    const stats = await socialGymInsightsQueries.gymStats({}, { input: { gymUuid: emptyGym.uuid } }, authCtx(OWNER));
    expect(stats.current).toMatchObject({ uniqueClimbers: 0, ascentCount: 0, tickCount: 0, displayCount: 0 });
    expect(stats.previous).toMatchObject({ uniqueClimbers: 0, ascentCount: 0, tickCount: 0, displayCount: 0 });
    expect(stats.topClimbs).toEqual([]);
    expect(stats.busiestDays).toEqual([]);
  });
});

describe('qualified reporting scope and sources', () => {
  it('deduplicates people across sources and boards, includes attempts, and counts native repeated sends separately', async () => {
    const instant = daysAgoIso(1);
    await insertTick({ userId: OWNER, boardId: boardA.id, climbUuid: CLIMB_X, climbedAt: instant });
    await insertTick({ userId: OWNER, boardId: boardA.id, climbUuid: CLIMB_X, climbedAt: instant });
    await insertTick({
      userId: OWNER,
      boardId: boardA.id,
      climbUuid: CLIMB_X,
      climbedAt: instant,
      origin: 'aurora_pull',
    });
    await insertTick({ userId: RANDOM, boardId: boardB.id, climbUuid: CLIMB_X, climbedAt: instant, attributed: false });
    await insertTick({ userId: MEMBER, boardId: boardB.id, climbUuid: CLIMB_X, climbedAt: instant, status: 'attempt' });
    await insertTick({ userId: RANDOM, boardId: boardA.id, climbUuid: CLIMB_X, climbedAt: daysAgoIso(-1) });
    await insertDisplay({ boardId: boardA.id, userId: OWNER });
    await insertDisplay({ boardId: boardB.id, userId: OWNER });
    await insertDisplay({ boardId: boardB.id, userId: null });
    await insertDisplay({ boardId: boardB.id, userId: RANDOM, source: 'kilter' });
    await insertDisplay({ boardId: boardB.id, userId: RANDOM });
    await db.execute(sql`INSERT INTO user_profiles (user_id, anonymous_on_foreign_boards)
      VALUES (${RANDOM}, true) ON CONFLICT (user_id) DO UPDATE SET anonymous_on_foreign_boards = true`);
    const stats = await readStats();
    expect(stats.current).toMatchObject({ uniqueClimbers: 4, ascentCount: 5, tickCount: 7, displayCount: 4 });
  });

  it('requires independent board access for a selected configuration and for group-level counts', async () => {
    await gymReportingSettingsMutations.setGymReportingBoardAlias(
      {},
      {
        input: {
          gymUuid: publicGym.uuid,
          boardUuid: boardB.uuid,
          rootBoardUuid: boardA.uuid,
        },
      },
      authCtx(OWNER),
    );
    const ownerStats = await readStats(OWNER, boardA.uuid);
    expect(ownerStats.boards).toHaveLength(1);
    expect(ownerStats.current.ascentCount).toBe(3);
    await db.execute(sql`UPDATE user_boards SET is_public = false WHERE id = ${boardB.id}`);
    const editorStats = await readStats(EDITOR, boardA.uuid);
    expect(editorStats.boards[0].configurations).toEqual([{ uuid: boardA.uuid, name: 'A Wall' }]);
    expect(editorStats.current.ascentCount).toBe(2);
    expect(editorStats.angleUsage).toMatchObject([{ boardUuid: boardA.uuid, knownAngleClimberCount: 2 }]);
    await expect(readStats(EDITOR, boardB.uuid)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    await expect(readStats(OWNER, otherGymBoard.uuid)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    await expect(
      gymReportingSettingsMutations.setGymReportingBoardAlias(
        {},
        {
          input: {
            gymUuid: publicGym.uuid,
            boardUuid: boardA.uuid,
            rootBoardUuid: boardB.uuid,
          },
        },
        authCtx(OWNER),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    await gymReportingSettingsMutations.setGymReportingBoardAlias(
      {},
      {
        input: {
          gymUuid: publicGym.uuid,
          boardUuid: boardB.uuid,
          rootBoardUuid: null,
        },
      },
      authCtx(OWNER),
    );
    const ungrouped = await readStats(OWNER, boardA.uuid);
    expect(ungrouped.boards).toHaveLength(2);
    expect(ungrouped.current.ascentCount).toBe(2);
  });

  function verifyAlias() {
    return gymReportingSettingsMutations.setGymReportingBoardAlias(
      {},
      { input: { gymUuid: publicGym.uuid, boardUuid: boardB.uuid, rootBoardUuid: boardA.uuid } },
      authCtx(OWNER),
    );
  }

  function changeBoardGym(boardUuid: string, gymUuid: string | null) {
    return socialGymMutations.linkBoardToGym({}, { input: { boardUuid, gymUuid } }, authCtx(OWNER));
  }

  it('requires fresh verification when either endpoint leaves and returns through the real link mutation', async () => {
    await verifyAlias();
    expect((await readStats()).boards).toHaveLength(1);
    await changeBoardGym(boardB.uuid, null);
    await changeBoardGym(boardB.uuid, publicGym.uuid);
    expect((await readStats()).boards).toHaveLength(2);
    await verifyAlias();
    expect((await readStats()).boards).toHaveLength(1);

    const destination = await insertGym({ ownerId: OWNER, name: 'Move destination', slug: 'alias-move-destination' });
    await changeBoardGym(boardA.uuid, destination.uuid);
    await changeBoardGym(boardA.uuid, publicGym.uuid);
    expect((await readStats()).boards).toHaveLength(2);
    await verifyAlias();
    expect((await readStats()).boards).toHaveLength(1);
    const [audit] = await db.execute<{ active: number; automatic: number }>(sql`
      SELECT count(*) FILTER (WHERE revoked_at IS NULL)::int AS active,
        count(*) FILTER (WHERE revoked_at IS NOT NULL AND revoked_by IS NULL)::int AS automatic
      FROM gym_reporting_board_aliases WHERE board_id = ${boardB.id}
    `);
    expect(audit).toMatchObject({ active: 1, automatic: 2 });
  });

  it('retires verification when gym staff remove a climber’s board without reassigning its logged activity', async () => {
    await verifyAlias();
    expect((await readStats()).boards).toHaveLength(1);

    expect(
      await socialGymStrayBoardMutations.detachBoardFromGym(
        {},
        { input: { gymUuid: publicGym.uuid, boardUuid: boardB.uuid } },
        authCtx(ADMIN),
      ),
    ).toBe(true);
    const [board] = await db.execute<{
      gym_id: number | null;
      owner_id: string;
      frozen: boolean;
      deleted: boolean;
    }>(sql`
      SELECT gym_id, owner_id, sync_frozen_at IS NOT NULL AS frozen, deleted_at IS NOT NULL AS deleted
      FROM user_boards WHERE id = ${boardB.id}
    `);
    expect(board).toEqual({ gym_id: null, owner_id: OWNER, frozen: true, deleted: false });
    const [event] = await db.execute<{ action: string; actor_user_id: string }>(sql`
      SELECT action, actor_user_id FROM board_moderation_events WHERE board_id = ${boardB.id}
    `);
    expect(event).toEqual({ action: 'removed_from_gym', actor_user_id: ADMIN });
    const [alias] = await db.execute<{ revoked: boolean }>(sql`
      SELECT revoked_at IS NOT NULL AS revoked FROM gym_reporting_board_aliases WHERE board_id = ${boardB.id}
    `);
    expect(alias?.revoked).toBe(true);
    const [history] = await db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM boardsesh_ticks
      WHERE board_id = ${boardB.id} AND reporting_board_id = ${boardB.id} AND reporting_gym_id = ${publicGym.id}
    `);
    expect(history?.count).toBe(1);
    await expect(readStats(ADMIN, boardB.uuid)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    const report = await readStats();
    expect(report.boards).toHaveLength(1);
    expect(report.boards[0]?.configurations.map((board) => board.uuid)).toEqual([boardA.uuid]);
  });

  it('invalidates an alias when a board leaves and returns inside the same transaction', async () => {
    await verifyAlias();
    await db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE user_boards SET gym_id = NULL WHERE id = ${boardB.id}`);
      await tx.execute(sql`UPDATE user_boards SET gym_id = ${publicGym.id} WHERE id = ${boardB.id}`);
    });
    expect((await readStats()).boards).toHaveLength(2);
  });

  it('retains verification for a canonical gym merge finalized in the board move transaction', async () => {
    await verifyAlias();
    const survivor = await insertGym({ ownerId: OWNER, name: 'Canonical venue', slug: 'alias-canonical-gym' });
    await db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE user_boards SET gym_id = ${survivor.id} WHERE gym_id = ${publicGym.id}`);
      await tx.execute(
        sql`UPDATE gyms SET deleted_at = now(), merged_into_gym_id = ${survivor.id} WHERE id = ${publicGym.id}`,
      );
    });
    expect((await readStats()).boards).toEqual([
      expect.objectContaining({
        uuid: boardA.uuid,
        configurations: [
          { uuid: boardA.uuid, name: 'A Wall' },
          { uuid: boardB.uuid, name: 'B Wall' },
        ],
      }),
    ]);
  });

  it('makes verification recheck the endpoints after waiting for a concurrent move', async () => {
    let confirmLocked = () => {};
    let releaseMove = () => {};
    const boardLocked = new Promise<void>((resolve) => {
      confirmLocked = resolve;
    });
    const mayCommit = new Promise<void>((resolve) => {
      releaseMove = resolve;
    });
    const move = db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE user_boards SET gym_id = NULL WHERE id = ${boardB.id}`);
      confirmLocked();
      await mayCommit;
    });
    await boardLocked;
    const verification = verifyAlias().then(
      () => null,
      (error: unknown) => error,
    );
    try {
      // The update is uncommitted while verification still sees the old
      // association. Observe the real conflicting board lock before releasing.
      const deadline = Date.now() + 3000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const [locks] = await db.execute<{ waiting: boolean }>(sql`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%from "user_boards"%' AND query LIKE '%for no key update%') AS waiting
        `);
        waiting = locks.waiting;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
    } finally {
      releaseMove();
      await move;
      await verification;
    }
    expect(await verification).toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    await changeBoardGym(boardB.uuid, publicGym.uuid);
    expect((await readStats()).boards).toHaveLength(2);
  });

  it('keeps retired climbs in totals and loses an unauthorized merged source', async () => {
    await insertDisplay({ boardId: boardA.id, userId: ADMIN, captured: false });
    await insertDisplay({ boardId: boardA.id, userId: ADMIN });
    await insertDisplay({ boardId: boardB.id, userId: MEMBER });
    await db.execute(sql`UPDATE board_climbs SET is_listed = false WHERE uuid = ${CLIMB_Y}`);
    const retired = await readStats();
    expect(retired.current.ascentCount).toBe(3);
    expect(retired.topClimbs.map(({ climbUuid }) => climbUuid)).toEqual([CLIMB_X]);
    await db.execute(
      sql`UPDATE board_climb_events SET board_id = ${boardA.id}, seq = 99 WHERE board_id = ${boardB.id}`,
    );
    await db.execute(
      sql`UPDATE user_boards SET deleted_at = now(), merged_into_board_uuid = ${boardA.uuid} WHERE id = ${boardB.id}`,
    );
    const merged = await readStats();
    expect(merged.current.displayCount).toBe(1);
    expect(merged.current.ascentCount).toBe(2);
  });

  it('excludes a private or revoked spray wall before counting but includes authorized archived history', async () => {
    const homeWall = await insertBoard({ gymId: publicGym.id, ownerId: MEMBER, name: 'Private spray wall' });
    await db.execute(
      sql`UPDATE user_boards SET board_type = 'spray', is_public = false, layout_id = 951 WHERE id = ${homeWall.id}`,
    );
    await db.execute(
      sql`INSERT INTO spray_walls (board_uuid, layout_id, archived_at) VALUES (${homeWall.uuid}, 951, now())`,
    );
    await insertDisplay({ boardId: homeWall.id, userId: MEMBER });
    expect((await readStats(EDITOR)).current.displayCount).toBe(0);
    await db.execute(sql`UPDATE user_boards SET is_public = true WHERE id = ${homeWall.id}`);
    const withReadableSpray = await readStats(EDITOR);
    expect(withReadableSpray.current.displayCount).toBe(1);
    expect(withReadableSpray.angleUsage.map(({ boardUuid }) => boardUuid)).not.toContain(homeWall.uuid);
    expect((await readStats(EDITOR, homeWall.uuid)).angleUsage).toEqual([]);
    await db.execute(sql`INSERT INTO resource_grants (kind, resource_id, user_id, status)
      VALUES ('board', ${homeWall.uuid}, ${EDITOR}, 'revoked')`);
    expect((await readStats(EDITOR)).current.displayCount).toBe(0);
    await expect(readStats(EDITOR, homeWall.uuid)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });

  it('captures gym and server time atomically on the durable display writer, including a known unlinked board', async () => {
    const template = {
      boardType: BOARD_TYPE,
      climbUuid: CLIMB_X,
      angle: 40,
      userId: OWNER,
      sessionId: null,
      frames: null,
      name: null,
      grade: null,
      setter: null,
      reportingMirrored: true,
    };
    const confirmed = await reserveAndPersistBoardClimbEvent({ ...template, boardId: boardA.id }, 1);
    expect(confirmed.confirmedAt).toMatch(/Z$/);
    await db.execute(sql`UPDATE user_boards SET gym_id = NULL WHERE id = ${boardB.id}`);
    await reserveAndPersistBoardClimbEvent({ ...template, boardId: boardB.id }, 1);
    await db.execute(sql`UPDATE user_boards SET gym_id = ${publicGym.id} WHERE id = ${boardB.id}`);
    expect((await readStats()).current.displayCount).toBe(1);
  });

  it('does not transfer known historical gym activity when a board is reassigned', async () => {
    await insertDisplay({ boardId: boardA.id, userId: OWNER });
    const destination = await insertGym({ ownerId: OWNER, name: 'New gym', slug: 'new-gym' });
    await db.execute(sql`UPDATE user_boards SET gym_id = ${destination.id} WHERE id = ${boardA.id}`);
    const moved = await socialGymInsightsQueries.gymStats(
      {},
      {
        input: {
          gymUuid: destination.uuid,
          boardUuid: boardA.uuid,
          period: 'quarter',
        },
      },
      authCtx(OWNER),
    );
    expect(moved.periodDays).toBe(90);
    expect(moved.current).toMatchObject({ displayCount: 0, tickCount: 0 });
    expect(moved.angleUsage).toMatchObject([{ boardUuid: boardA.uuid, angles: [], knownAngleClimberCount: 0 }]);
    const original = await readStats();
    expect(original.current).toMatchObject({ displayCount: 0, tickCount: 1 });
    expect(original.angleUsage.map(({ boardUuid }) => boardUuid)).toEqual([boardB.uuid]);
  });

  it('follows a canonical gym merge without creating a new physical venue', async () => {
    await insertDisplay({ boardId: boardA.id, userId: OWNER });
    const survivor = await insertGym({ ownerId: OWNER, name: 'Merged gym', slug: 'merged-gym' });
    await db.execute(sql`UPDATE user_boards SET gym_id = ${survivor.id} WHERE id = ${boardA.id}`);
    await db.execute(
      sql`UPDATE gyms SET deleted_at = now(), merged_into_gym_id = ${survivor.id} WHERE id = ${publicGym.id}`,
    );
    const merged = await readStats(OWNER, boardA.uuid);
    expect(merged.gymUuid).toBe(survivor.uuid);
    expect(merged.current).toMatchObject({ displayCount: 1, tickCount: 3 });
  });
});

describe('LED angle usage', () => {
  it('uses a distinct person denominator per physical board and preserves sends, efforts and displays', async () => {
    const currentDate = daysAgoIso(1);
    const replay = {
      uuid: uuidv4(),
      userId: OWNER,
      boardId: boardA.id,
      climbUuid: CLIMB_X,
      climbedAt: currentDate,
      attemptCount: 7,
    };
    await insertTick(replay);
    await insertTick(replay);
    await insertTick({ ...replay, uuid: undefined, angle: 45 });
    await insertTick({ ...replay, uuid: undefined, userId: MEMBER, angle: 45, status: 'attempt' });
    await insertTick({ ...replay, uuid: undefined, userId: RANDOM, angle: 45, origin: 'aurora_pull' });
    await insertDisplay({ boardId: boardA.id, userId: OWNER, confirmedAt: currentDate });
    await insertDisplay({ boardId: boardB.id, userId: OWNER, angle: 55, confirmedAt: currentDate });
    await insertDisplay({ boardId: boardB.id, userId: null, angle: 55, confirmedAt: currentDate });
    await insertDisplay({ boardId: boardB.id, userId: MEMBER, angle: 55, source: 'kilter', confirmedAt: currentDate });
    const noLeds = await insertBoard({ gymId: publicGym.id, ownerId: OWNER, name: 'Board without LEDs' });
    await db.execute(sql`UPDATE user_boards SET has_leds = false WHERE id = ${noLeds.id}`);
    await insertTick({ ...replay, uuid: undefined, boardId: noLeds.id, angle: 35 });

    const stats = await readStats();
    expect(stats.angleUsage).toEqual([
      {
        boardUuid: boardA.uuid,
        knownAngleClimberCount: 3,
        angles: [
          {
            angle: 40,
            distinctClimberCount: 2,
            climberDayCount: 2,
            tickCount: 4,
            sendCount: 3,
            displayCount: 1,
            unresolvedLocalDateTickCount: 0,
          },
          {
            angle: 45,
            distinctClimberCount: 2,
            climberDayCount: 2,
            tickCount: 2,
            sendCount: 1,
            displayCount: 0,
            unresolvedLocalDateTickCount: 0,
          },
        ],
        unknownAngle: { tickCount: 0, sendCount: 0, displayCount: 0 },
      },
      {
        boardUuid: boardB.uuid,
        knownAngleClimberCount: 2,
        angles: [
          {
            angle: 40,
            distinctClimberCount: 1,
            climberDayCount: 1,
            tickCount: 1,
            sendCount: 1,
            displayCount: 0,
            unresolvedLocalDateTickCount: 0,
          },
          {
            angle: 55,
            distinctClimberCount: 1,
            climberDayCount: 1,
            tickCount: 0,
            sendCount: 0,
            displayCount: 2,
            unresolvedLocalDateTickCount: 0,
          },
        ],
        unknownAngle: { tickCount: 0, sendCount: 0, displayCount: 0 },
      },
    ]);
    expect((await readStats(OWNER, noLeds.uuid)).angleUsage).toEqual([]);

    await gymReportingSettingsMutations.setGymReportingBoardAlias(
      {},
      { input: { gymUuid: publicGym.uuid, boardUuid: boardB.uuid, rootBoardUuid: boardA.uuid } },
      authCtx(OWNER),
    );
    expect((await readStats(OWNER, boardB.uuid)).angleUsage).toMatchObject([
      {
        boardUuid: boardA.uuid,
        knownAngleClimberCount: 4,
        angles: [
          { angle: 40, distinctClimberCount: 3 },
          { angle: 45, distinctClimberCount: 2 },
          { angle: 55, distinctClimberCount: 1 },
        ],
      },
    ]);
    await db.execute(sql`UPDATE user_boards SET has_leds = false WHERE id = ${boardB.id}`);
    expect((await readStats(OWNER, boardB.uuid)).angleUsage).toEqual([stats.angleUsage[0]]);
  });

  it('keeps Woods 41° after a fixed setting edit and excludes unsupported Woods -5° from the denominator', async () => {
    const woods = await insertBoard({ gymId: publicGym.id, ownerId: OWNER, name: 'Fixed Woods' });
    await db.execute(sql`UPDATE user_boards SET board_type = 'woods', size_id = 1, set_ids = '1',
      is_angle_adjustable = false, angle = 41 WHERE id = ${woods.id}`);
    const woodsClimb = `${CLIMB_PREFIX}woods`;
    await db.execute(sql`INSERT INTO board_climbs (uuid, board_type, layout_id, name, is_listed, is_draft)
      VALUES (${woodsClimb}, 'woods', 1, 'Woods angle fixture', true, false)`);
    const tick = { boardId: woods.id, climbUuid: woodsClimb, climbedAt: daysAgoIso(1), status: 'attempt' } as const;
    await insertTick({ ...tick, userId: OWNER, angle: 41 });
    await insertTick({ ...tick, userId: MEMBER, angle: -5 });
    await insertDisplay({ boardId: woods.id, userId: null, angle: 91 });
    const before = await readStats(OWNER, woods.uuid);
    expect(before.angleUsage).toEqual([
      {
        boardUuid: woods.uuid,
        knownAngleClimberCount: 1,
        angles: [
          {
            angle: 41,
            distinctClimberCount: 1,
            climberDayCount: 1,
            tickCount: 1,
            sendCount: 0,
            displayCount: 0,
            unresolvedLocalDateTickCount: 0,
          },
        ],
        unknownAngle: { tickCount: 1, sendCount: 0, displayCount: 1 },
      },
    ]);
    await db.execute(sql`UPDATE user_boards SET angle = 35 WHERE id = ${woods.id}`);
    expect((await readStats(OWNER, woods.uuid)).angleUsage).toEqual(before.angleUsage);
  });

  it('admits the exact DST window and counts author dates only when their gym-local date is proved', async () => {
    const dateBoard = await insertBoard({ gymId: publicGym.id, ownerId: OWNER, name: 'Calendar wall' });
    await db.execute(sql`UPDATE gyms SET reporting_time_zone = 'America/New_York' WHERE id = ${publicGym.id}`);
    const tick = { boardId: dateBoard.id, climbUuid: CLIMB_X, status: 'attempt', angle: 35 } as const;
    const start = '2026-11-01T04:00:00.000Z';
    const end = '2026-11-08T05:00:00.000Z';
    await insertTick({ ...tick, userId: OWNER, climbedAt: start });
    await insertDisplay({ boardId: dateBoard.id, userId: OWNER, angle: 35, confirmedAt: start });
    await insertTick({ ...tick, userId: OWNER, climbedAt: '2026-11-02T05:00:00.000Z' });
    await insertTick({ ...tick, userId: MEMBER, climbedAt: '2026-11-01T03:59:59.999999Z' });
    await insertTick({ ...tick, userId: MEMBER, climbedAt: end });
    const authorDay = {
      ...tick,
      reportingDate: '2026-11-03',
      climbedAt: '2026-11-03T12:00:00.000Z',
      precision: 'day',
    } as const;
    await insertTick({ ...authorDay, userId: OWNER, reportingTimeZone: 'America/New_York' });
    await insertTick({ ...authorDay, userId: EDITOR, reportingTimeZone: 'UTC' });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(end));
    try {
      const stats = await readStats(OWNER, dateBoard.uuid);
      expect(stats.current.startAt).toBe(start);
      expect(stats.angleUsage).toMatchObject([
        {
          boardUuid: dateBoard.uuid,
          knownAngleClimberCount: 2,
          angles: [
            {
              angle: 35,
              distinctClimberCount: 2,
              climberDayCount: 3,
              unresolvedLocalDateTickCount: 1,
              tickCount: 4,
              displayCount: 1,
            },
          ],
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reporting time', () => {
  it('uses equal local calendar offsets across daylight saving and a separate DB zone', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL TIME ZONE 'Pacific/Auckland'`);
      const springAsOf = '2026-03-15T06:30:00.000Z';
      expect(await readReportingBoundaries(tx, 'America/New_York', springAsOf, 7)).toEqual({
        current: { startAt: '2026-03-08T07:30:00.000Z', endAt: springAsOf },
        previous: { startAt: '2026-03-01T07:30:00.000Z', endAt: '2026-03-08T07:30:00.000Z' },
      });
      const autumnAsOf = '2026-11-08T06:30:00.000Z';
      expect(await readReportingBoundaries(tx, 'America/New_York', autumnAsOf, 7)).toEqual({
        current: { startAt: '2026-11-01T06:30:00.000Z', endAt: autumnAsOf },
        previous: { startAt: '2026-10-25T05:30:00.000Z', endAt: '2026-11-01T06:30:00.000Z' },
      });
      expect(
        (await readReportingBoundaries(tx, 'America/New_York', '2026-03-09T04:00:00.000Z', 7)).current.startAt,
      ).toBe('2026-03-02T05:00:00.000Z');
    });
  });

  it('uses full author-date UTC spans for rolling membership and definite gym-local days', async () => {
    const tick = { userId: OWNER, boardId: boardA.id, climbUuid: CLIMB_X, precision: 'day' } as const;
    const fixtures = [
      {
        date: '2024-11-03',
        author: 'America/Havana',
        gym: 'America/Panama',
        savedAt: '2024-11-03T04:30:00.123456Z',
        startAt: '2024-11-03T04:00:00Z',
        endAt: '2024-11-04T05:00:00Z',
        gymDay: null,
      },
      {
        date: '1988-10-30',
        author: 'Atlantic/South_Georgia',
        gym: 'America/Goose_Bay',
        savedAt: '1988-10-30T14:00:00Z',
        startAt: '1988-10-30T02:00:00Z',
        endAt: '1988-10-31T02:00:00Z',
        gymDay: null,
      },
      {
        date: '2024-03-10',
        author: 'America/Havana',
        gym: 'America/Havana',
        savedAt: '2024-03-10T06:30:00Z',
        startAt: '2024-03-10T05:00:00Z',
        endAt: '2024-03-11T04:00:00Z',
        gymDay: '2024-03-10',
      },
      {
        date: '2024-01-15',
        author: 'America/New_York',
        gym: 'America/Toronto',
        savedAt: '2024-01-15T07:30:00Z',
        startAt: '2024-01-15T05:00:00Z',
        endAt: '2024-01-16T05:00:00Z',
        gymDay: '2024-01-15',
      },
    ];

    for (const fixture of fixtures) {
      await insertTick({
        ...tick,
        climbedAt: fixture.savedAt,
        reportingDate: fixture.date,
        reportingTimeZone: fixture.author,
      });
      const complete = { startAt: fixture.startAt, endAt: fixture.endAt };
      const truncated = {
        startAt: new Date(Date.parse(fixture.startAt) + 3600_000).toISOString(),
        endAt: fixture.endAt,
      };
      const rows = await withGymReportingScope({ gymUuid: publicGym.uuid }, authCtx(OWNER), async (tx, scope) => {
        await tx.execute(sql`SET LOCAL TIME ZONE 'Pacific/Auckland'`);
        return tx.execute(sql`
          WITH activity AS (${reportingActivitySql({ ...scope, timeZone: fixture.gym }, { start: complete.startAt, end: complete.endAt })})
          SELECT to_char(possible_start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "startAt",
            to_char(possible_end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "endAt",
            occurred_at, local_date::text AS "gymDay",
            ${reportingActivityInWindowSql(complete)} AS complete,
            ${reportingActivityInWindowSql(truncated)} AS truncated
          FROM activity
        `);
      });

      expect([...rows]).toEqual([
        {
          startAt: fixture.startAt,
          endAt: fixture.endAt,
          occurred_at: null,
          gymDay: fixture.gymDay,
          complete: true,
          truncated: false,
        },
      ]);
    }

    const [stored] = await db.execute(sql`
      SELECT to_char(climbed_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "savedAt",
        reporting_climbed_at = climbed_at AS bound
      FROM boardsesh_ticks WHERE reporting_date = date '2024-11-03'
    `);
    expect(stored).toMatchObject({ savedAt: fixtures[0].savedAt, bound: true });
  });

  it('keeps impossible or unsupported author dates as uncertainty and preserves neighboring exact ticks', async () => {
    const bounds = { startAt: '2011-12-29T00:00:00Z', endAt: '2012-01-02T00:00:00Z' };
    const tick = { userId: OWNER, boardId: boardA.id, climbUuid: CLIMB_X, climbedAt: '2011-12-30T12:00:00Z' };
    await insertTick({ ...tick, precision: 'day', reportingDate: '2011-12-30', reportingTimeZone: 'Pacific/Apia' });
    await insertTick({ ...tick, precision: 'day', reportingDate: '2011-12-30', reportingTimeZone: 'Fake/Zone' });
    await insertTick(tick);
    const [counts] = await withGymReportingScope({ gymUuid: publicGym.uuid }, authCtx(OWNER), (tx, scope) =>
      tx.execute(sql`
        WITH activity AS (${reportingActivitySql(scope, { start: bounds.startAt, end: bounds.endAt })})
        SELECT count(*) FILTER (WHERE precision = 'unknown' AND local_date IS NULL)::int AS unknown,
          count(*) FILTER (WHERE ${reportingActivityInWindowSql(bounds)})::int AS complete
        FROM activity
      `),
    );
    expect(counts).toMatchObject({ unknown: 2, complete: 1 });
  });

  it('bounds author calendar work while retaining unproved dates as uncertainty', async () => {
    const bounds = { startAt: '2024-01-14T00:00:00Z', endAt: '2024-01-17T00:00:00Z' };
    await db.execute(sql`
      WITH zones AS (
        SELECT name, timezone(interval '0', timestamp '2024-01-15 12:00' AT TIME ZONE name) AS saved_at
        FROM pg_timezone_names
        WHERE name ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+)+$'
          AND name NOT LIKE 'posix/%' AND name NOT LIKE 'right/%'
        ORDER BY name LIMIT 270
      )
      INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status,
        climbed_at, board_id, origin, reporting_board_id, reporting_gym_id, reporting_attribution,
        reporting_time_precision, reporting_date, reporting_date_time_zone, reporting_climbed_at)
      SELECT 'analytics-budget-' || row_number() OVER (ORDER BY name), ${OWNER}, ${BOARD_TYPE}, ${CLIMB_X},
        40, 'send', saved_at, ${boardA.id}, 'native', ${boardA.id}, ${publicGym.id}, 'uuid',
        'day', date '2024-01-15', name, saved_at FROM zones
    `);
    await insertTick({ userId: OWNER, boardId: boardA.id, climbUuid: CLIMB_X, climbedAt: '2024-01-15T12:00:00Z' });
    const [counts] = await withGymReportingScope({ gymUuid: publicGym.uuid }, authCtx(OWNER), (tx, scope) =>
      tx.execute(sql`
        WITH activity AS (${reportingActivitySql(scope, { start: bounds.startAt, end: bounds.endAt })})
        SELECT count(*) FILTER (WHERE precision = 'unknown')::int AS unknown,
          count(*) FILTER (WHERE precision = 'day')::int AS dated,
          count(*) FILTER (WHERE precision = 'instant')::int AS exact
        FROM activity
      `),
    );

    // Each disjoint zone needs 97 samples for one date, including its two 36-hour guards.
    expect(counts).toMatchObject({ unknown: 23, dated: 247, exact: 1 });
  });

  it('counts wholly included dates and keeps uncertain boundary, unknown, and future timing out of exact metrics', async () => {
    const log = { userId: MEMBER, boardId: boardA.id, climbUuid: CLIMB_X, reportingTimeZone: 'UTC' };
    const past = daysAgoIso(2);
    const today = daysAgoIso(0);
    const uncertainStart = daysAgoIso(7);
    const future = daysAgoIso(-2);
    await insertTick({ ...log, climbedAt: past, precision: 'day', reportingDate: past.slice(0, 10) });
    await insertTick({ ...log, climbedAt: today, precision: 'day', reportingDate: today.slice(0, 10) });
    await insertTick({
      ...log,
      climbedAt: uncertainStart,
      precision: 'day',
      reportingDate: uncertainStart.slice(0, 10),
    });
    await insertTick({ ...log, climbedAt: future, precision: 'day', reportingDate: future.slice(0, 10) });
    await insertTick({ ...log, climbedAt: past, precision: null });
    const stats = await readStats();
    expect(stats.current.ascentCount).toBe(4);
    expect(stats.coverage).toMatchObject({ dateOnlyCount: 1, boundaryUncertainCount: 2, unknownTimeCount: 1 });
  });

  it('reports only observations in the checked year, including its lower bound but excluding asOf', async () => {
    const emptyGym = await insertGym({ ownerId: OWNER, name: 'Checked interval', slug: 'checked-interval' });
    const checkedBoard = await insertBoard({ gymId: emptyGym.id, ownerId: OWNER, name: 'Checked wall' });
    const end = '2026-11-23T00:00:00.000Z';
    const start = '2025-11-23T00:00:00.000Z';
    const before = '2025-11-22T23:59:59.999999Z';
    const tick = { userId: OWNER, boardId: checkedBoard.id, climbUuid: CLIMB_X };
    const display = { userId: OWNER, boardId: checkedBoard.id };
    await insertTick({ ...tick, climbedAt: before });
    await insertDisplay({ ...display, confirmedAt: before });
    await insertTick({ ...tick, climbedAt: end });
    await insertDisplay({ ...display, confirmedAt: end });
    const readCheckedCoverage = () =>
      withGymReportingScope({ gymUuid: emptyGym.uuid }, authCtx(OWNER), async (tx, scope) => {
        const windows = await readReportingBoundaries(tx, 'UTC', end, scope.periodDays);
        return readGymReportingCoverage(tx, { ...scope, ...windows, asOf: end });
      });
    expect(await readCheckedCoverage()).toMatchObject({
      observedSince: start,
      firstDisplayAt: null,
      firstTickAt: null,
    });
    await insertTick({ ...tick, climbedAt: start });
    await insertDisplay({ ...display, confirmedAt: start });
    expect(await readCheckedCoverage()).toMatchObject({
      observedSince: start,
      firstDisplayAt: start,
      firstTickAt: start,
    });
  });

  it('uses board ID and both time bounds in first-observed index probes against a large older legacy history', async () => {
    // The local fixture mirrors existing production indexes. Older legacy
    // rows deliberately have no reporting evidence and must be skipped by
    // each time range before source and privacy filtering.
    await db.execute(sql`INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, climbed_at, board_id)
      SELECT 'analytics-old-fixture-' || n, ${OWNER}, ${BOARD_TYPE}, ${CLIMB_X}, 40, 'send',
        timestamp '2024-01-01' + make_interval(mins => n), ${boardA.id}
      FROM generate_series(1, 2400) n`);
    await db.execute(sql`INSERT INTO board_climb_events (board_id, board_type, climb_uuid, angle, seq, confirmed_at)
      SELECT ${boardA.id}, ${BOARD_TYPE}, ${CLIMB_X}, 40, n, timestamp '2024-01-01' + make_interval(mins => n)
      FROM generate_series(1, 2400) n`);
    const plan = await withGymReportingScope(
      { gymUuid: publicGym.uuid, boardUuid: boardA.uuid },
      authCtx(OWNER),
      async (tx, scope) => {
        await tx.execute(sql`SET LOCAL enable_seqscan = off`);
        const sqlRows = await tx.execute<{ 'QUERY PLAN': string }>(sql`
        EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) ${reportingActivitySql(scope, {
          start: '2025-11-23T00:00:00.000Z',
          end: '2026-11-23T00:00:00.000Z',
          firstObservedOnly: true,
        })}
      `);
        const overviewRows = await tx.execute<{ 'QUERY PLAN': string }>(sql`
          EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) ${gymStatsSnapshotSql(scope)}
        `);
        return {
          firstObserved: sqlRows.map((row) => row['QUERY PLAN']),
          overview: overviewRows.map((row) => row['QUERY PLAN']),
        };
      },
    );
    for (const queryPlan of [plan.firstObserved, plan.overview]) {
      expect(queryPlan.join('\n')).toContain('boardsesh_ticks_board_climbed_at_idx');
      expect(queryPlan.join('\n')).toContain('board_climb_events_chronological_idx');
      for (const column of ['climbed_at', 'confirmed_at']) {
        expect(
          queryPlan.filter(
            (line) =>
              line.includes('Index Cond:') &&
              line.includes('board_id') &&
              line.includes(`${column} >=`) &&
              line.includes(`${column} <`),
          ),
        ).toHaveLength(1);
      }
    }
  });

  it('ties reporting precision to exact native time across unchanged and rewritten sync timestamps', async () => {
    const instantId = uuidv4();
    const dayId = uuidv4();
    const original = daysAgoIso(3).replace(/\.\d+Z$/, '.123456Z');
    const changed = daysAgoIso(2).replace(/\.\d+Z$/, '.654321Z');
    const log = { userId: OWNER, boardId: boardA.id, climbUuid: CLIMB_X, climbedAt: original };
    await insertTick({ ...log, uuid: instantId });
    await insertTick({
      ...log,
      uuid: dayId,
      precision: 'day',
      reportingDate: original.slice(0, 10),
      reportingTimeZone: 'UTC',
    });
    expect((await readStats()).current.ascentCount).toBe(5);

    // Same UTC timestamp using a different serialization is still the same
    // certified value. Both sync engines update the same physical column.
    await db.execute(sql`UPDATE boardsesh_ticks SET climbed_at = ${original.replace('T', ' ').replace('Z', '')}::timestamp
      WHERE uuid IN (${instantId}, ${dayId})`);
    expect((await readStats()).current.ascentCount).toBe(5);
    await db.execute(sql`UPDATE boardsesh_ticks SET climbed_at = ${changed}::timestamptz AT TIME ZONE 'UTC',
      kilter_id = 'analytics-kilter-rewrite' WHERE uuid = ${instantId}`);
    await db.execute(sql`UPDATE boardsesh_ticks SET climbed_at = ${changed}::timestamptz AT TIME ZONE 'UTC',
      aurora_id = 'analytics-aurora-rewrite' WHERE uuid = ${dayId}`);
    const changedStats = await readStats();
    expect(changedStats.current.ascentCount).toBe(3);
    expect(changedStats.coverage).toMatchObject({ dateOnlyCount: 0, unknownTimeCount: 2 });

    await tickMutations.updateTick(
      {},
      {
        uuid: instantId,
        input: {
          climbedAt: changed,
          reportingTime: { precision: 'instant' },
        },
      },
      authCtx(OWNER),
    );
    expect((await readStats()).current.ascentCount).toBe(4);
    const [bound] = await db.execute<{ microseconds: string }>(sql`
      SELECT to_char(reporting_climbed_at, 'US') AS microseconds FROM boardsesh_ticks WHERE uuid = ${instantId}
    `);
    expect(bound.microseconds).toBe('654321');
  });

  it('accepts a staff-configured zone and records author calendar evidence independently from the log timestamp', async () => {
    await expect(
      gymReportingSettingsMutations.setGymReportingTimeZone(
        {},
        {
          input: {
            gymUuid: publicGym.uuid,
            timeZone: '-05:00',
          },
        },
        authCtx(EDITOR),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'INVALID_TIME_ZONE' } });
    await gymReportingSettingsMutations.setGymReportingTimeZone(
      {},
      {
        input: {
          gymUuid: publicGym.uuid,
          timeZone: 'America/New_York',
        },
      },
      authCtx(EDITOR),
    );
    expect(await readStats()).toMatchObject({ timeZone: 'America/New_York', timeZoneConfigured: true });
    const stamp = '2026-01-08T01:50:00.123456Z';
    expect(
      await tickReportingTime(stamp, { precision: 'day', date: '2026-01-07', timeZone: 'America/New_York' }),
    ).toMatchObject({ reportingDate: '2026-01-07', reportingTimePrecision: 'day' });
    expect(await tickReportingTime(stamp, { precision: 'instant' })).toMatchObject({
      reportingTimePrecision: 'instant',
    });
    expect(await tickReportingTime(stamp)).toMatchObject({ reportingTimePrecision: null });
  });
});
