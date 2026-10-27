import { describe, expect, it } from 'vitest';
import {
  deriveWorkoutStages,
  restrictDerivedWorkout,
  workoutHeadline,
  type SessionWorkoutPlan,
  type SessionWorkoutTick,
} from '../index';

const at = (minute: number): string => new Date(Date.UTC(2026, 9, 27, 12, minute)).toISOString();

const tick = (
  uuid: string,
  climbUuid: string,
  status: SessionWorkoutTick['status'],
  minute: number,
  extra: Partial<SessionWorkoutTick> = {},
): SessionWorkoutTick => ({ uuid, climbUuid, angle: 40, status, climbedAt: at(minute), ...extra });

const fourByFourPlan: SessionWorkoutPlan = {
  version: 1,
  stages: [
    {
      id: 'warm',
      kind: 'warmUp',
      items: [
        { queueItemUuid: 'q-w1', climbUuid: 'c-w1', angle: 40 },
        { queueItemUuid: 'q-w2', climbUuid: 'c-w2', angle: 40 },
      ],
    },
    {
      id: 'four',
      kind: 'fourByFour',
      targetGrade: 20,
      pacing: { mode: 'afterTick', restSeconds: 60, advanceOn: 'set', repsPerSet: 4, restBetweenSetsSeconds: 240 },
      items: [
        { queueItemUuid: 'q-a', climbUuid: 'c-a', angle: 40 },
        { queueItemUuid: 'q-b', climbUuid: 'c-b', angle: 40 },
      ],
    },
  ],
};

