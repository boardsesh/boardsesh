import { describe, expect, it } from 'vitest';
import type {
  SessionWorkoutHeadlineResult,
  SessionWorkoutResult,
} from '@boardsesh/graphql/operations/session-workouts';
import type { WorkoutRunRecord } from '../../../../lib/workout-run-store';
import {
  chooseSessionWorkout,
  headlineRequests,
  headlineView,
  localWorkoutView,
  serverWorkoutView,
  type FormatGradeLabel,
} from '../session-workout-view-model';

/** The V-scale half of a "6a/V3" label, as the V grade preference draws it. */
const vGrades: FormatGradeLabel = (label) => label?.split('/').at(1) ?? null;

const serverWorkout = (userId: string): SessionWorkoutResult => ({
  userId,
  displayName: null,
  avatarUrl: null,
  offPlan: 1,
  offPlanTickUuids: ['tick-off'],
  updatedAt: '2026-10-28T12:00:00Z',
  stages: [
    {
      id: 'four',
      kind: 'fourByFour',
      isCoolDown: false,
      targetGrade: '7a/V6',
      repsPerSet: 4,
      sets: 1,
      intervalSeconds: null,
      restSeconds: 10,
      tally: { sent: 3, attempts: 1, skipped: 0, climbs: 1 },
      climbs: [
        {
          queueItemUuid: 'f1',
          climbUuid: 'climb-f1',
          angle: 40,
          isMirror: null,
          name: 'Crimp line',
          grade: '6c/V5',
          boardType: 'kilter',
          layoutId: 1,
          frames: 'p1r12',
          renderBoard: null,
          reps: ['ATTEMPT', 'SEND', 'FLASH', 'SEND'],
          tickUuids: ['t1', 't2', 't3', 't4'],
          skipped: false,
        },
      ],
    },
  ],
});

describe('serverWorkoutView', () => {
  it('lowercases the reps, keeps the tick uuids and draws grades in the viewer’s system', () => {
    const view = serverWorkoutView(serverWorkout('user-1'), vGrades);
    expect(view.userId).toBe('user-1');
    expect(view.offPlanTickUuids).toEqual(['tick-off']);
    const [stage] = view.stages;
    expect(stage?.targetGrade).toBe('V6');
    expect(stage?.climbs[0]).toMatchObject({
      reps: ['attempt', 'send', 'flash', 'send'],
      tickUuids: ['t1', 't2', 't3', 't4'],
      grade: 'V5',
      difficulty: 20,
      name: 'Crimp line',
    });
    expect(stage?.climbs[0]?.isMirror).toBeUndefined();
  });
});

describe('localWorkoutView', () => {
  const record: Pick<WorkoutRunRecord, 'run' | 'climbs' | 'log'> = {
    run: {
      stages: [
        {
          id: 'four',
          kind: 'fourByFour',
          targetGrade: 20,
          itemUuids: ['f1', 'f2'],
          pacing: {
            mode: 'afterTick',
            restSeconds: 10,
            advanceOn: 'set',
            sets: { repsPerSet: 4, restBetweenSetsSeconds: 180 },
          },
        },
      ],
    },
    climbs: {
      f1: { climbUuid: 'climb-f1', angle: 40, name: 'Crimp line', difficulty: '6c/V5', boardType: 'kilter' },
      f2: { climbUuid: 'climb-f2', angle: 40, name: 'Pinches', difficulty: '6b/V4', boardType: 'kilter' },
    },
    log: [
      { queueItemUuid: 'f1', status: 'attempt', climbedAt: '2026-10-28T10:00:00Z', tickUuid: 't1' },
      { queueItemUuid: 'f1', status: 'send', climbedAt: '2026-10-28T10:01:00Z', tickUuid: 't2' },
      // Saved while the answer never came back: still counted, on its climb.
      { queueItemUuid: 'f1', status: 'send', climbedAt: '2026-10-28T10:02:00Z' },
    ],
  };

  it("tallies the phone's own log the way the server would, while the write is still queued", () => {
    const view = localWorkoutView(record, 'user-1', vGrades);
    expect(view?.userId).toBe('user-1');
    expect(view?.offPlan).toBe(0);
    const [stage] = view?.stages ?? [];
    expect(stage).toMatchObject({ kind: 'fourByFour', targetGrade: 'V5', repsPerSet: 4, sets: 2 });
    expect(stage?.tally).toEqual({ sent: 2, attempts: 1, skipped: 1, climbs: 2 });
    expect(stage?.climbs[0]).toMatchObject({
      name: 'Crimp line',
      grade: 'V5',
      reps: ['attempt', 'send', 'send'],
      // The stand-in uuid of the unanswered save names no listed tick.
      tickUuids: ['t1', 't2'],
    });
    expect(stage?.climbs[1]).toMatchObject({ name: 'Pinches', skipped: true, reps: [] });
  });

  it('is null when no climb was captured', () => {
    expect(localWorkoutView({ ...record, climbs: undefined }, 'user-1', vGrades)).toBeNull();
  });
});

