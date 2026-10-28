import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { deriveWorkoutStages, type SessionWorkoutPlan, type SessionWorkoutTick } from '@boardsesh/workout-summary';
import type { SessionSummary } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import * as schema from '@boardsesh/db/schema';
import { autoSyncSessionToIntegrations, buildSessionActivity } from '../integrations/export-service';
import * as exportWorkout from '../integrations/export-workout';
import { buildExportWorkout, englishSessionT } from '../integrations/export-workout';

const { uploadSessionActivity } = vi.hoisted(() => ({ uploadSessionActivity: vi.fn() }));
vi.mock('../integrations/credentials', () => ({
  getFreshAccessToken: vi.fn(async (credential: { userId: string }) => `token:${credential.userId}`),
  recordSyncSuccess: vi.fn(async () => undefined),
}));
// The real loader, wrapped so one test can make it throw.
vi.mock('../integrations/export-workout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../integrations/export-workout')>();
  return { ...actual, loadExportWorkout: vi.fn(actual.loadExportWorkout) };
});
vi.mock('../integrations/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../integrations/registry')>()),
  getProvider: () => ({
    provider: 'strava',
    uploadSessionActivity,
    activityUrl: (externalId: string) => `https://www.strava.com/activities/${externalId}`,
  }),
}));

const V3 = 16;
const V4 = 18;

/** Warm-up of 4, a 4x4 at V4 (4 reps × 4 sets), and a 3-climb cool-down. */
function workoutPlan(climbs: { warmUp: string[]; fourByFour: string[]; coolDown: string[] }): SessionWorkoutPlan {
  const items = (uuids: string[], prefix: string) =>
    uuids.map((climbUuid, index) => ({ queueItemUuid: `${prefix}-${index}`, climbUuid, angle: 40 }));
  return {
    version: 1,
    stages: [
      { id: 'warm', kind: 'warmUp', targetGrade: V3, items: items(climbs.warmUp, 'w') },
      {
        id: 'main',
        kind: 'fourByFour',
        targetGrade: V4,
        pacing: { mode: 'afterTick', restSeconds: 60, repsPerSet: 4, restBetweenSetsSeconds: 240 },
        items: items(climbs.fourByFour, 'f'),
      },
      { id: 'cool', kind: 'warmUp', coolDown: true, items: items(climbs.coolDown, 'c') },
    ],
  };
}

const minute = (offset: number) => new Date(Date.UTC(2026, 5, 1, 10, offset)).toISOString();

/** Every warm-up sent, 9 of 16 4x4 reps sent (7 attempts), 2 of 3 cool-down climbs sent. */
function workoutTicks(climbs: { warmUp: string[]; fourByFour: string[]; coolDown: string[] }): SessionWorkoutTick[] {
  const ticks: SessionWorkoutTick[] = [];
  const add = (climbUuid: string, status: SessionWorkoutTick['status']) =>
    ticks.push({ uuid: uuidv4(), climbUuid, angle: 40, status, climbedAt: minute(ticks.length) });
  for (const climbUuid of climbs.warmUp) add(climbUuid, 'send');
  const fourByFourReps: SessionWorkoutTick['status'][][] = [
    ['flash', 'send', 'send', 'attempt'],
    ['send', 'send', 'attempt', 'attempt'],
    ['send', 'attempt', 'attempt', 'send'],
    ['attempt', 'send', 'send', 'attempt'],
  ];
  climbs.fourByFour.forEach((climbUuid, index) => fourByFourReps[index].forEach((rep) => add(climbUuid, rep)));
  add(climbs.coolDown[0], 'send');
  add(climbs.coolDown[1], 'send');
  return ticks;
}

const fixedClimbs = {
  warmUp: ['w1', 'w2', 'w3', 'w4'],
  fourByFour: ['f1', 'f2', 'f3', 'f4'],
  coolDown: ['c1', 'c2', 'c3'],
};

