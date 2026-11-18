// `assignWorkoutTicks` without tick uuids must put every tick where
// `deriveWorkoutStages` put it, or a session's Climbs list shows a go under one
// copy of a climb while the block's tally counted it under another. Checked
// over every small plan and tick sequence, climbs queued twice included (a
// pyramid coming back down on the same climbs, #6740), at one tick per climb
// and at a 4x4's two reps per set.
import { describe, expect, it } from 'vitest';
import { assignWorkoutTicks, deriveWorkoutStages, type SessionWorkoutPlan, type SessionWorkoutTick } from '../index';

/** Every sequence of `letters` of each length from `minLength` to `maxLength`. */
function sequences(letters: readonly string[], minLength: number, maxLength: number): string[][] {
  const all: string[][] = [];
  let current: string[][] = [[]];
  for (let length = 0; length <= maxLength; length++) {
    if (length >= minLength) all.push(...current);
    current = current.flatMap((sequence) => letters.map((letter) => [...sequence, letter]));
  }
  return all;
}

function planOf(climbUuids: readonly string[], repsPerSet: number): SessionWorkoutPlan {
  return {
    version: 1,
    stages: [
      {
        id: 'stage',
        kind: repsPerSet > 1 ? 'fourByFour' : 'pyramid',
        ...(repsPerSet > 1
          ? {
              pacing: {
                mode: 'afterTick' as const,
                restSeconds: 0,
                advanceOn: 'set',
                repsPerSet,
                restBetweenSetsSeconds: 60,
              },
            }
          : {}),
        items: climbUuids.map((climbUuid, position) => ({ queueItemUuid: `q${position}`, climbUuid, angle: 40 })),
      },
    ],
  };
}

const ticksOf = (climbUuids: readonly string[]): Array<SessionWorkoutTick & { userId: string; climbedAt: string }> =>
  climbUuids.map((climbUuid, position) => ({
    uuid: `t${position}`,
    userId: 'owner',
    climbUuid,
    angle: 40,
    status: 'send',
    climbedAt: new Date(Date.UTC(2026, 10, 18, 12, position)).toISOString(),
  }));

/** Every plan of `planLetters` against every unmapped tick sequence of `tickLetters`; returns how many disagreed. */
function countDisagreements(
  planLetters: readonly string[],
  maxPlanLength: number,
  tickLetters: readonly string[],
  maxTicks: number,
): { cases: number; disagreements: string[] } {
  const disagreements: string[] = [];
  let cases = 0;
  for (const repsPerSet of [1, 2]) {
    for (const planClimbs of sequences(planLetters, 1, maxPlanLength)) {
      const plan = planOf(planClimbs, repsPerSet);
      for (const tickClimbs of sequences(tickLetters, 0, maxTicks)) {
        cases++;
        const ticks = ticksOf(tickClimbs);
        const derived = deriveWorkoutStages(plan, [], ticks);
        // What the server answers, without the tick uuids an older payload lacks.
        const assigned = assignWorkoutTicks(ticks, {
          userId: 'owner',
          stages: derived.stages.map((stage) => ({
            repsPerSet: stage.repsPerSet,
            climbs: stage.climbs.map(({ climbUuid, angle, reps }) => ({ climbUuid, angle, reps })),
          })),
        });
        const derivedUuids = derived.stages[0].climbs.map((climb) => climb.tickUuids);
        const assignedUuids = assigned.byClimb[0].map((climbTicks) => climbTicks.map((tick) => tick.uuid));
        if (JSON.stringify(derivedUuids) !== JSON.stringify(assignedUuids)) {
          disagreements.push(
            `reps ${repsPerSet} plan ${planClimbs.join('')} ticks ${tickClimbs.join('')}: ` +
              `derive ${JSON.stringify(derivedUuids)} assign ${JSON.stringify(assignedUuids)}`,
          );
        }
      }
    }
  }
  return { cases, disagreements };
}

describe('assignWorkoutTicks agrees with deriveWorkoutStages', () => {
  it('on every plan of two climbs up to 5 long, against every 0 to 5 ticks with one off the plan', () => {
    const { cases, disagreements } = countDisagreements(['a', 'b'], 5, ['a', 'b', 'x'], 5);
    expect(cases).toBe(2 * 62 * 364);
    expect(disagreements.slice(0, 5)).toEqual([]);
  });

  it('on every plan of three climbs up to 4 long, against every 0 to 4 ticks', () => {
    const { cases, disagreements } = countDisagreements(['a', 'b', 'c'], 4, ['a', 'b', 'c'], 4);
    expect(cases).toBe(2 * 120 * 121);
    expect(disagreements.slice(0, 5)).toEqual([]);
  });
});
