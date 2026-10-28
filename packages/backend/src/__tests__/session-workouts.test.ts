/**
 * Real-DB coverage for workout-aware sessions (#6903): who may write a
 * session's workout, the revision rule that makes outbox replays idempotent,
 * and what the two read queries derive from the owner's ticks for each viewer.
 * The spray wall half of the privacy rule is swept by
 * spray-visibility-sweep.test.ts, which seeds a workout on its private wall.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { and, eq, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { getGradeLabel } from '@boardsesh/db/queries';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import type { RecordSessionWorkoutInput } from '@boardsesh/shared-schema/generated';
import { db } from '../db/client';
import {
  MAX_SESSION_WORKOUT_HEADLINE_IDS,
  sessionWorkoutMutations,
  sessionWorkoutQueries,
} from '../graphql/resolvers/sessions/session-workouts';

vi.mock('../utils/redis-rate-limiter', () => ({
  checkRateLimitRedis: vi.fn().mockResolvedValue(undefined),
}));

const CLIMBER = 'workouts-climber';
const MEMBER = 'workouts-member';
const STRANGER = 'workouts-stranger';
const GYM_OWNER = 'workouts-gym-owner';
const CLIMBER_NAME = 'Workout Climber';

const WARM_CLIMB = 'workouts-climb-warm';
const CLIMB_A = 'workouts-climb-a';
const CLIMB_B = 'workouts-climb-b';
const OFF_PLAN_CLIMB = 'workouts-climb-off';
/** The climber's own unpublished draft. */
const DRAFT_CLIMB = 'workouts-climb-draft';
/** Somebody else's published climb kept out of lists. */
const UNLISTED_CLIMB = 'workouts-climb-unlisted';
const TARGET_GRADE = 20;

let boardId: number;

const viewer = (userId: string | null): ConnectionContext =>
  ({
    connectionId: `workouts-${userId ?? 'anon'}-${randomUUID()}`,
    isAuthenticated: !!userId,
    userId,
  }) as ConnectionContext;

const at = (minute: number): string => `2026-10-20 10:${String(minute).padStart(2, '0')}:00`;

/** The workout in the tests: a warm-up, then a 4x4 of two climbs at 4 reps. */
const workoutInput = (sessionId: string, revision: number, ticks: RecordSessionWorkoutInput['ticks'] = []) => ({
  sessionId,
  revision,
  stages: [
    {
      id: 'stage-warm',
      kind: 'warmUp',
      items: [{ queueItemUuid: 'qi-warm', climbUuid: WARM_CLIMB, angle: 40 }],
    },
    {
      id: 'stage-4x4',
      kind: 'fourByFour',
      targetGrade: TARGET_GRADE,
      pacing: { mode: 'afterTick', restSeconds: 60, advanceOn: 'set', repsPerSet: 4, restBetweenSetsSeconds: 240 },
      items: [
        { queueItemUuid: 'qi-a', climbUuid: CLIMB_A, angle: 40 },
        { queueItemUuid: 'qi-b', climbUuid: CLIMB_B, angle: 40 },
      ],
    },
  ],
  ticks,
});

async function hostSession(): Promise<string> {
  const sessionId = `workouts-${randomUUID()}`;
  await db.insert(dbSchema.boardSessions).values({
    id: sessionId,
    boardPath: 'kilter/1/10/1/40',
    createdByUserId: CLIMBER,
    boardId,
    isPublic: true,
    status: 'active',
    startedAt: new Date('2026-10-20T10:00:00Z'),
  });
  return sessionId;
}

async function logTick(
  sessionId: string,
  climbUuid: string,
  status: 'flash' | 'send' | 'attempt',
  minute: number,
  userId = CLIMBER,
): Promise<string> {
  const uuid = `workouts-tick-${randomUUID()}`;
  await db.insert(dbSchema.boardseshTicks).values({
    uuid,
    userId,
    climbUuid,
    boardType: 'kilter',
    angle: 40,
    status,
    attemptCount: 1,
    difficulty: status === 'attempt' ? null : TARGET_GRADE,
    climbedAt: at(minute),
    boardId,
    sessionId,
  });
  return uuid;
}