const vGrade = (difficulty: number) => ({ [V3]: 'V3', [V4]: 'V4' })[difficulty] ?? null;

describe('englishSessionT', () => {
  it('reads the en-US session catalog with plurals and values', () => {
    expect(englishSessionT('mobile.session.preGeneratorFourByFour')).toBe('4x4');
    expect(englishSessionT('workout.blockNameAtGrade', { name: '4x4', grade: 'V4' })).toBe('4x4 at V4');
    expect(englishSessionT('workout.blockCount', { count: 1 })).toBe('1 block');
    expect(englishSessionT('workout.blockCount', { count: 3 })).toBe('3 blocks');
  });
});

describe('buildExportWorkout', () => {
  it('names the main block and lists every block with what it came to', () => {
    const derived = deriveWorkoutStages(workoutPlan(fixedClimbs), [], workoutTicks(fixedClimbs));

    expect(buildExportWorkout(derived, vGrade)).toEqual({
      title: '4x4 at V4',
      line: 'Workout: Warm-up 4/4 · 4x4 V4 9/16 reps · Cool-down 2/3',
    });
  });

  it('names two main blocks "A + B"', () => {
    const plan: SessionWorkoutPlan = {
      version: 1,
      stages: [
        {
          id: 'a',
          kind: 'fourByFour',
          targetGrade: V4,
          pacing: { mode: 'afterTick', restSeconds: 60, repsPerSet: 4 },
          items: [{ queueItemUuid: 'f', climbUuid: 'f1', angle: 40 }],
        },
        { id: 'b', kind: 'pyramid', items: [{ queueItemUuid: 'p', climbUuid: 'p1', angle: 40 }] },
      ],
    };
    const workout = buildExportWorkout(deriveWorkoutStages(plan, [], []), vGrade);
    expect(workout?.title).toBe('4x4 at V4 + Pyramid');
    expect(workout?.line).toBe('Workout: 4x4 V4 0/4 reps · Pyramid 0/1');
  });

  it('is null for a plan with no blocks', () => {
    expect(buildExportWorkout(deriveWorkoutStages({ version: 1, stages: [] }, [], []), vGrade)).toBeNull();
  });
});

describe('buildSessionActivity with a workout', () => {
  const summary: SessionSummary = {
    sessionId: 'session-1',
    totalSends: 15,
    totalFlashes: 1,
    totalAttempts: 7,
    gradeDistribution: [],
    hardestClimb: null,
    participants: [],
    startedAt: '2026-06-01T10:00:00.000Z',
    endedAt: '2026-06-01T11:00:00.000Z',
    durationMinutes: 60,
  } as unknown as SessionSummary;
  const participant = { userId: 'user-1', sends: 13, flashes: 1, attempts: 7 };

  it('titles the activity with the main block and leads the description with the workout', () => {
    const activity = buildSessionActivity(summary, 'kilter/1/10/1/40', participant, null, {
      title: '4x4 at V4',
      line: 'Workout: Warm-up 4/4 · 4x4 V4 9/16 reps · Cool-down 2/3',
    });
    expect(activity.name).toBe('4x4 at V4 — 13 sends');
    expect(activity.description.split('\n')).toEqual([
      'Workout: Warm-up 4/4 · 4x4 V4 9/16 reps · Cool-down 2/3',
      '13 sends / 7 attempts',
      'Logged with Boardsesh',
    ]);
  });

  it("keeps today's text without a workout", () => {
    const activity = buildSessionActivity(summary, 'kilter/1/10/1/40', participant, null, null);
    expect(activity.name).toBe('Kilter Board session — 13 sends');
    expect(activity.description.split('\n')).toEqual(['13 sends / 7 attempts', 'Logged with Boardsesh']);
  });
});

// --- Against the database: the auto-sync path reads the stored workout. ---

