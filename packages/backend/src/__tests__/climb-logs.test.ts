import { beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createRequire } from 'node:module';
import { sql } from 'drizzle-orm';
import type * as GraphQLModule from 'graphql';
import type { ClimbLogsInput, ConnectionContext } from '@boardsesh/shared-schema';
import { GET_CLIMB_LOGS } from '@boardsesh/graphql/operations/social';
import * as dbSchema from '@boardsesh/db/schema';

/**
 * `climbLogs` against the real worker Postgres (#5968).
 *
 * This reader is PUBLIC and takes a caller-supplied climb uuid, so the thing
 * that matters most is whether a log on a private spray wall reaches somebody
 * who cannot see the wall. That, the keyset paging and the one-row-per-climber
 * pick are all SQL, so they are asserted against SQL. Every privacy case runs
 * on both query paths (plain and `latestPerClimber`): they are two statements,
 * and one of them carrying the predicate says nothing about the other.
 *
 * Every case goes through the executable schema with the shipped document.
 */

vi.mock('../utils/rate-limiter', () => ({
  checkRateLimit: vi.fn(),
  resetAllRateLimits: vi.fn(),
}));

vi.mock('../utils/redis-rate-limiter', () => ({
  checkRateLimitRedis: vi.fn().mockResolvedValue(undefined),
}));

// `graphql` resolves to two module instances under the test transform. The
// schema was built with the CJS copy, so `execute` has to come from the same
// one. See spray-visibility-sweep.test.ts for the long version.
const requireFromHere = createRequire(import.meta.url);
const { execute, parse } = requireFromHere('graphql') as typeof GraphQLModule;

const { db } = await import('../db/client');
const { schema } = await import('../graphql/index');
const { logger } = await import('../utils/logger');

const VIEWER = 'cl-viewer';
/** Followed by VIEWER. */
const BEA = 'cl-bea';
const CAL = 'cl-cal';
const DEE = 'cl-dee';
const EVE = 'cl-eve';
/** Owns the spray walls. */
const WALL_OWNER = 'cl-wall-owner';
/** Belongs to the gym the gym wall is attached to. */
const GYM_MEMBER = 'cl-gym-member';
/** Signed in, follows the wall owner, and can see none of the private walls. */
const STRANGER = 'cl-stranger';
const ALL_USERS = [VIEWER, BEA, CAL, DEE, EVE, WALL_OWNER, GYM_MEMBER, STRANGER];

const BOARD = 'kilter';
const CLIMB_UUID = 'cl-climb';
/** A catalogue climb nobody in this file ever logs. */
const UNLOGGED_CLIMB_UUID = 'cl-unlogged-climb';
const SPRAY_CLIMB_NAME = 'Cl Private Wall Climb';
const OWNER_NOTE = 'Cl note the owner left on a private wall';
const MEMBER_NOTE = 'Cl note a gym member left on a private wall';

type Item = {
  uuid: string;
  userId: string;
  userDisplayName: string | null;
  userAvatarUrl: string | null;
  climbUuid: string;
  angle: number;
  status: string;
  attemptCount: number;
  quality: number | null;
  effectiveQuality: number | null;
  difficulty: number | null;
  comment: string;
  climbedAt: string;
};
type Answer = { items: Item[]; cursor: string | null; hasMore: boolean };
type Filters = Omit<ClimbLogsInput, 'boardType' | 'climbUuid'>;

/** What "nothing to show" looks like, whatever the reason. */
const EMPTY_ANSWER: Answer = { items: [], cursor: null, hasMore: false };

const ctxFor = (userId: string | null): ConnectionContext =>
  ({
    connectionId: `conn-${userId ?? 'anon'}`,
    isAuthenticated: userId != null,
    userId: userId ?? null,
  }) as unknown as ConnectionContext;

async function run(viewer: string | null, input: ClimbLogsInput, context: ConnectionContext = ctxFor(viewer)) {
  const result = await execute({
    schema,
    document: parse(GET_CLIMB_LOGS),
    variableValues: { input },
    contextValue: context,
  });
  return {
    errors: result.errors ?? [],
    answer: (result.data as { climbLogs?: unknown } | null | undefined)?.climbLogs,
  };
}

