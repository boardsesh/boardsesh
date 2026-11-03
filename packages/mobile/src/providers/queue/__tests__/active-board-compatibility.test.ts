import { describe, expect, it } from 'vitest';
import type { Climb } from '@boardsesh/queue';
import { reachableClimbPredicate, toActiveBoardCompatibilityConfig } from '../active-board-compatibility';

// The one copy of the walk's board rule: the queue provider's `nextClimb` and
// the queue sheet's Then from walk (`useQueueWalkBoard`) both build on it.

describe('toActiveBoardCompatibilityConfig', () => {
  it("names the active board's type and layout", () => {
    expect(toActiveBoardCompatibilityConfig({ boardType: 'kilter', layoutId: 8 })).toEqual({
      boardName: 'kilter',
      layoutId: 8,
    });
  });

  it('fails open with no board, or one it cannot name', () => {
    expect(toActiveBoardCompatibilityConfig(null)).toBeUndefined();
    expect(toActiveBoardCompatibilityConfig(undefined)).toBeUndefined();
    expect(toActiveBoardCompatibilityConfig({ boardType: 'not-a-board', layoutId: 1 })).toBeUndefined();
  });
});

describe('reachableClimbPredicate', () => {
  it('reaches nothing beyond the active board with no other walls at the gym', () => {
    expect(reachableClimbPredicate(new Set())).toBeUndefined();
  });

  it("reaches a climb on another wall at the gym, and nothing on a wall that isn't there", () => {
    const isReachable = reachableClimbPredicate(new Set(['tension:9']));
    expect(isReachable?.({ uuid: 't', boardType: 'tension', layoutId: 9 } as Climb)).toBe(true);
    expect(isReachable?.({ uuid: 'k', boardType: 'kilter', layoutId: 1 } as Climb)).toBe(false);
  });
});
