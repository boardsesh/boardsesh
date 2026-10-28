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

  it('keeps a mirrored go off a climb planned the other way round', () => {
    const mirrored = {
      userId: 'owner',
      stages: [{ climbs: [{ climbUuid: 'a', angle: 40, isMirror: false, reps: ['send' as const] }] }],
    };
    const assigned = assignWorkoutTicks([{ ...tick('m', 'owner', 'a', 1), isMirror: true }], mirrored);
    expect(assigned.offPlan.map((t) => t.uuid)).toEqual(['m']);
  });
});