/** One page of the test climb, as `viewer` (null = signed out). Fails on any GraphQL error. */
async function ask(viewer: string | null, filters: Filters = {}, climb: Partial<ClimbLogsInput> = {}): Promise<Answer> {
  const { errors, answer } = await run(viewer, { boardType: BOARD, climbUuid: CLIMB_UUID, ...filters, ...climb });
  expect(errors.map((error) => error.message)).toEqual([]);
  return answer as Answer;
}

/** Follows the cursor to the end. Returns each page so a test can count them. */
async function askAllPages(viewer: string | null, filters: Filters): Promise<Answer[]> {
  const pages: Answer[] = [];
  let cursor: string | null = null;
  do {
    const page: Answer = await ask(viewer, { ...filters, cursor });
    pages.push(page);
    cursor = page.cursor;
    // A resolver that never ends the list would hang the suite, not fail it.
    expect(pages.length).toBeLessThan(20);
  } while (cursor);
  return pages;
}

type TickOverrides = Partial<typeof dbSchema.boardseshTicks.$inferInsert>;

let tickSeq = 0;

async function insertTick(overrides: TickOverrides = {}): Promise<string> {
  tickSeq += 1;
  const row: typeof dbSchema.boardseshTicks.$inferInsert = {
    uuid: `cl-tick-${tickSeq}`,
    userId: BEA,
    boardType: BOARD,
    climbUuid: CLIMB_UUID,
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 2,
    quality: null,
    difficulty: null,
    isBenchmark: false,
    comment: '',
    climbedAt: '2026-05-01T18:00:00.000Z',
    ...overrides,
  };
  await db.insert(dbSchema.boardseshTicks).values(row);
  return row.uuid;
}

/** Midday on the given day of May 2026: a later day is a newer log. */
const onDay = (day: number) => `2026-05-${String(day).padStart(2, '0')}T12:00:00.000Z`;

const follow = (followerId: string, followingId: string) =>
  db.insert(dbSchema.userFollows).values({ followerId, followingId });

let wallSeq = 0;

/**
 * One spray wall and one climb on it, written straight into the tables the
 * visibility predicate reads, with a log by the owner and one by a gym member.
 */