const fixtureUsers: string[] = [];
const fixtureClimbs: string[] = [];
afterEach(async () => {
  if (fixtureUsers.length) await db.delete(schema.users).where(inArray(schema.users.id, fixtureUsers.splice(0)));
  if (fixtureClimbs.length)
    await db.delete(schema.boardClimbs).where(inArray(schema.boardClimbs.uuid, fixtureClimbs.splice(0)));
  vi.clearAllMocks();
});

async function createClimber(): Promise<string> {
  const userId = uuidv4();
  fixtureUsers.push(userId);
  await db.insert(schema.users).values({ id: userId, name: 'Workout climber', email: `${userId}@test.com` });
  await db.insert(schema.userProfiles).values({ userId, isPrivate: false });
  await db.insert(schema.integrationCredentials).values({ userId, provider: 'strava', autoSyncEnabled: true });
  return userId;
}

async function createSession(ownerId: string): Promise<string> {
  const sessionId = uuidv4();
  await db.insert(schema.boardSessions).values({
    id: sessionId,
    createdByUserId: ownerId,
    boardPath: '/kilter/1/10/1,20/40',
    isPublic: true,
    status: 'ended',
    startedAt: new Date('2026-06-01T10:00:00Z'),
    endedAt: new Date('2026-06-01T11:00:00Z'),
  });
  await db
    .insert(schema.resourcePrivacy)
    .values({ kind: 'session', resourceId: sessionId, ownerId, audience: 'public' });
  return sessionId;
}

async function createClimbs(count: number): Promise<string[]> {
  const uuids = Array.from({ length: count }, () => uuidv4());
  fixtureClimbs.push(...uuids);
  await db.insert(schema.boardClimbs).values(
    uuids.map((uuid, index) => ({
      boardType: 'kilter',
      uuid,
      layoutId: 1,
      setterUsername: 'Catalog setter',
      name: `Workout climb ${index}`,
      frames: 'p1r1',
      framesCount: 1,
      isDraft: false,
      isListed: true,
      edgeLeft: 0,
      edgeRight: 100,
      edgeBottom: 0,
      edgeTop: 150,
    })),
  );
  return uuids;
}

async function logTicks(userId: string, sessionId: string, ticks: SessionWorkoutTick[]): Promise<void> {
  await db.insert(schema.boardseshTicks).values(
    ticks.map((tick) => ({
      uuid: tick.uuid,
      userId,
      sessionId,
      boardType: 'kilter',
      climbUuid: tick.climbUuid,
      angle: tick.angle,
      status: tick.status,
      attemptCount: 1,
      climbedAt: String(tick.climbedAt),
    })),
  );
}

