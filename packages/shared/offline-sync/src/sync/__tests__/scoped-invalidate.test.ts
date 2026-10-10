import { describe, expect, it } from 'vitest';
import { queryKeyMatchesBoardScope, scopedInvalidateFilters } from '../invalidate-keys';

const KILTER_1 = { boardType: 'kilter', layoutId: 1 };

describe('queryKeyMatchesBoardScope', () => {
  it('matches a heatmap key on the same board and layout', () => {
    const key = ['holdHeatmap', 'local', { boardName: 'kilter', layoutId: 1, sizeId: 10 }];
    expect(queryKeyMatchesBoardScope(key, KILTER_1)).toBe(true);
  });

  it('skips a heatmap key on another layout or board', () => {
    expect(queryKeyMatchesBoardScope(['holdHeatmap', 'local', { boardName: 'kilter', layoutId: 8 }], KILTER_1)).toBe(
      false,
    );
    expect(queryKeyMatchesBoardScope(['holdHeatmap', 'local', { boardName: 'tension', layoutId: 1 }], KILTER_1)).toBe(
      false,
    );
  });

  it("reads similar climbs' positional key", () => {
    // ['similarClimbs', boardName, climbUuid, layoutId, sizeId, angle, limit, source]
    expect(queryKeyMatchesBoardScope(['similarClimbs', 'kilter', 'uuid-1', 1, 10, 40, 12, 'local'], KILTER_1)).toBe(
      true,
    );
    expect(queryKeyMatchesBoardScope(['similarClimbs', 'kilter', 'uuid-1', 8, 10, 40, 12, 'local'], KILTER_1)).toBe(
      false,
    );
    expect(queryKeyMatchesBoardScope(['similarClimbs', 'tension', 'uuid-1', 1, 10, 40, 12, 'local'], KILTER_1)).toBe(
      false,
    );
  });

  it('refreshes a key that names no board', () => {
    expect(queryKeyMatchesBoardScope(['holdHeatmap'], KILTER_1)).toBe(true);
  });

  // The three climb-search keys are `[head, ClimbSearchInput, viewerId?]`: the
  // viewer id is appended for a Following search (#6302).
  describe.each(['searchClimbs', 'infiniteSearchClimbs', 'searchClimbsCount'])('%s', (head) => {
    const kilterInput = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40, pageSize: 30 };

    it('matches its own board at any size, with or without a viewer id', () => {
      expect(queryKeyMatchesBoardScope([head, kilterInput], KILTER_1)).toBe(true);
      expect(queryKeyMatchesBoardScope([head, { ...kilterInput, sizeId: 7 }], KILTER_1)).toBe(true);
      expect(
        queryKeyMatchesBoardScope([head, { ...kilterInput, onlyFollowedAuthors: true }, 'viewer-1'], KILTER_1),
      ).toBe(true);
    });

    it('skips another layout, another board and a spray wall', () => {
      expect(queryKeyMatchesBoardScope([head, { ...kilterInput, layoutId: 8 }], KILTER_1)).toBe(false);
      expect(queryKeyMatchesBoardScope([head, { ...kilterInput, boardName: 'tension' }], KILTER_1)).toBe(false);
      expect(queryKeyMatchesBoardScope([head, kilterInput], { boardType: 'spray', layoutId: 36 })).toBe(false);
      expect(queryKeyMatchesBoardScope([head, kilterInput, 'viewer-1'], { boardType: 'spray', layoutId: 1 })).toBe(
        false,
      );
    });

    it('refreshes a key it cannot read', () => {
      expect(queryKeyMatchesBoardScope([head], KILTER_1)).toBe(true);
      expect(queryKeyMatchesBoardScope([head, { boardName: 'kilter' }], KILTER_1)).toBe(true);
    });
  });
});

describe('scopedInvalidateFilters', () => {
  it('adds a predicate only to board-scoped heads with a known board', () => {
    expect(scopedInvalidateFilters(['holdHeatmap'], KILTER_1).predicate).toBeTypeOf('function');
    expect(scopedInvalidateFilters(['logbook'], KILTER_1)).toEqual({ queryKey: ['logbook'] });
    expect(scopedInvalidateFilters(['holdHeatmap'], undefined)).toEqual({ queryKey: ['holdHeatmap'] });
  });

  it('scopes the climb-search heads to the board that changed', () => {
    for (const head of ['searchClimbs', 'infiniteSearchClimbs', 'searchClimbsCount']) {
      const filters = scopedInvalidateFilters([head], KILTER_1);
      expect(filters.queryKey).toEqual([head]);
      expect(filters.predicate?.({ queryKey: [head, { boardName: 'kilter', layoutId: 1 }] })).toBe(true);
      expect(filters.predicate?.({ queryKey: [head, { boardName: 'spray', layoutId: 36 }] })).toBe(false);
      // A user table names no board, so every list refreshes.
      expect(scopedInvalidateFilters([head], undefined)).toEqual({ queryKey: [head] });
    }
  });
});