const storedRow = async (sessionId: string, userId = CLIMBER) =>
  (
    await db
      .select()
      .from(dbSchema.sessionWorkouts)
      .where(and(eq(dbSchema.sessionWorkouts.sessionId, sessionId), eq(dbSchema.sessionWorkouts.userId, userId)))
  )[0];

const record = (input: RecordSessionWorkoutInput, userId: string | null = CLIMBER) =>
  sessionWorkoutMutations.recordSessionWorkout(null, { input }, viewer(userId));

beforeAll(async () => {
  await db
    .insert(dbSchema.users)
    .values([CLIMBER, MEMBER, STRANGER, GYM_OWNER].map((id) => ({ id, email: `${id}@test.com`, name: id })));
  await db.insert(dbSchema.userProfiles).values([{ userId: CLIMBER, displayName: CLIMBER_NAME }]);
  await db.insert(dbSchema.boardClimbs).values([
    {
      uuid: DRAFT_CLIMB,
      boardType: 'kilter',
      layoutId: 1,
      userId: CLIMBER,
      name: 'Secret draft',
      isListed: true,
      isDraft: true,
      frames: 'p1r12-draft',
    },
    {
      uuid: UNLISTED_CLIMB,
      boardType: 'kilter',
      layoutId: 1,
      userId: GYM_OWNER,
      name: 'Unlisted climb',
      isListed: false,
      isDraft: false,
      frames: 'p1r12-unlisted',
    },
  ]);
  await db.insert(dbSchema.boardClimbs).values(
    [WARM_CLIMB, CLIMB_A, CLIMB_B, OFF_PLAN_CLIMB].map((uuid) => ({
      uuid,
      boardType: 'kilter',
      layoutId: 1,
      name: `Name of ${uuid}`,
      isListed: true,
      isDraft: false,
      frames: `p1r12-${uuid}`,
    })),
  );
  const [board] = await db
    .insert(dbSchema.userBoards)
    .values({
      uuid: randomUUID(),
      slug: `workouts-${randomUUID()}`,
      ownerId: GYM_OWNER,
      name: 'Workout wall',
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1',
      isPublic: true,
    })
    .returning({ id: dbSchema.userBoards.id });
  boardId = Number(board.id);
});

beforeEach(async () => {
  await db
    .update(dbSchema.userProfiles)
    .set({ anonymousOnForeignBoards: false, isPrivate: false })
    .where(eq(dbSchema.userProfiles.userId, CLIMBER));
  await db.delete(dbSchema.userFollows).where(eq(dbSchema.userFollows.followingId, CLIMBER));
});

afterEach(async () => {
  await db.execute(sql`DELETE FROM content_privacy WHERE owner_id = ${CLIMBER}`);
  await db.execute(sql`DELETE FROM resource_privacy WHERE owner_id = ${CLIMBER}`);
});