async function seedWall({ isPublic, inGym = false }: { isPublic: boolean; inGym?: boolean }) {
  wallSeq += 1;
  const wallUuid = `cl-wall-${wallSeq}`;
  const layoutId = 565000 + wallSeq;
  const climbUuid = `cl-spray-climb-${wallSeq}`;
  let gymId: number | null = null;
  if (inGym) {
    const gymUuid = `cl-gym-${wallSeq}`;
    const [gym] = (await db.execute(sql`
      INSERT INTO gyms (uuid, name, slug, owner_id, is_public, created_at, updated_at)
      VALUES (${gymUuid}, 'Cl gym', ${gymUuid}, ${WALL_OWNER}, true, now(), now())
      RETURNING id
    `)) as unknown as Array<{ id: number }>;
    gymId = Number(gym.id);
    await db.execute(sql`INSERT INTO gym_members (gym_id, user_id, role) VALUES (${gymId}, ${GYM_MEMBER}, 'member')`);
  }
  await db.execute(sql`
    INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, is_public, has_leds, gym_id)
    VALUES (${wallUuid}, ${wallUuid}, ${WALL_OWNER}, 'spray', ${layoutId}, ${layoutId}, '1', 'Cl wall', ${isPublic}, false, ${gymId})
  `);
  await db.execute(sql`INSERT INTO spray_walls (board_uuid, layout_id) VALUES (${wallUuid}, ${layoutId})`);
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, name, frames, frames_count, is_draft, is_listed, created_at)
    VALUES (${climbUuid}, 'spray', ${layoutId}, ${SPRAY_CLIMB_NAME}, 'p1r1', 1, false, true, '2026-01-01')
  `);
  await insertTick({ userId: WALL_OWNER, boardType: 'spray', climbUuid, comment: OWNER_NOTE, climbedAt: onDay(2) });
  await insertTick({ userId: GYM_MEMBER, boardType: 'spray', climbUuid, comment: MEMBER_NOTE, climbedAt: onDay(1) });
  return { wallUuid, climbUuid };
}

beforeAll(async () => {
  for (const userId of ALL_USERS) {
    await db.execute(sql`
      INSERT INTO users (id, email, name, created_at, updated_at)
      VALUES (${userId}, ${userId + '@test.com'}, ${'Climber ' + userId}, now(), now())
      ON CONFLICT (id) DO NOTHING
    `);
  }
});

beforeEach(async () => {
  vi.clearAllMocks();
  await db.execute(sql`DELETE FROM boardsesh_ticks WHERE uuid LIKE 'cl-%'`);
  await db.execute(sql`DELETE FROM board_climb_ratings WHERE climb_uuid LIKE 'cl-%'`);
  await db.execute(sql`DELETE FROM user_follows WHERE follower_id LIKE 'cl-%'`);
  await db.execute(sql`DELETE FROM user_profiles WHERE user_id LIKE 'cl-%'`);
  await db.execute(sql`UPDATE users SET name = ${'Climber ' + BEA}, image = NULL WHERE id = ${BEA}`);
  await db.execute(sql`DELETE FROM spray_walls WHERE board_uuid LIKE 'cl-%'`);
  await db.execute(sql`DELETE FROM user_boards WHERE uuid LIKE 'cl-%'`);
  await db.execute(sql`DELETE FROM gyms WHERE uuid LIKE 'cl-%'`);
  await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE 'cl-%'`);

  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, frames, frames_count, is_draft, is_listed, created_at)
    VALUES (${CLIMB_UUID}, ${BOARD}, 1, 'test-setter', 'Climb Logs Test Climb', 'p1r1', 1, false, true, '2024-01-01'),
           (${UNLOGGED_CLIMB_UUID}, ${BOARD}, 1, 'test-setter', 'Nobody logged this', 'p1r1', 1, false, true, '2024-01-01')
  `);
  await follow(VIEWER, BEA);
  await follow(STRANGER, WALL_OWNER);
});

describe('ordering and paging', () => {
  it('puts the newest log first and breaks a tie on the timestamp by id', async () => {
    const oldest = await insertTick({ userId: BEA, climbedAt: onDay(1) });
    const tiedFirst = await insertTick({ userId: CAL, climbedAt: onDay(2) });
    const tiedSecond = await insertTick({ userId: DEE, climbedAt: onDay(2) });
    const newest = await insertTick({ userId: EVE, climbedAt: onDay(3) });

    const answer = await ask(null);

    // The later insert has the larger id, and comes first within the tie.
    expect(answer.items.map((item) => item.uuid)).toEqual([newest, tiedSecond, tiedFirst, oldest]);
    expect(answer).toMatchObject({ hasMore: false, cursor: null });
  });

  it('pages five logs two at a time with no repeat and no gap', async () => {
    const uuids: string[] = [];
    for (let day = 1; day <= 5; day += 1) uuids.push(await insertTick({ climbedAt: onDay(day) }));

    const pages = await askAllPages(null, { limit: 2 });

    expect(pages.map((page) => page.items.length)).toEqual([2, 2, 1]);
    expect(pages.map((page) => page.hasMore)).toEqual([true, true, false]);
    expect(pages[2].cursor).toBeNull();
    expect(pages.flatMap((page) => page.items.map((item) => item.uuid))).toEqual([...uuids].reverse());
  });

  it('pages through logs that share one timestamp without losing any', async () => {
    const uuids: string[] = [];
    for (let index = 0; index < 5; index += 1) uuids.push(await insertTick({ climbedAt: onDay(1) }));

    const pages = await askAllPages(null, { limit: 2 });

    expect(pages.flatMap((page) => page.items.map((item) => item.uuid))).toEqual([...uuids].reverse());
  });

  it('reports a page that is exactly full as the last one', async () => {
    await insertTick({ climbedAt: onDay(1) });
    await insertTick({ climbedAt: onDay(2) });

    expect(await ask(null, { limit: 2 })).toMatchObject({ hasMore: false, cursor: null });
  });

  it('rejects an empty cursor instead of starting again at page one', async () => {
    await insertTick();

    const { errors, answer } = await run(null, { boardType: BOARD, climbUuid: CLIMB_UUID, cursor: '' });

    expect(answer).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0].extensions?.code).toBe('BAD_USER_INPUT');
  });

  it('rejects a cursor it cannot decode, and does not log it as a DB error', async () => {
    await insertTick();
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => logger);

    const { errors, answer } = await run(null, { boardType: BOARD, climbUuid: CLIMB_UUID, cursor: 'not-a-cursor' });

    // Not page one: a client with a broken cursor must hear about it.
    expect(answer).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0].extensions?.code).toBe('BAD_USER_INPUT');
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });
});

describe('filters', () => {
  it('keeps only the asked angle, and answers an angle with no logs with an empty page', async () => {
    const at40 = await insertTick({ angle: 40, climbedAt: onDay(1) });
    await insertTick({ angle: 45, climbedAt: onDay(2) });

    expect((await ask(null, { angle: 40 })).items.map((item) => item.uuid)).toEqual([at40]);
    expect(await ask(null, { angle: 70 })).toEqual(EMPTY_ANSWER);
    // Not an angle any board has. Still an empty page, not a validation error.
    expect(await ask(null, { angle: -5 })).toEqual(EMPTY_ANSWER);
  });

  it('drops attempts with sendsOnly', async () => {
    const send = await insertTick({ userId: BEA, status: 'send', climbedAt: onDay(1) });
    const flash = await insertTick({ userId: CAL, status: 'flash', attemptCount: 1, climbedAt: onDay(2) });
    await insertTick({ userId: DEE, status: 'attempt', climbedAt: onDay(3) });

    expect((await ask(null, { sendsOnly: true })).items.map((item) => item.uuid)).toEqual([flash, send]);
  });

  it('drops logs with no note, an empty note or only whitespace with withNotes', async () => {
    const noted = await insertTick({ userId: BEA, comment: 'left heel on the start' });
    await insertTick({ userId: CAL, comment: '' });
    await insertTick({ userId: DEE, comment: '   \n ' });
    const noNote = await insertTick({ userId: EVE });
    await db.execute(sql`UPDATE boardsesh_ticks SET comment = NULL WHERE uuid = ${noNote}`);

    expect((await ask(null, { withNotes: true })).items.map((item) => item.uuid)).toEqual([noted]);
  });

  it("drops the caller's own logs and logs by people they follow with excludeFollowed", async () => {
    await insertTick({ userId: VIEWER, climbedAt: onDay(4) });
    await insertTick({ userId: BEA, climbedAt: onDay(3) });
    await insertTick({ userId: CAL, climbedAt: onDay(2) });
    await insertTick({ userId: DEE, climbedAt: onDay(1) });

    const answer = await ask(VIEWER, { excludeFollowed: true });

    expect(answer.items.map((item) => item.userId)).toEqual([CAL, DEE]);
  });

  it('ignores excludeFollowed for a signed-out caller', async () => {
    await insertTick({ userId: VIEWER, climbedAt: onDay(2) });
    await insertTick({ userId: BEA, climbedAt: onDay(1) });

    expect((await ask(null, { excludeFollowed: true })).items.map((item) => item.userId)).toEqual([VIEWER, BEA]);
  });

  it('does not trust a user id on a context that is not authenticated', async () => {
    await insertTick({ userId: VIEWER, climbedAt: onDay(2) });
    await insertTick({ userId: BEA, climbedAt: onDay(1) });
    const hopeful = {
      connectionId: 'conn-hopeful',
      isAuthenticated: false,
      userId: VIEWER,
    } as unknown as ConnectionContext;

    const { errors, answer } = await run(
      null,
      { boardType: BOARD, climbUuid: CLIMB_UUID, excludeFollowed: true },
      hopeful,
    );

    expect(errors).toEqual([]);
    expect((answer as Answer).items.map((item) => item.userId)).toEqual([VIEWER, BEA]);
  });
});

describe('one row per climber', () => {
  it("returns each climber's newest log only", async () => {
    await insertTick({ userId: BEA, climbedAt: onDay(1) });
    const beaNewest = await insertTick({ userId: BEA, climbedAt: onDay(4) });
    const calOnly = await insertTick({ userId: CAL, climbedAt: onDay(3) });
    await insertTick({ userId: DEE, climbedAt: onDay(1) });
    const deeNewest = await insertTick({ userId: DEE, climbedAt: onDay(2) });

    const answer = await ask(null, { latestPerClimber: true });

    expect(answer.items.map((item) => item.uuid)).toEqual([beaNewest, calOnly, deeNewest]);
  });

  it('picks the newest log that passes the filters, not the newest log', async () => {
    const send = await insertTick({ userId: BEA, status: 'send', angle: 40, climbedAt: onDay(1) });
    await insertTick({ userId: BEA, status: 'attempt', angle: 40, climbedAt: onDay(2) });
    const at45 = await insertTick({ userId: BEA, status: 'attempt', angle: 45, climbedAt: onDay(3) });
    const noted = await insertTick({
      userId: BEA,
      status: 'attempt',
      angle: 40,
      comment: 'sloper',
      climbedAt: '2026-04-30T12:00:00.000Z',
    });

    const pick = async (filters: Filters) =>
      (await ask(null, { latestPerClimber: true, ...filters })).items.map((item) => item.uuid);

    expect(await pick({})).toEqual([at45]);
    expect(await pick({ sendsOnly: true })).toEqual([send]);
    expect(await pick({ angle: 45 })).toEqual([at45]);
    expect(await pick({ withNotes: true })).toEqual([noted]);
  });

  it('pages five climbers two at a time without repeating one', async () => {
    const climbers = [BEA, CAL, DEE, EVE, VIEWER];
    for (const [index, userId] of climbers.entries()) {
      await insertTick({ userId, climbedAt: onDay(index + 1) });
      await insertTick({ userId, climbedAt: onDay(index + 11) });
    }

    const pages = await askAllPages(null, { latestPerClimber: true, limit: 2 });

    expect(pages.map((page) => page.items.length)).toEqual([2, 2, 1]);
    expect(pages.flatMap((page) => page.items.map((item) => item.userId))).toEqual([...climbers].reverse());
  });

  // Paging here is not snapshot-stable, and this pins which way it fails: a
  // climber who logs again mid-scroll may be missed for that scroll, and is
  // never shown twice.
  it('does not return a climber twice when they log again between two pages', async () => {
    await insertTick({ userId: BEA, climbedAt: onDay(4) });
    await insertTick({ userId: CAL, climbedAt: onDay(3) });
    await insertTick({ userId: DEE, climbedAt: onDay(2) });
    await insertTick({ userId: EVE, climbedAt: onDay(1) });

    const first = await ask(null, { latestPerClimber: true, limit: 2 });
    expect(first.items.map((item) => item.userId)).toEqual([BEA, CAL]);
    // Bea, already shown, logs again. So does Dee, who has not been shown yet.
    await insertTick({ userId: BEA, climbedAt: onDay(10) });
    await insertTick({ userId: DEE, climbedAt: onDay(11) });
    const second = await ask(null, { latestPerClimber: true, limit: 2, cursor: first.cursor });

    expect(second.items.map((item) => item.userId)).toEqual([EVE]);
  });

  it('applies excludeFollowed before the pick', async () => {
    await insertTick({ userId: VIEWER, climbedAt: onDay(3) });
    await insertTick({ userId: BEA, climbedAt: onDay(2) });
    const cal = await insertTick({ userId: CAL, climbedAt: onDay(1) });

    const answer = await ask(VIEWER, { latestPerClimber: true, excludeFollowed: true });

    expect(answer.items.map((item) => item.uuid)).toEqual([cal]);
  });
});

describe("Aurora's own duplicate rows", () => {
  const twin = {
    userId: BEA,
    origin: 'aurora_pull' as const,
    auroraType: 'ascents' as const,
    quality: 3,
    difficulty: 21,
    comment: 'crimpy',
    // The pull writes both from one `now()`, so a freshly pulled row is not
    // "locally edited". See aurora-twin-dedup.test.ts.
    updatedAt: '2026-05-01T18:00:00.000Z',
    auroraSyncedAt: '2026-05-01T18:00:00.000Z',
  };

  it('returns a twin pair once', async () => {
    await insertTick({ ...twin, auroraId: 'cl-aur-2' });
    await insertTick({ ...twin, auroraId: 'cl-aur-1' });

    expect((await ask(null)).items).toHaveLength(1);
  });

  it('keeps the climber when the row the window would rank first is the dropped twin', async () => {
    // The kept twin is the smaller aurora id. Inserted first, it has the
    // smaller row id, so the dropped one would win the (climbed_at, id) rank.
    const kept = await insertTick({ ...twin, auroraId: 'cl-aur-1' });
    await insertTick({ ...twin, auroraId: 'cl-aur-2' });

    const answer = await ask(null, { latestPerClimber: true });

    expect(answer.items.map((item) => item.uuid)).toEqual([kept]);
  });

  it('still hides the twin once the kept row has been edited here', async () => {
    // Edited after its last sync, so the payload no longer has to match.
    const kept = await insertTick({
      ...twin,
      auroraId: 'cl-aur-1',
      comment: 'edited in Boardsesh',
      updatedAt: '2026-05-02T09:00:00.000Z',
    });
    await insertTick({ ...twin, auroraId: 'cl-aur-2' });

    expect((await ask(null)).items.map((item) => item.uuid)).toEqual([kept]);
  });

  it('keeps both rows when only the larger aurora id was edited here', async () => {
    // Only an edit on the row that would be KEPT relaxes the payload match.
    await insertTick({ ...twin, auroraId: 'cl-aur-1' });
    await insertTick({
      ...twin,
      auroraId: 'cl-aur-2',
      comment: 'edited in Boardsesh',
      updatedAt: '2026-05-02T09:00:00.000Z',
    });

    expect((await ask(null)).items).toHaveLength(2);
  });

  it('keeps an attempt beside a send at the same instant, even once the smaller id is edited', async () => {
    await insertTick({ ...twin, auroraId: 'cl-aur-1', status: 'attempt', updatedAt: '2026-05-02T09:00:00.000Z' });
    await insertTick({ ...twin, auroraId: 'cl-aur-2' });

    expect((await ask(null)).items).toHaveLength(2);
  });

  it('keeps two rows that each carry their own Kilter link', async () => {
    await insertTick({ ...twin, auroraId: 'cl-aur-1', kilterId: 'cl-kilter-1' });
    await insertTick({ ...twin, auroraId: 'cl-aur-2', kilterId: 'cl-kilter-2' });

    expect((await ask(null)).items).toHaveLength(2);
  });

  it('keeps two Aurora sends by one climber that are not the same ascent', async () => {
    await insertTick({ ...twin, auroraId: 'cl-aur-1' });
    await insertTick({ ...twin, auroraId: 'cl-aur-2', climbedAt: '2026-05-01T18:00:01.000Z' });
    await insertTick({ ...twin, auroraId: 'cl-aur-3', angle: 45 });

    expect((await ask(null)).items).toHaveLength(3);
  });

  it('collapses a four-copy group to its smallest aurora id, among other climbers', async () => {
    await insertTick({ userId: CAL, climbedAt: onDay(3) });
    const kept = await insertTick({ ...twin, auroraId: 'cl-aur-1' });
    for (const auroraId of ['cl-aur-2', 'cl-aur-3', 'cl-aur-4']) await insertTick({ ...twin, auroraId });

    const answer = await ask(null);

    expect(answer.items).toHaveLength(2);
    expect(answer.items.map((item) => item.uuid)).toContain(kept);
  });
});

describe('the fields on a row', () => {
  const insertRating = (overrides: Partial<typeof dbSchema.boardClimbRatings.$inferInsert> = {}) =>
    db.insert(dbSchema.boardClimbRatings).values({
      boardType: BOARD,
      climbUuid: CLIMB_UUID,
      angle: 40,
      userId: BEA,
      rating: 4,
      ...overrides,
    });

  it.each([{ latestPerClimber: false }, { latestPerClimber: true }])(
    "falls back to the climber's synced rating when the send has no quality ($latestPerClimber)",
    async (filters) => {
      await insertTick({ quality: null });
      await insertRating();

      expect((await ask(null, filters)).items[0]).toMatchObject({ quality: null, effectiveQuality: 4 });
    },
  );

  it('ignores a rating the climber deleted upstream', async () => {
    await insertTick({ quality: null });
    await insertRating({ kilterDetachedAt: new Date() });

    expect((await ask(null)).items[0]).toMatchObject({ quality: null, effectiveQuality: null });
  });

  it('gives an attempt no stars, even at an angle the climber rated', async () => {
    await insertTick({ status: 'attempt', quality: null });
    await insertRating();

    expect((await ask(null)).items[0].effectiveQuality).toBeNull();
  });

  it('returns the personal grade, the tries, the angle and the note as logged', async () => {
    await insertTick({ difficulty: 22, attemptCount: 5, angle: 45, comment: 'match the pinch' });

    expect((await ask(null)).items[0]).toMatchObject({
      userId: BEA,
      climbUuid: CLIMB_UUID,
      difficulty: 22,
      attemptCount: 5,
      angle: 45,
      status: 'send',
      comment: 'match the pinch',
    });
  });

  it('prefers the profile name and avatar, then the account ones, then nothing', async () => {
    await insertTick();

    expect((await ask(null)).items[0]).toMatchObject({ userDisplayName: `Climber ${BEA}`, userAvatarUrl: null });

    await db.execute(sql`UPDATE users SET image = 'https://example.com/account.png' WHERE id = ${BEA}`);
    expect((await ask(null)).items[0].userAvatarUrl).toBe('https://example.com/account.png');

    await db.insert(dbSchema.userProfiles).values({
      userId: BEA,
      displayName: 'Bea the crimper',
      avatarUrl: 'https://example.com/profile.png',
    });
    expect((await ask(null)).items[0]).toMatchObject({
      userDisplayName: 'Bea the crimper',
      userAvatarUrl: 'https://example.com/profile.png',
    });

    await db.execute(sql`UPDATE users SET name = NULL, image = NULL WHERE id = ${BEA}`);
    await db.execute(sql`DELETE FROM user_profiles WHERE user_id = ${BEA}`);
    expect((await ask(null)).items[0]).toMatchObject({ userDisplayName: null, userAvatarUrl: null });
  });
});

describe('which climb', () => {
  it('gives the empty answer for a climb nobody has logged and for an unknown uuid', async () => {
    await insertTick();

    expect(await ask(null, {}, { climbUuid: UNLOGGED_CLIMB_UUID })).toEqual(EMPTY_ANSWER);
    expect(await ask(null, {}, { climbUuid: 'cl-no-such-climb' })).toEqual(EMPTY_ANSWER);
  });

  it('does not match the same uuid under another board type', async () => {
    await insertTick();

    expect(await ask(null, {}, { boardType: 'tension' })).toEqual(EMPTY_ANSWER);
    expect(await ask(null, { latestPerClimber: true }, { boardType: 'tension' })).toEqual(EMPTY_ANSWER);
  });
});

// Both statements carry the predicate separately, so every case runs on both.
describe.each([
  { path: 'plain', latestPerClimber: false },
  { path: 'one row per climber', latestPerClimber: true },
])('spray-wall privacy, $path path', ({ latestPerClimber }) => {
  const askWall = (viewer: string | null, climbUuid: string, boardType = 'spray') =>
    ask(viewer, { latestPerClimber }, { boardType, climbUuid });
  const notes = (answer: Answer) => answer.items.map((item) => item.comment);

  it('hides a PRIVATE wall from a signed-out caller', async () => {
    const { climbUuid } = await seedWall({ isPublic: false });

    const answer = await askWall(null, climbUuid);

    expect(answer).toEqual(EMPTY_ANSWER);
    // The SAME answer a climb nobody logged gives, so the wall's existence
    // cannot be read off the shape of the response.
    expect(answer).toEqual(await ask(null, { latestPerClimber }, { climbUuid: UNLOGGED_CLIMB_UUID }));
    expect(JSON.stringify(answer)).not.toContain('Cl note');
  });

  it('hides a PRIVATE wall from a signed-in stranger, even one who follows the owner', async () => {
    const { climbUuid } = await seedWall({ isPublic: false, inGym: true });

    expect(await askWall(VIEWER, climbUuid)).toEqual(EMPTY_ANSWER);
    // STRANGER follows the wall owner. Following somebody is not seeing their wall.
    expect(await askWall(STRANGER, climbUuid)).toEqual(EMPTY_ANSWER);
  });

  it('hides a PRIVATE wall from every filter combination', async () => {
    const { climbUuid } = await seedWall({ isPublic: false });
    const filterSets: Filters[] = [
      { angle: 40 },
      { withNotes: true },
      { sendsOnly: true },
      { excludeFollowed: true },
      { angle: 40, withNotes: true, sendsOnly: true, excludeFollowed: true, limit: 1 },
    ];

    for (const filters of filterSets) {
      expect(await ask(STRANGER, { latestPerClimber, ...filters }, { boardType: 'spray', climbUuid })).toEqual(
        EMPTY_ANSWER,
      );
    }
  });

  it("shows a PRIVATE wall to its owner and to a member of the wall's gym", async () => {
    const { climbUuid } = await seedWall({ isPublic: false, inGym: true });

    expect(notes(await askWall(WALL_OWNER, climbUuid))).toEqual([OWNER_NOTE, MEMBER_NOTE]);
    expect(notes(await askWall(GYM_MEMBER, climbUuid))).toEqual([OWNER_NOTE, MEMBER_NOTE]);
  });

  it('shows a PUBLIC wall to everybody, signed in or not', async () => {
    const { climbUuid } = await seedWall({ isPublic: true });

    expect(notes(await askWall(STRANGER, climbUuid))).toEqual([OWNER_NOTE, MEMBER_NOTE]);
    expect(notes(await askWall(null, climbUuid))).toEqual([OWNER_NOTE, MEMBER_NOTE]);
  });

  it('shows a wall an admin has hidden to its owner only, even though it is public', async () => {
    const { wallUuid, climbUuid } = await seedWall({ isPublic: true, inGym: true });
    await db.execute(sql`UPDATE spray_walls SET hidden_at = now() WHERE board_uuid = ${wallUuid}`);

    expect(notes(await askWall(WALL_OWNER, climbUuid))).toEqual([OWNER_NOTE, MEMBER_NOTE]);
    expect(await askWall(GYM_MEMBER, climbUuid)).toEqual(EMPTY_ANSWER);
    expect(await askWall(STRANGER, climbUuid)).toEqual(EMPTY_ANSWER);
    expect(await askWall(null, climbUuid)).toEqual(EMPTY_ANSWER);
  });

  it('shows a deleted wall to nobody, its owner included', async () => {
    const { wallUuid, climbUuid } = await seedWall({ isPublic: true });
    await db.execute(sql`UPDATE spray_walls SET deleted_at = now() WHERE board_uuid = ${wallUuid}`);

    expect(await askWall(WALL_OWNER, climbUuid)).toEqual(EMPTY_ANSWER);
    expect(await askWall(null, climbUuid)).toEqual(EMPTY_ANSWER);
  });

  it('hides a spray log whose climb row is gone, which has no wall left to check', async () => {
    const { climbUuid } = await seedWall({ isPublic: true });
    await db.execute(sql`DELETE FROM board_climbs WHERE uuid = ${climbUuid}`);

    expect(await askWall(WALL_OWNER, climbUuid)).toEqual(EMPTY_ANSWER);
    expect(await askWall(null, climbUuid)).toEqual(EMPTY_ANSWER);
  });

  it('does not answer for the spray climb under another board type', async () => {
    const { climbUuid } = await seedWall({ isPublic: true });

    expect(await askWall(WALL_OWNER, climbUuid, BOARD)).toEqual(EMPTY_ANSWER);
  });
});

describe("Aurora's own duplicate rows, with the twin lookup limited to Aurora-pull rows", () => {
  const pulled = {
    userId: BEA,
    origin: 'aurora_pull' as const,
    auroraType: 'ascents' as const,
    quality: 3,
    difficulty: 21,
    comment: 'crimpy',
    // A freshly pulled row is not "locally edited". See aurora-twin-dedup.test.ts.
    updatedAt: '2026-05-01T18:00:00.000Z',
    auroraSyncedAt: '2026-05-01T18:00:00.000Z',
  };

  it('keeps a native log that matches an Aurora-pull row in every column', async () => {
    await insertTick({ ...pulled, auroraId: 'cl-aur-1' });
    await insertTick({ ...pulled, origin: 'native', auroraId: null });

    expect((await ask(null)).items).toHaveLength(2);
  });

  it('keeps both rows when the Aurora-pull ids are json-import surrogates', async () => {
    await insertTick({ ...pulled, auroraId: 'json-import-cl-2' });
    await insertTick({ ...pulled, auroraId: 'json-import-cl-1' });

    expect((await ask(null)).items).toHaveLength(2);
  });
});