describe('deriveWorkoutStages', () => {
  it('counts a 4x4 set as reps on one climb, in tick order', () => {
    const ticks = [
      tick('t3', 'c-a', 'attempt', 3),
      tick('t1', 'c-a', 'flash', 1),
      tick('t2', 'c-a', 'send', 2),
      tick('t4', 'c-a', 'send', 4),
      tick('t5', 'c-b', 'attempt', 5),
      tick('t6', 'c-b', 'send', 6),
    ];
    const { stages, offPlan } = deriveWorkoutStages(fourByFourPlan, [], ticks);
    const four = stages[1];
    expect(four).toMatchObject({ kind: 'fourByFour', repsPerSet: 4, sets: 2, restSeconds: 60, targetGrade: 20 });
    expect(four.climbs[0].reps).toEqual(['flash', 'send', 'attempt', 'send']);
    expect(four.climbs[0].tickUuids).toEqual(['t1', 't2', 't3', 't4']);
    expect(four.climbs[1].reps).toEqual(['attempt', 'send']);
    expect(four.tally).toEqual({ sent: 4, attempts: 2, skipped: 0, climbs: 2 });
    expect(offPlan).toBe(0);
  });

  it('marks climbs without a tick skipped and still keeps the stage', () => {
    const { stages } = deriveWorkoutStages(fourByFourPlan, [], [tick('t1', 'c-w1', 'send', 1)]);
    expect(stages[0].climbs.map((climb) => climb.skipped)).toEqual([false, true]);
    expect(stages[0].tally).toEqual({ sent: 1, attempts: 0, skipped: 1, climbs: 2 });
    expect(stages[1].tally).toEqual({ sent: 0, attempts: 0, skipped: 2, climbs: 2 });
    expect(stages[1].sets).toBe(2);
  });

  it('prefers the tick map over climb and angle', () => {
    const plan: SessionWorkoutPlan = {
      version: 1,
      stages: [
        { id: 's1', kind: 'volume', items: [{ queueItemUuid: 'q1', climbUuid: 'same', angle: 40 }] },
        { id: 's2', kind: 'volume', items: [{ queueItemUuid: 'q2', climbUuid: 'same', angle: 40 }] },
      ],
    };
    const ticks = [tick('t1', 'same', 'send', 1), tick('t2', 'same', 'flash', 2)];
    const byClimb = deriveWorkoutStages(plan, [], ticks);
    expect(byClimb.stages[0].climbs[0].reps).toEqual(['send']);
    expect(byClimb.stages[1].climbs[0].reps).toEqual(['flash']);

    // The map puts the first tick on the second item; the unmapped one fills the first.
    const byMap = deriveWorkoutStages(plan, [{ tickUuid: 't1', queueItemUuid: 'q2' }], ticks);
    expect(byMap.stages[0].climbs[0].reps).toEqual(['flash']);
    expect(byMap.stages[1].climbs[0].reps).toEqual(['send']);
  });

  it('fills a climb queued more than once slot by slot, then piles extras on the last', () => {
    const plan: SessionWorkoutPlan = {
      version: 1,
      stages: [
        {
          id: 'warm',
          kind: 'warmUp',
          items: [{ queueItemUuid: 'q-warm', climbUuid: 'same', angle: 40 }],
        },
        {
          id: 'sets',
          kind: 'fourByFour',
          pacing: { mode: 'afterTick', restSeconds: 30, advanceOn: 'set', repsPerSet: 2, restBetweenSetsSeconds: 120 },
          items: [
            { queueItemUuid: 'q-set1', climbUuid: 'same', angle: 40 },
            { queueItemUuid: 'q-set2', climbUuid: 'same', angle: 40 },
          ],
        },
      ],
    };
    const ticks = [1, 2, 3, 4, 5, 6].map((minute) =>
      tick(`t${minute}`, 'same', minute % 2 === 0 ? 'send' : 'attempt', minute),
    );
    const { stages } = deriveWorkoutStages(plan, [], ticks);
    expect(stages[0].climbs[0].tickUuids).toEqual(['t1']);
    expect(stages[1].climbs[0].tickUuids).toEqual(['t2', 't3']);
    expect(stages[1].climbs[1].tickUuids).toEqual(['t4', 't5', 't6']);
    expect(stages[1].tally).toEqual({ sent: 3, attempts: 2, skipped: 0, climbs: 2 });
  });

  it('falls back to climb and angle when the map names an item the plan lacks', () => {
    const { stages, offPlan } = deriveWorkoutStages(
      fourByFourPlan,
      [{ tickUuid: 't1', queueItemUuid: 'gone' }],
      [tick('t1', 'c-a', 'send', 1)],
    );
    expect(stages[1].climbs[0].reps).toEqual(['send']);
    expect(offPlan).toBe(0);
  });

  it('matches angle, and mirror only when both sides say', () => {
    const plan: SessionWorkoutPlan = {
      version: 1,
      stages: [
        {
          id: 's',
          kind: 'volume',
          items: [
            { queueItemUuid: 'q-plain', climbUuid: 'c', angle: 40, isMirror: false },
            { queueItemUuid: 'q-mirror', climbUuid: 'c', angle: 40, isMirror: true },
          ],
        },
      ],
    };
    const { stages, offPlan, offPlanTickUuids } = deriveWorkoutStages(
      plan,
      [],
      [
        tick('t-mirror', 'c', 'send', 1, { isMirror: true }),
        tick('t-unknown', 'c', 'send', 2, { isMirror: null }),
        tick('t-angle', 'c', 'send', 3, { angle: 45 }),
      ],
    );
    expect(stages[0].climbs[0].tickUuids).toEqual(['t-unknown']);
    expect(stages[0].climbs[1].tickUuids).toEqual(['t-mirror']);
    expect(offPlan).toBe(1);
    expect(offPlanTickUuids).toEqual(['t-angle']);
  });

  it('counts ticks on climbs outside the plan as off plan', () => {
    const { offPlan, stages } = deriveWorkoutStages(
      fourByFourPlan,
      [],
      [tick('t1', 'elsewhere', 'send', 1), tick('t2', 'elsewhere', 'attempt', 2), tick('t3', 'c-a', 'send', 3)],
    );
    expect(offPlan).toBe(2);
    expect(stages[1].tally.sent).toBe(1);
  });

  it('passes an unknown kind through', () => {
    const plan: SessionWorkoutPlan = {
      version: 1,
      stages: [
        {
          id: 's',
          kind: 'campusLadder',
          pacing: { mode: 'onTheMinute', restSeconds: 90 },
          items: [{ queueItemUuid: 'q', climbUuid: 'c', angle: 40 }],
        },
      ],
    };
    const { stages } = deriveWorkoutStages(plan, [], [tick('t', 'c', 'attempt', 1)]);
    expect(stages[0]).toMatchObject({ kind: 'campusLadder', intervalSeconds: 90, isCoolDown: false });
    expect(stages[0].repsPerSet).toBeUndefined();
    expect(stages[0].tally).toEqual({ sent: 0, attempts: 1, skipped: 0, climbs: 1 });
  });

  it('marks a cool-down', () => {
    const plan: SessionWorkoutPlan = {
      version: 1,
      stages: [{ id: 's', kind: 'warmUp', coolDown: true, items: [{ queueItemUuid: 'q', climbUuid: 'c', angle: 40 }] }],
    };
    expect(deriveWorkoutStages(plan, [], []).stages[0].isCoolDown).toBe(true);
  });

  it("adds up to the owner's session sends when every tick is on the plan", () => {
    const ticks = [
      tick('t1', 'c-w1', 'flash', 1),
      tick('t2', 'c-w2', 'send', 2),
      tick('t3', 'c-a', 'attempt', 3),
      tick('t4', 'c-a', 'send', 4),
      tick('t5', 'c-b', 'send', 5),
    ];
    const { stages } = deriveWorkoutStages(fourByFourPlan, [], ticks);
    const sent = stages.reduce((sum, stage) => sum + stage.tally.sent, 0);
    const attempts = stages.reduce((sum, stage) => sum + stage.tally.attempts, 0);
    expect(sent).toBe(ticks.filter((entry) => entry.status !== 'attempt').length);
    expect(attempts).toBe(1);
  });
});