describe('recordSessionWorkout', () => {
  it('needs a signed-in caller', async () => {
    const sessionId = await hostSession();
    await expect(record(workoutInput(sessionId, 1), null)).rejects.toThrow('Authentication required');
  });

  it('refuses an unknown session as bad input, so the outbox gives up on it', async () => {
    await expect(record(workoutInput('workouts-no-such-session', 1))).rejects.toMatchObject({
      message: 'Session not found',
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });

  it('refuses a climber who never joined the session', async () => {
    const sessionId = await hostSession();
    await expect(record(workoutInput(sessionId, 1), STRANGER)).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    });
    expect(await storedRow(sessionId, STRANGER)).toBeUndefined();
  });

  it('lets a crew member who joined write their own row beside the host', async () => {
    const sessionId = await hostSession();
    await db.insert(dbSchema.boardSessionParticipants).values({ sessionId, userId: MEMBER });
    await expect(record(workoutInput(sessionId, 1))).resolves.toBe(true);
    await expect(record(workoutInput(sessionId, 5), MEMBER)).resolves.toBe(true);
    expect((await storedRow(sessionId))?.revision).toBe(1);
    expect((await storedRow(sessionId, MEMBER))?.revision).toBe(5);
  });

  it('refuses a climber whose only link to the session is a tick logged into it', async () => {
    // saveTick takes any existing session id, so a tick proves nothing.
    const sessionId = await hostSession();
    await logTick(sessionId, CLIMB_A, 'send', 1, STRANGER);
    await expect(record(workoutInput(sessionId, 1), STRANGER)).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    });
    expect(await storedRow(sessionId, STRANGER)).toBeUndefined();
  });

  it('never lets one climber overwrite another climber’s row', async () => {
    const sessionId = await hostSession();
    await db.insert(dbSchema.boardSessionParticipants).values({ sessionId, userId: MEMBER });
    await record(workoutInput(sessionId, 1));
    const before = await storedRow(sessionId);
    await record({ ...workoutInput(sessionId, 99), stages: [] }, MEMBER);
    expect(await storedRow(sessionId)).toEqual(before);
    expect((await storedRow(sessionId, MEMBER))?.revision).toBe(99);
  });

  it('keeps only tick-map entries that are the caller’s own ticks in the session', async () => {
    const sessionId = await hostSession();
    const otherSession = await hostSession();
    const own = await logTick(sessionId, CLIMB_A, 'send', 1);
    const someoneElses = await logTick(sessionId, CLIMB_A, 'send', 2, MEMBER);
    const ownElsewhere = await logTick(otherSession, CLIMB_A, 'send', 3);
    await record(
      workoutInput(sessionId, 1, [
        { tickUuid: own, queueItemUuid: 'qi-a' },
        { tickUuid: someoneElses, queueItemUuid: 'qi-a' },
        { tickUuid: ownElsewhere, queueItemUuid: 'qi-a' },
        { tickUuid: 'no-such-tick', queueItemUuid: 'qi-a' },
      ]),
    );
    expect((await storedRow(sessionId))?.tickMap).toEqual([{ tickUuid: own, queueItemUuid: 'qi-a' }]);
  });

  it('writes only a higher revision; a replay is a no-op that still answers true', async () => {
    const sessionId = await hostSession();
    const tick = await logTick(sessionId, CLIMB_A, 'send', 1);
    await record(workoutInput(sessionId, 2, [{ tickUuid: tick, queueItemUuid: 'qi-a' }]));
    const first = await storedRow(sessionId);

    const replay = { ...workoutInput(sessionId, 2), stages: [] };
    await expect(record(replay)).resolves.toBe(true);
    await expect(record({ ...replay, revision: 1 })).resolves.toBe(true);
    const unchanged = await storedRow(sessionId);
    expect(unchanged?.plan).toEqual(first?.plan);
    expect(unchanged?.tickMap).toEqual([{ tickUuid: tick, queueItemUuid: 'qi-a' }]);
    expect(unchanged?.revision).toBe(2);

    await expect(record({ ...replay, revision: 3 })).resolves.toBe(true);
    const updated = await storedRow(sessionId);
    expect(updated?.revision).toBe(3);
    expect(updated?.plan).toEqual({ version: 1, stages: [] });
    expect(updated?.tickMap).toEqual([]);
  });

  it('rejects a malformed plan', async () => {
    const sessionId = await hostSession();
    const input = workoutInput(sessionId, 1);
    input.stages[1].items.push({ queueItemUuid: 'qi-a', climbUuid: CLIMB_B, angle: 40 });
    await expect(record(input)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    await expect(record({ ...workoutInput(sessionId, 1), revision: -1 })).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
    const badKind = workoutInput(sessionId, 1);
    badKind.stages[0].kind = 'warm-up<script>';
    await expect(record(badKind)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });
});

