import { describe, expect, it } from 'vitest';
import { shouldDefaultToBrowse } from '../browse-defaults';

describe('shouldDefaultToBrowse', () => {
  const cases: { name: string; sessionActive: boolean; distinctUserCount: number; expected: boolean }[] = [
    { name: 'solo, no session at all', sessionActive: false, distinctUserCount: 0, expected: false },
    // The ordinary state right after starting a session: the climber is alone
    // in it, so swipes keep driving their own wall.
    { name: 'session of one — nobody has joined yet', sessionActive: true, distinctUserCount: 1, expected: false },
    { name: 'session of two — an audience exists', sessionActive: true, distinctUserCount: 2, expected: true },
    { name: 'a full crew', sessionActive: true, distinctUserCount: 6, expected: true },
    // A roster that outlived its session id is stale bookkeeping; it must not
    // keep gestures view-only after the session ended.
    { name: 'roster left over after the session ended', sessionActive: false, distinctUserCount: 4, expected: false },
    {
      name: 'session id with an empty roster (pre-JOIN response)',
      sessionActive: true,
      distinctUserCount: 0,
      expected: false,
    },
  ];

  it.each(cases)('$name', ({ sessionActive, distinctUserCount, expected }) => {
    expect(shouldDefaultToBrowse({ sessionActive, distinctUserCount })).toBe(expected);
  });

  it('flips only across the 1 → 2 boundary', () => {
    // The value is consumed as a context/prop by high-fanout surfaces, so the
    // boundary is the whole point: a roster growing 2 → 3 → 4 must not churn it.
    const counts = [0, 1, 2, 3, 4, 12];
    expect(
      counts.map((distinctUserCount) => shouldDefaultToBrowse({ sessionActive: true, distinctUserCount })),
    ).toEqual([false, false, true, true, true, true]);
  });
});