describe('chooseSessionWorkout', () => {
  const mine = serverWorkout('me');
  const owner = serverWorkout('owner');
  const base = {
    workouts: [owner, mine],
    viewerUserId: 'me',
    sessionOwnerUserId: 'owner',
    localAvailable: false,
    phoneAhead: false,
    scope: 'viewer' as const,
  };

  it("shows the viewer's own server copy once the phone has nothing left to send", () => {
    expect(chooseSessionWorkout({ ...base, localAvailable: true })).toEqual({ source: 'server', workout: mine });
  });

  it("shows the phone's run while ticks or the workout are still saving", () => {
    expect(chooseSessionWorkout({ ...base, localAvailable: true, phoneAhead: true })).toEqual({ source: 'local' });
  });

  it('falls back to the phone when the server has no workout for the viewer yet', () => {
    expect(chooseSessionWorkout({ ...base, workouts: [], localAvailable: true })).toEqual({ source: 'local' });
  });

  it("never shows someone else's workout on the summary", () => {
    expect(chooseSessionWorkout({ ...base, workouts: [owner] })).toBeNull();
  });

  it("shows the session owner's workout on session detail when the viewer ran none", () => {
    const crewmate = serverWorkout('crewmate');
    expect(chooseSessionWorkout({ ...base, scope: 'session', workouts: [crewmate, owner] })).toEqual({
      source: 'server',
      workout: owner,
    });
    expect(chooseSessionWorkout({ ...base, scope: 'session', workouts: [crewmate] })).toEqual({
      source: 'server',
      workout: crewmate,
    });
    expect(chooseSessionWorkout({ ...base, scope: 'session', workouts: [owner, mine] })).toEqual({
      source: 'server',
      workout: mine,
    });
  });
});

describe('headlines', () => {
  it('asks once per feed page, splitting a page over the cap and leaving out daily cards and repeats', () => {
    expect(
      headlineRequests([['s1', 'daily:user:2026-10-28', 's2'], ['s2', 's3', 's4', 's5'], ['daily:user:2026-10-27']], 3),
    ).toEqual([
      ['s1', 's2'],
      ['s3', 's4', 's5'],
    ]);
    expect(headlineRequests([['s1', 's2', 's3', 's4']], 3)).toEqual([['s1', 's2', 's3'], ['s4']]);
  });

  it("maps the server's headline, its grade in the viewer's system", () => {
    const headline: SessionWorkoutHeadlineResult = {
      sessionId: 's1',
      userId: 'me',
      mainKind: 'fourByFour',
      mainTargetGrade: '6b/V4',
      secondMainKind: null,
      blockCount: 3,
      extraMainBlocks: 0,
    };
    expect(headlineView(headline, vGrades)).toEqual({
      mainKind: 'fourByFour',
      mainTargetGrade: 'V4',
      secondMainKind: null,
      blockCount: 3,
      extraMainBlocks: 0,
    });
  });
});