describe('sessionWorkouts', () => {
  /** The 4x4 session every read test starts from. Returns the session and the tick uuids by name. */
  async function playedSession() {
    const sessionId = await hostSession();
    const ticks = {
      warm: await logTick(sessionId, WARM_CLIMB, 'send', 1),
      a1: await logTick(sessionId, CLIMB_A, 'flash', 2),
      a2: await logTick(sessionId, CLIMB_A, 'send', 3),
      a3: await logTick(sessionId, CLIMB_A, 'attempt', 4),
      a4: await logTick(sessionId, CLIMB_A, 'send', 5),
      b1: await logTick(sessionId, CLIMB_B, 'attempt', 6),
      off: await logTick(sessionId, OFF_PLAN_CLIMB, 'send', 7),
      // Another climber's tick on the same climb never counts for this workout.
      member: await logTick(sessionId, CLIMB_A, 'send', 8, MEMBER),
    };
    await record(workoutInput(sessionId, 1, [{ tickUuid: ticks.b1, queueItemUuid: 'qi-b' }]));
    return { sessionId, ticks };
  }

  it('derives every block from the owner’s ticks, with climb names and grades', async () => {
    const { sessionId, ticks } = await playedSession();
    const [workout] = await sessionWorkoutQueries.sessionWorkouts(null, { sessionId }, viewer(STRANGER));

    expect(workout).toMatchObject({ userId: CLIMBER, displayName: CLIMBER_NAME, offPlan: 1 });
    const [warm, fourByFour] = workout.stages;
    expect(warm).toMatchObject({
      kind: 'warmUp',
      isCoolDown: false,
      tally: { sent: 1, attempts: 0, skipped: 0, climbs: 1 },
    });
    expect(fourByFour).toMatchObject({
      kind: 'fourByFour',
      targetGrade: getGradeLabel(TARGET_GRADE, 'kilter'),
      repsPerSet: 4,
      sets: 2,
      restSeconds: 60,
      intervalSeconds: null,
      tally: { sent: 3, attempts: 2, skipped: 0, climbs: 2 },
    });
    expect(fourByFour.climbs[0]).toMatchObject({
      climbUuid: CLIMB_A,
      name: `Name of ${CLIMB_A}`,
      grade: getGradeLabel(TARGET_GRADE, 'kilter'),
      boardType: 'kilter',
      layoutId: 1,
      frames: `p1r12-${CLIMB_A}`,
      reps: ['FLASH', 'SEND', 'ATTEMPT', 'SEND'],
      skipped: false,
    });
    expect(fourByFour.climbs[0].renderBoard).toMatchObject({ layoutId: 1, sizeId: 10, setIds: [1] });
    expect(fourByFour.climbs[1]).toMatchObject({ climbUuid: CLIMB_B, reps: ['ATTEMPT'], skipped: false });
    // The ticks behind each climb's reps, in rep order, and the owner's off-plan ticks.
    expect(warm.climbs[0].tickUuids).toEqual([ticks.warm]);
    expect(fourByFour.climbs[0].tickUuids).toEqual([ticks.a1, ticks.a2, ticks.a3, ticks.a4]);
    expect(fourByFour.climbs[1].tickUuids).toEqual([ticks.b1]);
    expect(workout.offPlanTickUuids).toEqual([ticks.off]);
    expect(JSON.stringify(workout)).not.toContain(ticks.member);
  });

  it('shows a climb with no tick as skipped', async () => {
    const sessionId = await hostSession();
    await logTick(sessionId, CLIMB_A, 'send', 1);
    await record(workoutInput(sessionId, 1));
    const [workout] = await sessionWorkoutQueries.sessionWorkouts(null, { sessionId }, viewer(CLIMBER));
    expect(workout.stages[0].climbs[0]).toMatchObject({ climbUuid: WARM_CLIMB, reps: [], skipped: true });
    expect(workout.stages[1].tally).toEqual({ sent: 1, attempts: 0, skipped: 1, climbs: 2 });
  });

  it('leaves out a climb holding a tick the viewer may not read, reps and all', async () => {
    const { sessionId, ticks } = await playedSession();
    await db.execute(sql`
      INSERT INTO content_privacy (entity_type, entity_id, owner_id, audience)
      VALUES ('tick', ${ticks.a3}, ${CLIMBER}, 'only_me')
    `);

    const [forStranger] = await sessionWorkoutQueries.sessionWorkouts(null, { sessionId }, viewer(STRANGER));
    expect(forStranger.stages[1].climbs.map((climb) => climb.climbUuid)).toEqual([CLIMB_B]);
    expect(forStranger.stages[1].tally).toEqual({ sent: 0, attempts: 1, skipped: 0, climbs: 1 });
    expect(forStranger.stages[1].sets).toBe(1);

    const [forOwner] = await sessionWorkoutQueries.sessionWorkouts(null, { sessionId }, viewer(CLIMBER));
    expect(forOwner.stages[1].climbs.map((climb) => climb.climbUuid)).toEqual([CLIMB_A, CLIMB_B]);
    expect(forOwner.stages[1].climbs[0].tickUuids).toContain(ticks.a3);
  });

  it('never hands a viewer the uuid of a tick they may not see', async () => {
    const { sessionId, ticks } = await playedSession();
    for (const hidden of [ticks.a3, ticks.off]) {
      await db.execute(sql`
        INSERT INTO content_privacy (entity_type, entity_id, owner_id, audience)
        VALUES ('tick', ${hidden}, ${CLIMBER}, 'only_me')
      `);
    }

    const [forStranger] = await sessionWorkoutQueries.sessionWorkouts(null, { sessionId }, viewer(STRANGER));
    const shown = JSON.stringify(forStranger);
    // Climb A goes whole, so its visible reps' uuids go with it.
    for (const absent of [ticks.a1, ticks.a2, ticks.a3, ticks.a4, ticks.off]) expect(shown).not.toContain(absent);
    expect(forStranger.offPlan).toBe(0);
    expect(forStranger.offPlanTickUuids).toEqual([]);
    expect(forStranger.stages[1].climbs[0].tickUuids).toEqual([ticks.b1]);

    const [forOwner] = await sessionWorkoutQueries.sessionWorkouts(null, { sessionId }, viewer(CLIMBER));
    expect(forOwner.offPlanTickUuids).toEqual([ticks.off]);
    expect(forOwner.stages[1].climbs[0].tickUuids).toEqual([ticks.a1, ticks.a2, ticks.a3, ticks.a4]);
  });

  it('answers nothing for a session the viewer may not open', async () => {
    const { sessionId } = await playedSession();
    await db.insert(dbSchema.resourcePrivacy).values({
      kind: 'session',
      resourceId: sessionId,
      ownerId: CLIMBER,
      audience: 'only_me',
    });
    await expect(sessionWorkoutQueries.sessionWorkouts(null, { sessionId }, viewer(STRANGER))).resolves.toEqual([]);
    await expect(sessionWorkoutQueries.sessionWorkouts(null, { sessionId }, viewer(null))).resolves.toEqual([]);
    await expect(sessionWorkoutQueries.sessionWorkouts(null, { sessionId }, viewer(CLIMBER))).resolves.toHaveLength(1);
  });

  it('leaves out a skipped draft or unlisted climb for everyone but whoever may list it', async () => {
    const sessionId = await hostSession();
    await logTick(sessionId, CLIMB_A, 'send', 1);
    const input = workoutInput(sessionId, 1);
    input.stages[0].items.push(
      { queueItemUuid: 'qi-draft', climbUuid: DRAFT_CLIMB, angle: 40 },
      { queueItemUuid: 'qi-unlisted', climbUuid: UNLISTED_CLIMB, angle: 40 },
    );
    await record(input);

    const [forStranger] = await sessionWorkoutQueries.sessionWorkouts(null, { sessionId }, viewer(STRANGER));
    expect(forStranger.stages[0].climbs.map((climb) => climb.climbUuid)).toEqual([WARM_CLIMB]);
    expect(JSON.stringify(forStranger)).not.toContain('Secret draft');

    const [forOwner] = await sessionWorkoutQueries.sessionWorkouts(null, { sessionId }, viewer(CLIMBER));
    expect(forOwner.stages[0].climbs.map((climb) => climb.climbUuid)).toEqual([WARM_CLIMB, DRAFT_CLIMB]);
    expect(forOwner.stages[0].climbs[1]).toMatchObject({ name: 'Secret draft', skipped: true });
  });

  /** What each viewer gets from both readers for one session. */
  async function shownTo(sessionId: string, userId: string | null) {
    const workouts = await sessionWorkoutQueries.sessionWorkouts(null, { sessionId }, viewer(userId));
    const headlines = await sessionWorkoutQueries.sessionWorkoutHeadlines(
      null,
      { sessionIds: [sessionId] },
      viewer(userId),
    );
    return { workouts: workouts.map((workout) => workout.userId), headlines: headlines.map((line) => line.userId) };
  }

  it('hides a private account’s workout from a stranger, as sessionDetail hides its climber', async () => {
    const { sessionId } = await playedSession();
    await db.update(dbSchema.userProfiles).set({ isPrivate: true }).where(eq(dbSchema.userProfiles.userId, CLIMBER));
    expect(await shownTo(sessionId, STRANGER)).toEqual({ workouts: [], headlines: [] });
    expect(await shownTo(sessionId, null)).toEqual({ workouts: [], headlines: [] });
    expect(await shownTo(sessionId, CLIMBER)).toEqual({ workouts: [CLIMBER], headlines: [CLIMBER] });

    // An approved follower sees it; so does a fellow member of the session.
    await db.insert(dbSchema.userFollows).values({ followerId: STRANGER, followingId: CLIMBER });
    expect(await shownTo(sessionId, STRANGER)).toEqual({ workouts: [CLIMBER], headlines: [CLIMBER] });
    // Joined before the climber's ticks: a member sees what was logged while they were in it.
    await db
      .insert(dbSchema.boardSessionParticipants)
      .values({ sessionId, userId: MEMBER, joinedAt: new Date('2026-10-20T09:55:00Z') });
    expect(await shownTo(sessionId, MEMBER)).toEqual({ workouts: [CLIMBER], headlines: [CLIMBER] });
  });

  it('hides the workout of a climber who stays anonymous on boards they don’t own', async () => {
    const { sessionId } = await playedSession();
    await db
      .update(dbSchema.userProfiles)
      .set({ anonymousOnForeignBoards: true })
      .where(eq(dbSchema.userProfiles.userId, CLIMBER));
    expect(await shownTo(sessionId, STRANGER)).toEqual({ workouts: [], headlines: [] });
    expect(await shownTo(sessionId, CLIMBER)).toEqual({ workouts: [CLIMBER], headlines: [CLIMBER] });
  });

  it('hides a workout none of whose ticks the viewer may see', async () => {
    const { sessionId, ticks } = await playedSession();
    for (const tickUuid of Object.values(ticks)) {
      await db.execute(sql`
        INSERT INTO content_privacy (entity_type, entity_id, owner_id, audience)
        VALUES ('tick', ${tickUuid}, ${CLIMBER}, 'only_me')
      `);
    }
    expect(await shownTo(sessionId, STRANGER)).toEqual({ workouts: [], headlines: [] });
    expect(await shownTo(sessionId, CLIMBER)).toEqual({ workouts: [CLIMBER], headlines: [CLIMBER] });

    // With no tick at all yet, the same: sessionDetail has nothing to show either.
    const empty = await hostSession();
    await record(workoutInput(empty, 1));
    expect(await shownTo(empty, STRANGER)).toEqual({ workouts: [], headlines: [] });
  });
});

