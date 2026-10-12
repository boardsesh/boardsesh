import { describe, expect, it, vi } from 'vitest';

// The hook's queries are not under test here, only the pure builder.
vi.mock('../../../lib/graphql/hooks/use-you-data', () => ({
  useUserTickCountsByBoard: vi.fn(),
  useUserProfileStats: vi.fn(),
}));
vi.mock('expo-router', () => ({ useIsFocused: () => true }));

import { buildLogbookBoardOptions } from '../use-logbook-board-options';

describe('buildLogbookBoardOptions', () => {
  it('lists boards with ticks, most-ticked first, each with its layouts most-climbed first', () => {
    const options = buildLogbookBoardOptions({ kilter: 40, tension: 90, moonboard: 0 }, [
      { boardType: 'kilter', layoutId: 1, distinctClimbCount: 5 },
      { boardType: 'kilter', layoutId: 8, distinctClimbCount: 20 },
      { boardType: 'tension', layoutId: 10, distinctClimbCount: 9 },
      { boardType: 'tension', layoutId: null, distinctClimbCount: 3 },
    ]);
    expect(options.map((option) => option.boardType)).toEqual(['tension', 'kilter']);
    expect(options[1].label).toBe('Kilter');
    expect(options[1].layouts.map((layout) => layout.layoutId)).toEqual([8, 1]);
    // A layout-less stats row has no chip.
    expect(options[0].layouts.map((layout) => layout.layoutId)).toEqual([10]);
  });

  it('keeps a board only the layout stats know about, after the ticked ones', () => {
    const options = buildLogbookBoardOptions({ kilter: 4 }, [
      { boardType: 'tension', layoutId: 10, distinctClimbCount: 1 },
    ]);
    expect(options.map((option) => option.boardType)).toEqual(['kilter', 'tension']);
  });

  it('names a spray wall board and offers no layouts for it', () => {
    const options = buildLogbookBoardOptions({ spray: 3 }, [
      { boardType: 'spray', layoutId: 7001, distinctClimbCount: 3 },
    ]);
    expect(options).toEqual([{ boardType: 'spray', label: 'Spray wall', layouts: [] }]);
  });

  it('is empty before either read lands', () => {
    expect(buildLogbookBoardOptions(undefined, undefined)).toEqual([]);
  });
});
