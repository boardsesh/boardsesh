import { describe, expect, it } from 'vitest';
import { shouldShowUnsetWallEmptyState } from '../unset-wall-empty-state';

const freshWall = { boardType: 'spray', isEmpty: true, query: '', activeFilterCount: 0 };

describe('shouldShowUnsetWallEmptyState', () => {
  it('shows the wall copy on a spray wall nobody has set on', () => {
    expect(shouldShowUnsetWallEmptyState(freshWall)).toBe(true);
  });

  it('stays out of the way while the list has rows', () => {
    expect(shouldShowUnsetWallEmptyState({ ...freshWall, isEmpty: false })).toBe(false);
  });

  it('keeps the generic copy on every catalogue board', () => {
    for (const boardType of ['kilter', 'tension', 'moonboard', 'woods', '']) {
      expect(shouldShowUnsetWallEmptyState({ ...freshWall, boardType })).toBe(false);
    }
  });

  // The honesty gates: a wall with climbs on it can come up empty for a search or
  // a grade range, and "no one's set on this wall yet" would then be false.
  it('keeps the generic copy when the climber is searching', () => {
    expect(shouldShowUnsetWallEmptyState({ ...freshWall, query: 'crimp' })).toBe(false);
  });

  it('keeps the generic copy when a filter is on', () => {
    expect(shouldShowUnsetWallEmptyState({ ...freshWall, activeFilterCount: 1 })).toBe(false);
  });
});
