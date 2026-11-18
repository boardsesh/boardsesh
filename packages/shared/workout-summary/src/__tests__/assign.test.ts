import { describe, expect, it } from 'vitest';
import { assignWorkoutTicks, type AssignableWorkoutTick } from '../index';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 27, 12, minute)).toISOString();

const tick = (uuid: string, userId: string, climbUuid: string, minute: number): AssignableWorkoutTick => ({
  uuid,
  userId,
  climbUuid,
  angle: 40,
  climbedAt: at(minute),
});

describe('assignWorkoutTicks', () => {
  const workout = {
    userId: 'owner',
    stages: [
      { climbs: [{ climbUuid: 'a', angle: 40, reps: ['send' as const] }] },
      {
        climbs: [
          { climbUuid: 'b', angle: 40, reps: ['send' as const, 'attempt' as const] },
          { climbUuid: 'c', angle: 40, reps: [] },
        ],
      },
      // The warm-up climb again in the cool-down: the first slot fills first.
      { climbs: [{ climbUuid: 'a', angle: 40, reps: ['flash' as const] }] },
    ],
  };

  it("puts the owner's ticks on their climbs oldest first, the rest off plan, others with the crew", () => {
    const ticks = [
      tick('a2', 'owner', 'a', 9),
      tick('a1', 'owner', 'a', 1),
      tick('b1', 'owner', 'b', 2),
      tick('b2', 'owner', 'b', 3),
      tick('x1', 'owner', 'x', 4),
      tick('a3', 'owner', 'a', 10),
      tick('crew', 'mate', 'b', 5),
    ];

    const assigned = assignWorkoutTicks(ticks, workout);

    expect(assigned.byClimb.map((stage) => stage.map((climb) => climb.map((t) => t.uuid)))).toEqual([
      [['a1']],
      [['b1', 'b2'], []],
      [['a2']],
    ]);
    expect(assigned.offPlan.map((t) => t.uuid)).toEqual(['x1', 'a3']);
    expect(assigned.crew.map((t) => t.uuid)).toEqual(['crew']);
  });

  it('puts a way-down tick on the way-down copy of a climb, even when the way up was skipped (#6740)', () => {
    // A B C B A, as deriveWorkoutStages placed it: way-up A skipped, the rest sent once.
    const pyramid = {
      userId: 'owner',
      stages: [
        {
          climbs: [
            { climbUuid: 'a', angle: 40, reps: [] },
            { climbUuid: 'b', angle: 40, reps: ['send' as const] },
            { climbUuid: 'c', angle: 40, reps: ['send' as const] },
            { climbUuid: 'b', angle: 40, reps: ['send' as const] },
            { climbUuid: 'a', angle: 40, reps: ['send' as const] },
          ],
        },
      ],
    };
    const ticks = [
      tick('b-up', 'owner', 'b', 1),
      tick('c', 'owner', 'c', 2),
      tick('b-down', 'owner', 'b', 3),
      tick('a-down', 'owner', 'a', 4),
    ];

    const assigned = assignWorkoutTicks(ticks, pyramid);

    expect(assigned.byClimb[0].map((climb) => climb.map((t) => t.uuid))).toEqual([
      [],
      ['b-up'],
      ['c'],
      ['b-down'],
      ['a-down'],
    ]);
    expect(assigned.offPlan).toEqual([]);
  });

  it('matches the way deriveWorkoutStages placed a climb queued twice, forwards from the last tick', () => {
    // A B C B A where the climber did C, then A twice: derive put the first A on
    // the way-down copy (after C) and the second on the way-up copy.
    const pyramid = {
      userId: 'owner',
      stages: [
        {
          climbs: [
            { climbUuid: 'a', angle: 40, reps: ['send' as const] },
            { climbUuid: 'b', angle: 40, reps: [] },
            { climbUuid: 'c', angle: 40, reps: ['send' as const] },
            { climbUuid: 'b', angle: 40, reps: [] },
            { climbUuid: 'a', angle: 40, reps: ['attempt' as const] },
          ],
        },
      ],
    };
    const ticks = [tick('c', 'owner', 'c', 1), tick('a-first', 'owner', 'a', 2), tick('a-second', 'owner', 'a', 3)];

    const assigned = assignWorkoutTicks(ticks, pyramid);

    expect(assigned.byClimb[0].map((climb) => climb.map((t) => t.uuid))).toEqual([
      ['a-second'],
      [],
      ['c'],
      [],
      ['a-first'],
    ]);
  });

  it('groups ticks with the same time by uuid, whatever order they were listed in', () => {
    const twice = {
      userId: 'owner',
      stages: [
        {
          climbs: [
            { climbUuid: 'a', angle: 40, reps: ['send' as const] },
            { climbUuid: 'a', angle: 40, reps: ['attempt' as const] },
          ],
        },
      ],
    };
    const first = tick('a-1', 'owner', 'a', 1);
    const second = tick('a-2', 'owner', 'a', 1);
    const grouped = (ticks: AssignableWorkoutTick[]) =>
      assignWorkoutTicks(ticks, twice).byClimb[0].map((climb) => climb.map((t) => t.uuid));

    expect(grouped([second, first])).toEqual([['a-1'], ['a-2']]);
    expect(grouped([first, second])).toEqual([['a-1'], ['a-2']]);
  });

  it('keeps a mirrored go off a climb planned the other way round', () => {
    const mirrored = {
      userId: 'owner',
      stages: [{ climbs: [{ climbUuid: 'a', angle: 40, isMirror: false, reps: ['send' as const] }] }],
    };
    const assigned = assignWorkoutTicks([{ ...tick('m', 'owner', 'a', 1), isMirror: true }], mirrored);
    expect(assigned.offPlan.map((t) => t.uuid)).toEqual(['m']);
  });

  it("goes by the server's tick uuids when it sends them, so a crewmate's go on a planned climb stays theirs", () => {
    const byUuid = {
      userId: 'owner',
      offPlanTickUuids: ['x1'],
      stages: [
        { climbs: [{ climbUuid: 'a', angle: 40, reps: ['send' as const], tickUuids: ['a1'] }] },
        {
          climbs: [{ climbUuid: 'b', angle: 40, reps: ['attempt' as const, 'send' as const], tickUuids: ['b2', 'b1'] }],
        },
      ],
    };
    const ticks = [
      tick('a1', 'owner', 'a', 1),
      tick('b1', 'owner', 'b', 2),
      tick('b2', 'owner', 'b', 3),
      tick('x1', 'owner', 'x', 4),
      tick('mate-a', 'mate', 'a', 5),
      // An owner tick the answer doesn't name (newer than it): off plan, never guessed onto a climb.
      tick('a-late', 'owner', 'a', 6),
    ];

    const assigned = assignWorkoutTicks(ticks, byUuid);

    expect(assigned.byClimb.map((stage) => stage.map((climb) => climb.map((t) => t.uuid)))).toEqual([
      [['a1']],
      [['b1', 'b2']],
    ]);
    expect(assigned.offPlan.map((t) => t.uuid)).toEqual(['x1', 'a-late']);
    expect(assigned.crew.map((t) => t.uuid)).toEqual(['mate-a']);
  });
});