describe('sessionWorkoutHeadlines', () => {
  it('answers one line per workout for the sessions the viewer may open, in request order', async () => {
    const open = await hostSession();
    const closed = await hostSession();
    const plain = await hostSession();
    for (const sessionId of [open, closed, plain]) await logTick(sessionId, CLIMB_A, 'send', 1);
    await record(workoutInput(open, 1));
    await record(workoutInput(closed, 1));
    await db.insert(dbSchema.resourcePrivacy).values({
      kind: 'session',
      resourceId: closed,
      ownerId: CLIMBER,
      audience: 'only_me',
    });

    const headlines = await sessionWorkoutQueries.sessionWorkoutHeadlines(
      null,
      { sessionIds: [plain, closed, open, `daily:${CLIMBER}:2026-10-27`] },
      viewer(STRANGER),
    );
    expect(headlines).toEqual([
      {
        sessionId: open,
        userId: CLIMBER,
        mainKind: 'fourByFour',
        mainTargetGrade: getGradeLabel(TARGET_GRADE, 'kilter'),
        secondMainKind: null,
        blockCount: 2,
        extraMainBlocks: 0,
      },
    ]);
  });

  it(`refuses more than ${MAX_SESSION_WORKOUT_HEADLINE_IDS} sessions`, async () => {
    const sessionIds = Array.from({ length: MAX_SESSION_WORKOUT_HEADLINE_IDS + 1 }, (_, index) => `s-${index}`);
    await expect(
      sessionWorkoutQueries.sessionWorkoutHeadlines(null, { sessionIds }, viewer(STRANGER)),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });
});
