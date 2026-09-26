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

  it('reads a { input } wrapper and a boardType spelling', () => {
    expect(
      queryKeyMatchesBoardScope(['similarClimbs', { input: { boardType: 'kilter', layoutId: 1 } }], KILTER_1),
    ).toBe(true);
  });

  it('refreshes a key that names no board', () => {
    expect(queryKeyMatchesBoardScope(['holdHeatmap'], KILTER_1)).toBe(true);
  });
});

describe('scopedInvalidateFilters', () => {
  it('adds a predicate only to board-scoped heads with a known board', () => {
    expect(scopedInvalidateFilters(['holdHeatmap'], KILTER_1).predicate).toBeTypeOf('function');
    expect(scopedInvalidateFilters(['searchClimbs'], KILTER_1)).toEqual({ queryKey: ['searchClimbs'] });
    expect(scopedInvalidateFilters(['holdHeatmap'], undefined)).toEqual({ queryKey: ['holdHeatmap'] });
  });
});
