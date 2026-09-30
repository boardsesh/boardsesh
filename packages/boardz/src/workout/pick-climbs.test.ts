import { describe, expect, it } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';
import { pickClimbs, shuffled, swapClimb } from './pick-climbs';

function climb(uuid: string): Climb {
  return {
    uuid,
    setter_username: 'setter',
    name: uuid,
    frames: 'p1r42',
    angle: 40,
    ascensionist_count: 10,
    difficulty: '6b/V4',
    quality_average: '2.5',
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
  };
}

const pools = new Map<number, Climb[]>([
  [16, [climb('a'), climb('b')]],
  [18, [climb('c'), climb('d'), climb('e')]],
]);

describe('pickClimbs', () => {
  it('takes a different climb for each slot of the same grade', () => {
    const { planned, missing } = pickClimbs([16, 18, 18, 16], pools);
    expect(planned.map((entry) => entry.climb.uuid)).toEqual(['a', 'c', 'd', 'b']);
    expect(missing).toBe(0);
  });

  it('drops slots whose grade has run out of climbs', () => {
    const { planned, missing } = pickClimbs([16, 16, 16, 20], pools);
    expect(planned.map((entry) => entry.climb.uuid)).toEqual(['a', 'b']);
    expect(missing).toBe(2);
  });
});

describe('swapClimb', () => {
  it('swaps in a climb at the same grade that is not already planned', () => {
    const { planned } = pickClimbs([18, 18], pools);
    const swapped = swapClimb(planned, 0, pools, () => 0);
    expect(swapped.map((entry) => entry.climb.uuid)).toEqual(['e', 'd']);
    expect(swapped[0].grade).toBe(18);
  });

  it('keeps the plan when there is nothing left to swap in', () => {
    const { planned } = pickClimbs([16, 16], pools);
    expect(swapClimb(planned, 1, pools).map((entry) => entry.climb.uuid)).toEqual(['a', 'b']);
  });
});

describe('shuffled', () => {
  it('reorders without losing or mutating anything', () => {
    const items = [1, 2, 3, 4, 5];
    const result = shuffled(items, () => 0);
    expect([...result].sort((first, second) => first - second)).toEqual(items);
    expect(items).toEqual([1, 2, 3, 4, 5]);
  });
});
