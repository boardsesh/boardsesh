import { beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createRequire } from 'node:module';
import { sql } from 'drizzle-orm';
import type * as GraphQLModule from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { GET_FOLLOWING_CLIMB_ASCENTS } from '@boardsesh/graphql/operations/social';
import * as dbSchema from '@boardsesh/db/schema';

/**
 * `followingClimbAscents` against the real worker Postgres (#5965).
 *
 * Everything this resolver promises is a SQL predicate or a SQL aggregate: who
 * the viewer follows, Aurora's duplicate rows, the synced-rating fallback, the
 * counts that are not bound by the 100-row cap, and above all whether a log on
 * a private spray wall reaches somebody who cannot see the wall. A stub that
 * re-stated those rules in JS would assert its own copy of them.
 *
 * Most cases go through the executable schema rather than a direct resolver
 * call. The item type has non-null fields (`climbName`, `isNoMatch`) that the
 * resolver used to leave out, and only the schema's own execution notices that.
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
const { execute, parse, isLeafType, isNonNullType, isListType } = requireFromHere('graphql') as typeof GraphQLModule;

const { db } = await import('../db/client');
const { schema } = await import('../graphql/index');
const { socialFeedQueries } = await import('../graphql/resolvers/social/feed');

const VIEWER = 'fca-viewer';
const ALEX = 'fca-alex';
const BEA = 'fca-bea';
const CAL = 'fca-cal';
/** Logs climbs, and nobody in this file follows them. */
const UNFOLLOWED = 'fca-unfollowed';
/** Follows nobody. */
const LONER = 'fca-loner';
/** Owns the spray walls. */
const WALL_OWNER = 'fca-wall-owner';
const ALL_USERS = [VIEWER, ALEX, BEA, CAL, UNFOLLOWED, LONER, WALL_OWNER];

const BOARD = 'kilter';
const CLIMB_UUID = 'fca-climb';
const CLIMB_NAME = 'Following Ascents Test Climb';
/** A catalogue climb nobody in this file ever logs. */
const UNLOGGED_CLIMB_UUID = 'fca-unlogged-climb';
const SPRAY_CLIMB_NAME = 'Fca Private Wall Climb';
const SPRAY_NOTE = 'Fca note left on a private wall';

type Item = {
  uuid: string;
  userId: string;
  userDisplayName: string | null;
  angle: number;
  status: string;
  quality: number | null;
  effectiveQuality: number | null;
  difficulty: number | null;
  comment: string;
  climbedAt: string;
};
type AngleCount = { angle: number; climberCount: number; senderCount: number };
type Answer = {
  items: Item[];
  hasMore: boolean;
  summary: { climberCount: number; senderCount: number; byAngle: AngleCount[] };
};

/** What "nothing to show" looks like, whatever the reason. */
const EMPTY_ANSWER: Answer = {
  items: [],
  hasMore: false,
  summary: { climberCount: 0, senderCount: 0, byAngle: [] },
};

const ctxFor = (userId: string | null): ConnectionContext =>
  ({
    connectionId: `conn-${userId ?? 'anon'}`,
    isAuthenticated: userId != null,
    userId: userId ?? null,
  }) as unknown as ConnectionContext;

async function run(document: string, viewer: string | null, boardType: string, climbUuid: string) {
  const result = await execute({
    schema,
    document: parse(document),
    variableValues: { input: { boardType, climbUuid } },
    contextValue: ctxFor(viewer),
  });
  return {
    errors: (result.errors ?? []).map((error) => error.message),
    answer: (result.data as { followingClimbAscents?: unknown } | null | undefined)?.followingClimbAscents,
  };
}

/** The shipped operation document, as the phone sends it. Fails on any GraphQL error. */
async function ask(viewer: string, boardType: string = BOARD, climbUuid: string = CLIMB_UUID): Promise<Answer> {
  const { errors, answer } = await run(GET_FOLLOWING_CLIMB_ASCENTS, viewer, boardType, climbUuid);
  expect(errors).toEqual([]);
  return answer as Answer;
}