describe('automatic Strava export of a workout session', () => {
  async function workoutSession() {
    const [w1, w2, w3, w4, f1, f2, f3, f4, c1, c2, c3] = await createClimbs(11);
    const climbs = { warmUp: [w1, w2, w3, w4], fourByFour: [f1, f2, f3, f4], coolDown: [c1, c2, c3] };
    const ownerId = await createClimber();
    const sessionId = await createSession(ownerId);
    return { climbs, ownerId, sessionId };
  }

  it("names the owner's activity after their workout", async () => {
    const { climbs, ownerId, sessionId } = await workoutSession();
    await logTicks(ownerId, sessionId, workoutTicks(climbs));
    await db.insert(schema.sessionWorkouts).values({
      sessionId,
      userId: ownerId,
      plan: workoutPlan(climbs),
      tickMap: [],
      revision: 1,
    });
    uploadSessionActivity.mockResolvedValue({ externalActivityId: 'workout-export' });

    await autoSyncSessionToIntegrations(sessionId, 'kilter/1');

    expect(uploadSessionActivity).toHaveBeenCalledTimes(1);
    const [, activity] = uploadSessionActivity.mock.calls[0];
    expect(activity.name).toBe('4x4 at V4 — 15 sends');
    expect(activity.description.split('\n')[0]).toBe('Workout: Warm-up 4/4 · 4x4 V4 9/16 reps · Cool-down 2/3');
  });

  it("tallies a crewmate's own ticks against the creator's workout", async () => {
    const { climbs, ownerId, sessionId } = await workoutSession();
    const crewId = await createClimber();
    await logTicks(ownerId, sessionId, workoutTicks(climbs));
    await logTicks(crewId, sessionId, [
      { uuid: uuidv4(), climbUuid: climbs.warmUp[0], angle: 40, status: 'send', climbedAt: minute(1) },
      { uuid: uuidv4(), climbUuid: climbs.fourByFour[0], angle: 40, status: 'send', climbedAt: minute(2) },
    ]);
    await db.insert(schema.sessionWorkouts).values({
      sessionId,
      userId: ownerId,
      plan: workoutPlan(climbs),
      tickMap: [],
      revision: 1,
    });
    uploadSessionActivity.mockResolvedValue({ externalActivityId: 'crew-export' });

    await autoSyncSessionToIntegrations(sessionId, 'kilter/1');

    const crewCall = uploadSessionActivity.mock.calls.find(([token]) => token === `token:${crewId}`);
    expect(crewCall?.[1].name).toBe('4x4 at V4 — 2 sends');
    expect(crewCall?.[1].description.split('\n')[0]).toBe('Workout: Warm-up 1/4 · 4x4 V4 1/16 reps · Cool-down 0/3');
  });

  it("keeps the board name for a crewmate who climbed none of the creator's workout", async () => {
    const { climbs, ownerId, sessionId } = await workoutSession();
    const crewId = await createClimber();
    const [ownPick] = await createClimbs(1);
    await logTicks(ownerId, sessionId, workoutTicks(climbs));
    await logTicks(crewId, sessionId, [
      { uuid: uuidv4(), climbUuid: ownPick, angle: 40, status: 'send', climbedAt: minute(3) },
    ]);
    await db.insert(schema.sessionWorkouts).values({
      sessionId,
      userId: ownerId,
      plan: workoutPlan(climbs),
      tickMap: [],
      revision: 1,
    });
    uploadSessionActivity.mockResolvedValue({ externalActivityId: 'crew-off-plan' });

    await autoSyncSessionToIntegrations(sessionId, 'kilter/1');

    const crewCall = uploadSessionActivity.mock.calls.find(([token]) => token === `token:${crewId}`);
    expect(crewCall?.[1].name).toBe('Kilter Board session — 1 send');
    expect(crewCall?.[1].description).not.toContain('Workout:');
  });

  it("exports today's text when the workout can't be read", async () => {
    const { climbs, ownerId, sessionId } = await workoutSession();
    await logTicks(ownerId, sessionId, workoutTicks(climbs).slice(0, 2));
    await db.insert(schema.sessionWorkouts).values({
      sessionId,
      userId: ownerId,
      plan: workoutPlan(climbs),
      tickMap: [],
      revision: 1,
    });
    const loader = vi.mocked(exportWorkout.loadExportWorkout);
    loader.mockRejectedValueOnce(new Error('boom'));
    uploadSessionActivity.mockResolvedValue({ externalActivityId: 'fallback-export' });

    await autoSyncSessionToIntegrations(sessionId, 'kilter/1');

    expect(loader).toHaveBeenCalled();
    expect(uploadSessionActivity.mock.calls[0][1].name).toBe('Kilter Board session — 2 sends');
  });

  it('keeps the board name without a workout', async () => {
    const { climbs, ownerId, sessionId } = await workoutSession();
    await logTicks(ownerId, sessionId, workoutTicks(climbs).slice(0, 2));
    uploadSessionActivity.mockResolvedValue({ externalActivityId: 'plain-export' });

    await autoSyncSessionToIntegrations(sessionId, 'kilter/1');

    expect(uploadSessionActivity.mock.calls[0][1].name).toBe('Kilter Board session — 2 sends');
    expect(uploadSessionActivity.mock.calls[0][1].description).not.toContain('Workout:');
  });
});