describe('restrictDerivedWorkout', () => {
  const ticks = [
    tick('t1', 'c-w1', 'send', 1),
    tick('t2', 'c-a', 'send', 2),
    tick('t3', 'c-a', 'attempt', 3),
    tick('t4', 'c-b', 'send', 4),
    tick('t5', 'off', 'send', 5),
  ];

  it('drops a hidden climb with all its reps and counts again', () => {
    const derived = deriveWorkoutStages(fourByFourPlan, [], ticks);
    const restricted = restrictDerivedWorkout(
      derived,
      (climb) => climb.climbUuid !== 'c-b',
      () => true,
    );
    expect(restricted.stages[1].climbs.map((climb) => climb.climbUuid)).toEqual(['c-a']);
    expect(restricted.stages[1].tally).toEqual({ sent: 1, attempts: 1, skipped: 0, climbs: 1 });
    expect(restricted.stages[1].sets).toBe(1);
  });

  it('drops a climb holding a hidden tick rather than calling it skipped', () => {
    const derived = deriveWorkoutStages(fourByFourPlan, [], ticks);
    const restricted = restrictDerivedWorkout(
      derived,
      () => true,
      (uuid) => uuid !== 't3' && uuid !== 't5',
    );
    expect(restricted.stages[1].climbs.map((climb) => climb.climbUuid)).toEqual(['c-b']);
    expect(restricted.offPlan).toBe(0);
  });

  it('drops a stage left with no climbs', () => {
    const derived = deriveWorkoutStages(fourByFourPlan, [], ticks);
    const restricted = restrictDerivedWorkout(
      derived,
      (climb) => climb.climbUuid.startsWith('c-w'),
      () => true,
    );
    expect(restricted.stages.map((stage) => stage.id)).toEqual(['warm']);
  });
});

describe('workoutHeadline', () => {
  it('leads with the first block that is not a warm-up', () => {
    expect(workoutHeadline(fourByFourPlan.stages)).toEqual({
      mainKind: 'fourByFour',
      mainTargetGrade: 20,
      blockCount: 2,
      extraMainBlocks: 0,
    });
  });

  it('names the second main block and counts the rest', () => {
    const headline = workoutHeadline([
      { kind: 'warmUp' },
      { kind: 'volume', targetGrade: 18 },
      { kind: 'fourByFour', targetGrade: 20 },
      { kind: 'pyramid', targetGrade: 22 },
      { kind: 'warmUp' },
    ]);
    expect(headline).toEqual({
      mainKind: 'volume',
      mainTargetGrade: 18,
      secondMainKind: 'fourByFour',
      blockCount: 5,
      extraMainBlocks: 2,
    });
  });

  it('falls back to the warm-ups when they are all there is', () => {
    expect(workoutHeadline([{ kind: 'warmUp' }, { kind: 'warmUp' }])).toEqual({
      mainKind: 'warmUp',
      secondMainKind: 'warmUp',
      blockCount: 2,
      extraMainBlocks: 1,
    });
  });

  it('is empty for no stages', () => {
    expect(workoutHeadline([])).toEqual({ blockCount: 0, extraMainBlocks: 0 });
  });
});