type TickOverrides = Partial<typeof dbSchema.boardseshTicks.$inferInsert>;

let tickSeq = 0;

function tickRow(overrides: TickOverrides = {}): typeof dbSchema.boardseshTicks.$inferInsert {
  tickSeq += 1;
  return {
    uuid: `fca-tick-${tickSeq}`,
    userId: ALEX,
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
}

async function insertTick(overrides: TickOverrides = {}): Promise<string> {
  const row = tickRow(overrides);
  await db.insert(dbSchema.boardseshTicks).values(row);
  return row.uuid;
}

const follow = (followerId: string, followingId: string) =>
  db.insert(dbSchema.userFollows).values({ followerId, followingId });

let wallSeq = 0;

/**
 * One spray wall and one climb on it, written straight into the tables the
 * visibility predicate reads. The wall mutations are not used: what is under
 * test is the READ side, and the predicate only looks at these rows.
 */
async function seedWall({
  isPublic,
  gymId = null,
}: {
  isPublic: boolean;
  gymId?: number | null;
}): Promise<{ wallUuid: string; climbUuid: string }> {
  wallSeq += 1;
  const wallUuid = `fca-wall-${wallSeq}`;
  const layoutId = 555000 + wallSeq;
  const climbUuid = `fca-spray-climb-${wallSeq}`;
  await db.execute(sql`
    INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, is_public, has_leds, gym_id)
    VALUES (${wallUuid}, ${wallUuid}, ${WALL_OWNER}, 'spray', ${layoutId}, ${layoutId}, '1', 'Fca wall', ${isPublic}, false, ${gymId})
  `);
  await db.execute(sql`INSERT INTO spray_walls (board_uuid, layout_id) VALUES (${wallUuid}, ${layoutId})`);
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, name, frames, frames_count, is_draft, is_listed, created_at)
    VALUES (${climbUuid}, 'spray', ${layoutId}, ${SPRAY_CLIMB_NAME}, 'p1r1', 1, false, true, '2026-01-01')
  `);
  return { wallUuid, climbUuid };
}

/** A log by the wall's owner, with a note worth leaking. */
const insertOwnerLog = (climbUuid: string) =>
  insertTick({ userId: WALL_OWNER, boardType: 'spray', climbUuid, comment: SPRAY_NOTE });

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
  await db.execute(sql`DELETE FROM boardsesh_ticks WHERE uuid LIKE 'fca-%'`);
  await db.execute(sql`DELETE FROM board_climb_ratings WHERE climb_uuid LIKE 'fca-%'`);
  await db.execute(sql`DELETE FROM user_follows WHERE follower_id LIKE 'fca-%'`);
  await db.execute(sql`DELETE FROM spray_walls WHERE board_uuid LIKE 'fca-%'`);
  await db.execute(sql`DELETE FROM user_boards WHERE uuid LIKE 'fca-%'`);
  await db.execute(sql`DELETE FROM gyms WHERE uuid LIKE 'fca-%'`);
  // Before the climbs: an alias row holds a foreign key to its canonical climb.
  await db.execute(sql`DELETE FROM board_climb_aliases WHERE alias_uuid LIKE 'fca-%'`);
  await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE 'fca-%'`);

  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, frames, frames_count, is_draft, is_listed, created_at)
    VALUES (${CLIMB_UUID}, ${BOARD}, 1, 'test-setter', ${CLIMB_NAME}, 'p1r1', 1, false, true, '2024-01-01'),
           (${UNLOGGED_CLIMB_UUID}, ${BOARD}, 1, 'test-setter', 'Nobody logged this', 'p1r1', 1, false, true, '2024-01-01')
  `);
  await follow(VIEWER, ALEX);
  await follow(VIEWER, BEA);
  await follow(VIEWER, CAL);
  await follow(VIEWER, WALL_OWNER);
});

describe('followingClimbAscents through the schema', () => {
  it('answers the shipped operation document without a GraphQL error', async () => {
    await insertTick({ comment: 'left heel on the start' });

    const { errors, answer } = await run(GET_FOLLOWING_CLIMB_ASCENTS, VIEWER, BOARD, CLIMB_UUID);

    expect(errors).toEqual([]);
    expect((answer as Answer).items).toHaveLength(1);
    expect((answer as Answer).items[0]).toMatchObject({ userId: ALEX, comment: 'left heel on the start' });
  });

  it('fills every scalar of the item type, the non-null ones included', async () => {
    await insertTick();

    // Generated from the schema, so a field added to the type is selected here
    // without anybody remembering to. `climbName` and `isNoMatch` are non-null
    // and used to be left out of the mapper, which nulled the whole answer for
    // any document that selected them.
    const itemType = schema.getType('FollowingAscentFeedItem') as GraphQLModule.GraphQLObjectType;
    const scalarFields = Object.values(itemType.getFields())
      .filter((field) => {
        let type = field.type;
        while (isNonNullType(type) || isListType(type)) type = type.ofType;
        return isLeafType(type);
      })
      .map((field) => field.name);
    expect(scalarFields).toEqual(expect.arrayContaining(['climbName', 'isNoMatch', 'effectiveQuality']));

    const document = `query Everything($input: FollowingClimbAscentsInput!) {
      followingClimbAscents(input: $input) { items { ${scalarFields.join(' ')} } }
    }`;
    const { errors, answer } = await run(document, VIEWER, BOARD, CLIMB_UUID);

    expect(errors).toEqual([]);
    const [item] = (answer as { items: Array<Record<string, unknown>> }).items;
    expect(item).toMatchObject({ climbName: CLIMB_NAME, isNoMatch: false, boardType: BOARD });
  });

  it('skips the counts for a document that does not select them', async () => {
    await insertTick();

    const document = `query ItemsOnly($input: FollowingClimbAscentsInput!) {
      followingClimbAscents(input: $input) { items { uuid } }
    }`;
    const { errors, answer } = await run(document, VIEWER, BOARD, CLIMB_UUID);

    expect(errors).toEqual([]);
    expect(answer).toEqual({ items: [{ uuid: expect.stringMatching(/^fca-tick-/) }] });
  });

  it('gives a direct caller the full summary', async () => {
    await insertTick();

    const answer = (await socialFeedQueries.followingClimbAscents(
      null,
      { input: { boardType: BOARD, climbUuid: CLIMB_UUID } },
      ctxFor(VIEWER),
    )) as Answer;

    expect(answer.hasMore).toBe(false);
    expect(answer.summary).toEqual({
      climberCount: 1,
      senderCount: 1,
      byAngle: [{ angle: 40, climberCount: 1, senderCount: 1 }],
    });
  });

  it('rejects an unauthenticated call', async () => {
    await insertTick();

    const { errors, answer } = await run(GET_FOLLOWING_CLIMB_ASCENTS, null, BOARD, CLIMB_UUID);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Authentication required/);
    expect(answer).toBeUndefined();
  });
});

describe('who counts as followed', () => {
  it('leaves out logs by climbers the viewer does not follow, from the rows and the counts', async () => {
    await insertTick({ userId: ALEX });
    await insertTick({ userId: UNFOLLOWED });

    const answer = await ask(VIEWER);

    expect(answer.items.map((item) => item.userId)).toEqual([ALEX]);
    expect(answer.summary).toEqual({
      climberCount: 1,
      senderCount: 1,
      byAngle: [{ angle: 40, climberCount: 1, senderCount: 1 }],
    });
  });

  it('gives a viewer who follows nobody the empty answer', async () => {
    await insertTick({ userId: ALEX });

    expect(await ask(LONER)).toEqual(EMPTY_ANSWER);
  });

  it('gives the empty answer for a climb nobody has logged', async () => {
    expect(await ask(VIEWER, BOARD, UNLOGGED_CLIMB_UUID)).toEqual(EMPTY_ANSWER);
  });

  it('does not match the same uuid under another board type', async () => {
    await insertTick({ userId: ALEX });

    expect(await ask(VIEWER, 'tension', CLIMB_UUID)).toEqual(EMPTY_ANSWER);
  });
});

describe('spray-wall privacy', () => {
  it('hides a log on a PRIVATE wall from a follower who cannot see the wall', async () => {
    const { climbUuid } = await seedWall({ isPublic: false });
    await insertOwnerLog(climbUuid);

    const answer = await ask(VIEWER, 'spray', climbUuid);

    // Not just "no rows": zero counts and no angle entry either. A count that
    // skipped the predicate would tell a stranger people log on this wall.
    expect(answer).toEqual(EMPTY_ANSWER);
    // And it is the SAME answer a climb nobody logged gives, so the wall's
    // existence cannot be read off the shape of the response.
    expect(answer).toEqual(await ask(VIEWER, BOARD, UNLOGGED_CLIMB_UUID));
    expect(JSON.stringify(answer)).not.toContain(SPRAY_NOTE);
  });

  it('hides a log on a wall an admin has hidden, even though the wall is public', async () => {
    const { wallUuid, climbUuid } = await seedWall({ isPublic: true });
    await insertOwnerLog(climbUuid);
    await db.execute(sql`UPDATE spray_walls SET hidden_at = now() WHERE board_uuid = ${wallUuid}`);

    expect(await ask(VIEWER, 'spray', climbUuid)).toEqual(EMPTY_ANSWER);
  });

  it('hides a log on a deleted wall, which keeps its climbs and ticks', async () => {
    const { wallUuid, climbUuid } = await seedWall({ isPublic: true });
    await insertOwnerLog(climbUuid);
    await db.execute(sql`UPDATE spray_walls SET deleted_at = now() WHERE board_uuid = ${wallUuid}`);

    expect(await ask(VIEWER, 'spray', climbUuid)).toEqual(EMPTY_ANSWER);
  });

  it('does not answer for the spray climb under another board type', async () => {
    const { climbUuid } = await seedWall({ isPublic: true });
    await insertOwnerLog(climbUuid);

    expect(await ask(VIEWER, BOARD, climbUuid)).toEqual(EMPTY_ANSWER);
  });

  it('shows the wall owner a log by somebody they follow', async () => {
    const { climbUuid } = await seedWall({ isPublic: false });
    await follow(WALL_OWNER, ALEX);
    await insertTick({ userId: ALEX, boardType: 'spray', climbUuid, comment: SPRAY_NOTE });

    const answer = await ask(WALL_OWNER, 'spray', climbUuid);

    expect(answer.items.map((item) => item.comment)).toEqual([SPRAY_NOTE]);
    expect(answer.summary).toEqual({
      climberCount: 1,
      senderCount: 1,
      byAngle: [{ angle: 40, climberCount: 1, senderCount: 1 }],
    });
  });

  it("shows a member of the wall's gym", async () => {
    const [gym] = (await db.execute(sql`
      INSERT INTO gyms (uuid, name, slug, owner_id, is_public, created_at, updated_at)
      VALUES ('fca-gym', 'Fca gym', 'fca-gym', ${WALL_OWNER}, true, now(), now())
      RETURNING id
    `)) as unknown as Array<{ id: number }>;
    const gymId = Number(gym.id);
    await db.execute(sql`INSERT INTO gym_members (gym_id, user_id, role) VALUES (${gymId}, ${VIEWER}, 'member')`);
    const { climbUuid } = await seedWall({ isPublic: false, gymId });
    await insertOwnerLog(climbUuid);

    const answer = await ask(VIEWER, 'spray', climbUuid);

    expect(answer.items.map((item) => item.comment)).toEqual([SPRAY_NOTE]);
    expect(answer.summary.climberCount).toBe(1);
  });

  it('shows anybody when the wall is public', async () => {
    const { climbUuid } = await seedWall({ isPublic: true });
    await insertOwnerLog(climbUuid);

    const answer = await ask(VIEWER, 'spray', climbUuid);

    expect(answer.items.map((item) => item.comment)).toEqual([SPRAY_NOTE]);
    expect(answer.summary.climberCount).toBe(1);
  });

  // A wall delete is soft and keeps its climbs, but `deleteDraftClimb` and
  // account deletion hard-delete a climb row and leave its ticks. Such a tick
  // has no wall left to check, and the reference predicate alone would pass it
  // for everybody, so the reader fails closed on spray.
  it('hides a spray tick whose climb row is missing, from the rows and the counts', async () => {
    await insertTick({ userId: ALEX, boardType: 'spray', climbUuid: 'fca-ghost-climb', comment: SPRAY_NOTE });

    expect(await ask(VIEWER, 'spray', 'fca-ghost-climb')).toEqual(EMPTY_ANSWER);
  });

  it('hides a log on a private wall once its climb row has been hard-deleted', async () => {
    const { climbUuid } = await seedWall({ isPublic: false });
    await insertOwnerLog(climbUuid);
    await db.execute(sql`DELETE FROM board_climbs WHERE uuid = ${climbUuid}`);

    expect(await ask(VIEWER, 'spray', climbUuid)).toEqual(EMPTY_ANSWER);
    // The owner too: with the climb gone there is no wall to tie the log to.
    await follow(WALL_OWNER, ALEX);
    await insertTick({ userId: ALEX, boardType: 'spray', climbUuid });
    expect(await ask(WALL_OWNER, 'spray', climbUuid)).toEqual(EMPTY_ANSWER);
  });

  // Only spray fails closed. An Aurora tick can arrive before its climb does.
  it('still returns a tick on another board whose climb row is missing, as an unknown climb', async () => {
    await insertTick({ userId: ALEX, climbUuid: 'fca-ghost-climb' });

    const document = `query Ghost($input: FollowingClimbAscentsInput!) {
      followingClimbAscents(input: $input) { items { climbName isNoMatch } }
    }`;
    const { errors, answer } = await run(document, VIEWER, BOARD, 'fca-ghost-climb');

    expect(errors).toEqual([]);
    expect(answer).toEqual({ items: [{ climbName: 'Unknown Climb', isNoMatch: false }] });
  });
});

describe('climbs that were deduplicated into this one', () => {
  /** A uuid the dedup retired: an alias row, and no `board_climbs` row of its own. */
  const RETIRED_UUID = 'fca-retired-climb';

  beforeEach(async () => {
    await db.insert(dbSchema.boardClimbAliases).values([
      { boardType: BOARD, aliasUuid: CLIMB_UUID, canonicalUuid: CLIMB_UUID, source: 'test' },
      { boardType: BOARD, aliasUuid: RETIRED_UUID, canonicalUuid: CLIMB_UUID, source: 'test' },
    ]);
  });

  it('includes a log stored under a retired uuid in the rows and the counts', async () => {
    await insertTick({ userId: ALEX, angle: 40 });
    await insertTick({ userId: BEA, climbUuid: RETIRED_UUID, angle: 40, climbedAt: '2026-05-02T18:00:00.000Z' });

    const answer = await ask(VIEWER);

    expect(answer.items.map((item) => item.userId)).toEqual([BEA, ALEX]);
    expect(answer.summary).toEqual({
      climberCount: 2,
      senderCount: 2,
      byAngle: [{ angle: 40, climberCount: 2, senderCount: 2 }],
    });
  });

  it('gives the same answer when asked with the retired uuid', async () => {
    await insertTick({ userId: ALEX });
    await insertTick({ userId: BEA, climbUuid: RETIRED_UUID, climbedAt: '2026-05-02T18:00:00.000Z' });

    expect(await ask(VIEWER, BOARD, RETIRED_UUID)).toEqual(await ask(VIEWER));
  });

  it('names a retired-uuid log after the climb it was merged into', async () => {
    await insertTick({ userId: BEA, climbUuid: RETIRED_UUID });

    const document = `query Merged($input: FollowingClimbAscentsInput!) {
      followingClimbAscents(input: $input) { items { climbUuid climbName } }
    }`;
    const { errors, answer } = await run(document, VIEWER, BOARD, CLIMB_UUID);

    expect(errors).toEqual([]);
    expect(answer).toEqual({ items: [{ climbUuid: RETIRED_UUID, climbName: CLIMB_NAME }] });
  });

  it('counts an Aurora twin pair stored under a retired uuid once', async () => {
    const twin = {
      userId: ALEX,
      climbUuid: RETIRED_UUID,
      origin: 'aurora_pull' as const,
      auroraType: 'ascents' as const,
      updatedAt: '2026-05-01T18:00:00.000Z',
      auroraSyncedAt: '2026-05-01T18:00:00.000Z',
    };
    await insertTick({ ...twin, auroraId: 'fca-alias-aur-2' });
    await insertTick({ ...twin, auroraId: 'fca-alias-aur-1' });

    const answer = await ask(VIEWER);

    expect(answer.items).toHaveLength(1);
    expect(answer.summary.climberCount).toBe(1);
  });

  it('does not follow an alias recorded for another board type', async () => {
    await db
      .insert(dbSchema.boardClimbAliases)
      .values({ boardType: 'tension', aliasUuid: 'fca-other-board-alias', canonicalUuid: CLIMB_UUID, source: 'test' });
    await insertTick({ userId: ALEX, climbUuid: 'fca-other-board-alias' });

    expect(await ask(VIEWER)).toEqual(EMPTY_ANSWER);
  });
});

describe("Aurora's own duplicate rows", () => {
  it('counts a twin pair as one log and one climber', async () => {
    const twin = {
      userId: ALEX,
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
    await insertTick({ ...twin, auroraId: 'fca-aur-2' });
    await insertTick({ ...twin, auroraId: 'fca-aur-1' });

    const answer = await ask(VIEWER);

    expect(answer.items).toHaveLength(1);
    expect(answer.summary).toEqual({
      climberCount: 1,
      senderCount: 1,
      byAngle: [{ angle: 40, climberCount: 1, senderCount: 1 }],
    });
  });
});

describe('effectiveQuality and difficulty', () => {
  const insertRating = (overrides: Partial<typeof dbSchema.boardClimbRatings.$inferInsert> = {}) =>
    db.insert(dbSchema.boardClimbRatings).values({
      boardType: BOARD,
      climbUuid: CLIMB_UUID,
      angle: 40,
      userId: ALEX,
      rating: 4,
      ...overrides,
    });

  it("falls back to the climber's synced rating when the send has no quality", async () => {
    await insertTick({ quality: null });
    await insertRating();

    const [item] = (await ask(VIEWER)).items;

    expect(item).toMatchObject({ quality: null, effectiveQuality: 4 });
  });

  it('ignores a rating the climber deleted upstream', async () => {
    await insertTick({ quality: null });
    await insertRating({ kilterDetachedAt: new Date() });

    const [item] = (await ask(VIEWER)).items;

    expect(item).toMatchObject({ quality: null, effectiveQuality: null });
  });

  it("keeps the send's own quality over the synced rating", async () => {
    await insertTick({ quality: 2 });
    await insertRating();

    const [item] = (await ask(VIEWER)).items;

    expect(item).toMatchObject({ quality: 2, effectiveQuality: 2 });
  });

  it('gives an attempt no stars, even at an angle the climber rated', async () => {
    await insertTick({ status: 'attempt', quality: null });
    await insertRating();

    const [item] = (await ask(VIEWER)).items;

    expect(item).toMatchObject({ status: 'attempt', effectiveQuality: null });
  });

  it('returns the personal grade id, and null when none was given', async () => {
    await insertTick({ userId: ALEX, difficulty: 22 });
    await insertTick({ userId: BEA, difficulty: null });

    const items = (await ask(VIEWER)).items;

    expect(items.find((item) => item.userId === ALEX)?.difficulty).toBe(22);
    expect(items.find((item) => item.userId === BEA)?.difficulty).toBeNull();
  });
});

describe('counts and the 100-row cap', () => {
  it('counts every climber even when one of them fills the list', async () => {
    // ALEX has the 101 NEWEST logs, all sends, so BEA and CAL fall off the
    // list entirely. They still have to be counted.
    const alexLogs = Array.from({ length: 101 }, (_, index) =>
      tickRow({
        userId: ALEX,
        climbedAt: new Date(Date.UTC(2026, 4, 2, 0, index)).toISOString(),
      }),
    );
    await db.insert(dbSchema.boardseshTicks).values(alexLogs);
    await insertTick({ userId: BEA, status: 'attempt', climbedAt: '2026-04-01T10:00:00.000Z' });
    await insertTick({ userId: CAL, status: 'flash', attemptCount: 1, climbedAt: '2026-04-01T11:00:00.000Z' });

    const answer = await ask(VIEWER);

    expect(answer.items).toHaveLength(100);
    expect(answer.hasMore).toBe(true);
    expect(new Set(answer.items.map((item) => item.userId))).toEqual(new Set([ALEX]));
    // 101 sends by one climber is one sender.
    expect(answer.summary).toEqual({
      climberCount: 3,
      senderCount: 2,
      byAngle: [{ angle: 40, climberCount: 3, senderCount: 2 }],
    });
  });

  it('reports exactly 100 logs as the whole list', async () => {
    const logs = Array.from({ length: 100 }, (_, index) =>
      tickRow({ climbedAt: new Date(Date.UTC(2026, 4, 2, 0, index)).toISOString() }),
    );
    await db.insert(dbSchema.boardseshTicks).values(logs);

    const answer = await ask(VIEWER);

    expect(answer.items).toHaveLength(100);
    expect(answer.hasMore).toBe(false);
  });

  it('splits the counts by angle, ascending, and counts a sender once overall', async () => {
    // ALEX: tried at 40, sent at 45. A climber at both, a sender only at 45.
    await insertTick({ userId: ALEX, angle: 40, status: 'attempt' });
    await insertTick({ userId: ALEX, angle: 45, status: 'send' });
    // BEA: sent at both. One sender overall, not two.
    await insertTick({ userId: BEA, angle: 45, status: 'send' });
    await insertTick({ userId: BEA, angle: 40, status: 'flash', attemptCount: 1 });
    // CAL: only ever tried.
    await insertTick({ userId: CAL, angle: 40, status: 'attempt' });

    const { summary } = await ask(VIEWER);

    expect(summary).toEqual({
      climberCount: 3,
      senderCount: 2,
      byAngle: [
        { angle: 40, climberCount: 3, senderCount: 1 },
        { angle: 45, climberCount: 2, senderCount: 2 },
      ],
    });
  });

  it('counts a mirrored send like any other', async () => {
    await insertTick({ userId: ALEX, isMirror: true });

    expect((await ask(VIEWER)).summary).toMatchObject({ climberCount: 1, senderCount: 1 });
  });
});

describe('ordering', () => {
  it('puts the newest log first', async () => {
    const older = await insertTick({ userId: ALEX, climbedAt: '2026-05-01T10:00:00.000Z' });
    const newer = await insertTick({ userId: BEA, climbedAt: '2026-05-03T10:00:00.000Z' });
    const middle = await insertTick({ userId: CAL, climbedAt: '2026-05-02T10:00:00.000Z' });

    expect((await ask(VIEWER)).items.map((item) => item.uuid)).toEqual([newer, middle, older]);
  });

  it('breaks a tie on the timestamp by id, newest row first', async () => {
    const climbedAt = '2026-05-01T10:00:00.000Z';
    const first = await insertTick({ userId: ALEX, climbedAt });
    const second = await insertTick({ userId: BEA, climbedAt });
    const third = await insertTick({ userId: CAL, climbedAt });

    expect((await ask(VIEWER)).items.map((item) => item.uuid)).toEqual([third, second, first]);
  });
});
