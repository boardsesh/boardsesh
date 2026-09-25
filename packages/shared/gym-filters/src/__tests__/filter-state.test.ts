import { describe, it, expect } from 'vitest';
import {
  EMPTY_GYM_BOARD_FILTER,
  clearBoardFilters,
  hasActiveBoardFilter,
  setBoardTypesFilter,
  toggleAngleFilter,
  toggleBoardTypeFilter,
  toggleLayoutFilter,
  toggleMultiBoardTypeFilter,
  toggleSizeFilter,
  type GymBoardFilter,
} from '../filter-state';

describe('hasActiveBoardFilter', () => {
  it('is inactive by default', () => {
    expect(hasActiveBoardFilter(EMPTY_GYM_BOARD_FILTER)).toBe(false);
    expect(hasActiveBoardFilter({ boardTypes: [], layoutIds: [], sizeIds: [], angles: [] })).toBe(false);
  });

  it('is active for any single term, angles included', () => {
    expect(hasActiveBoardFilter({ boardTypes: ['kilter'] })).toBe(true);
    expect(hasActiveBoardFilter({ layoutIds: [8] })).toBe(true);
    expect(hasActiveBoardFilter({ sizeIds: [23] })).toBe(true);
    expect(hasActiveBoardFilter({ angles: [40] })).toBe(true);
    expect(hasActiveBoardFilter({ multiBoardTypeOnly: true })).toBe(true);
  });
});

describe('the board-type tier invalidates everything below it', () => {
  const narrowed: GymBoardFilter = {
    boardTypes: ['kilter'],
    layoutIds: [8],
    sizeIds: [23],
    angles: [40],
  };

  it('clears layouts, sizes AND angles going from one board type to two', () => {
    const widened = toggleBoardTypeFilter(narrowed, 'tension');
    expect(widened.boardTypes).toEqual(['kilter', 'tension']);
    expect(widened.layoutIds).toBeUndefined();
    expect(widened.sizeIds).toBeUndefined();
    expect(widened.angles).toBeUndefined();
  });

  it('clears them going from two board types back to one, too', () => {
    // The deeper tiers were never scoped to the survivor, so landing on one
    // board type does not make a stale layout id meaningful.
    const two: GymBoardFilter = { boardTypes: ['kilter', 'tension'], layoutIds: [8], sizeIds: [23], angles: [40] };
    const narrowedAgain = toggleBoardTypeFilter(two, 'tension');
    expect(narrowedAgain.boardTypes).toEqual(['kilter']);
    expect(narrowedAgain.layoutIds).toBeUndefined();
    expect(narrowedAgain.sizeIds).toBeUndefined();
    expect(narrowedAgain.angles).toBeUndefined();
  });

  it('clears them when the last board type is removed', () => {
    const cleared = toggleBoardTypeFilter(narrowed, 'kilter');
    expect(cleared.boardTypes).toBeUndefined();
    expect(cleared.layoutIds).toBeUndefined();
    expect(cleared.angles).toBeUndefined();
  });

  it('setBoardTypesFilter replaces rather than merges, and dedupes', () => {
    const replaced = setBoardTypesFilter(narrowed, ['moonboard']);
    expect(replaced.boardTypes).toEqual(['moonboard']);
    expect(replaced.layoutIds).toBeUndefined();
    expect(replaced.angles).toBeUndefined();
    expect(setBoardTypesFilter(EMPTY_GYM_BOARD_FILTER, ['kilter', 'kilter']).boardTypes).toEqual(['kilter']);
  });
});

describe('toggleLayoutFilter', () => {
  it('adds and removes a layout (OR)', () => {
    const added = toggleLayoutFilter({ boardTypes: ['tension'] }, 9);
    expect(added.layoutIds).toEqual([9]);
    expect(toggleLayoutFilter(added, 9).layoutIds).toBeUndefined();
  });

  it('clears the size tier when no longer exactly one layout', () => {
    const two = toggleLayoutFilter({ boardTypes: ['tension'], layoutIds: [9], sizeIds: [1] }, 10);
    expect(two.layoutIds).toEqual([9, 10]);
    expect(two.sizeIds).toBeUndefined();
  });

  it('does NOT clear angles — angles hang off the board type, which has not moved', () => {
    const two = toggleLayoutFilter({ boardTypes: ['tension'], layoutIds: [9], angles: [40] }, 10);
    expect(two.angles).toEqual([40]);
    const one = toggleLayoutFilter({ boardTypes: ['tension'], layoutIds: [9, 10], angles: [40] }, 10);
    expect(one.angles).toEqual([40]);
  });
});

describe('toggleSizeFilter', () => {
  it('adds a whole id group, then removes it on a second toggle', () => {
    const added = toggleSizeFilter(EMPTY_GYM_BOARD_FILTER, [23, 24]);
    expect(added.sizeIds).toEqual([23, 24]);
    expect(toggleSizeFilter(added, [23, 24]).sizeIds).toBeUndefined();
  });

  it('fills in a partially-selected group rather than removing it', () => {
    expect(toggleSizeFilter({ sizeIds: [23] }, [23, 24]).sizeIds).toEqual([23, 24]);
  });
});

describe('toggleAngleFilter', () => {
  it('adds and removes an angle (OR)', () => {
    const added = toggleAngleFilter({ boardTypes: ['kilter'] }, 40);
    expect(added.angles).toEqual([40]);
    expect(toggleAngleFilter(added, 40).angles).toBeUndefined();
  });

  it('accumulates several angles and touches no other tier', () => {
    const both = toggleAngleFilter({ boardTypes: ['kilter'], layoutIds: [8], sizeIds: [23], angles: [40] }, 45);
    expect(both.angles).toEqual([40, 45]);
    expect(both.layoutIds).toEqual([8]);
    expect(both.sizeIds).toEqual([23]);
  });
});

describe('toggleMultiBoardTypeFilter', () => {
  it('flips the restriction on and off without disturbing the cascade', () => {
    const on = toggleMultiBoardTypeFilter({ boardTypes: ['kilter'], layoutIds: [8] });
    expect(on.multiBoardTypeOnly).toBe(true);
    expect(on.layoutIds).toEqual([8]);
    expect(toggleMultiBoardTypeFilter(on).multiBoardTypeOnly).toBeUndefined();
  });
});

describe('clearBoardFilters', () => {
  it('clears every board term', () => {
    const cleared = clearBoardFilters({
      boardTypes: ['kilter'],
      layoutIds: [8],
      sizeIds: [23],
      angles: [40],
      multiBoardTypeOnly: true,
    });
    expect(hasActiveBoardFilter(cleared)).toBe(false);
  });
});

describe('generic over the carrier', () => {
  // This is the property that lets www call these on a whole DirectoryQuery and
  // mobile on a WallFinderFilter, instead of each unpacking the board half.
  type Carrier = GymBoardFilter & { page: number; query: string };

  it('preserves fields the shared package has never heard of', () => {
    const carrier: Carrier = { page: 3, query: 'bristol', boardTypes: ['kilter'], layoutIds: [8], angles: [40] };
    const widened = toggleBoardTypeFilter(carrier, 'tension');
    expect(widened.page).toBe(3);
    expect(widened.query).toBe('bristol');
    expect(widened.layoutIds).toBeUndefined();

    const cleared = clearBoardFilters(carrier);
    expect(cleared.page).toBe(3);
    expect(cleared.query).toBe('bristol');
  });
});
