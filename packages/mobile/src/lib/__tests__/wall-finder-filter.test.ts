import { describe, it, expect } from 'vitest';
import {
  MOONBOARD_LAYOUTS,
  MOONBOARD_SIZE,
  SUPPORTED_BOARDS,
  WOODS_LAYOUTS,
  WOODS_SIZES,
} from '@boardsesh/board-config';
import {
  DEFAULT_WALL_FINDER_FILTER,
  hasActiveWallFinderFilter,
  toggleBoardTypeFilter,
  toggleLayoutFilter,
  toggleSizeFilter,
  toggleMultiBoardTypeFilter,
  clearWallFinderChipFilters,
  buildLayoutOptions,
  buildSizeOptions,
} from '../wall-finder-filter';

describe('hasActiveWallFinderFilter', () => {
  it('is inactive by default and for a bare place relocation', () => {
    expect(hasActiveWallFinderFilter(DEFAULT_WALL_FINDER_FILTER)).toBe(false);
    // A place is a relocate action, not a filter term.
    expect(hasActiveWallFinderFilter({ place: 'Tokyo' })).toBe(false);
  });

  it('is active with a name, board types, layouts, sizes, or the multi-board toggle', () => {
    expect(hasActiveWallFinderFilter({ name: 'movement' })).toBe(true);
    expect(hasActiveWallFinderFilter({ boardTypes: ['kilter'] })).toBe(true);
    expect(hasActiveWallFinderFilter({ layoutIds: [1] })).toBe(true);
    expect(hasActiveWallFinderFilter({ sizeIds: [11] })).toBe(true);
    expect(hasActiveWallFinderFilter({ multiBoardTypeOnly: true })).toBe(true);
    // Empty values are not "active".
    expect(hasActiveWallFinderFilter({ name: '' })).toBe(false);
    expect(hasActiveWallFinderFilter({ boardTypes: [] })).toBe(false);
    expect(hasActiveWallFinderFilter({ layoutIds: [], sizeIds: [] })).toBe(false);
  });
});

describe('toggleBoardTypeFilter', () => {
  it('adds and removes a board type (OR)', () => {
    expect(toggleBoardTypeFilter({}, 'kilter')).toEqual({ boardTypes: ['kilter'] });
    expect(toggleBoardTypeFilter({ boardTypes: ['kilter'] }, 'kilter')).toEqual({ boardTypes: undefined });
  });

  it('clears layout + size tiers when no longer exactly one board type', () => {
    // Adding a second type drops the deeper, type-scoped tiers.
    expect(toggleBoardTypeFilter({ boardTypes: ['kilter'], layoutIds: [1], sizeIds: [11] }, 'tension')).toEqual({
      boardTypes: ['kilter', 'tension'],
      layoutIds: undefined,
      sizeIds: undefined,
    });
    // Removing the only type drops them too.
    expect(toggleBoardTypeFilter({ boardTypes: ['kilter'], layoutIds: [1], sizeIds: [11] }, 'kilter')).toEqual({
      boardTypes: undefined,
      layoutIds: undefined,
      sizeIds: undefined,
    });
  });
});

describe('toggleLayoutFilter', () => {
  it('adds and removes a layout (OR)', () => {
    expect(toggleLayoutFilter({ boardTypes: ['kilter'] }, 1)).toEqual({ boardTypes: ['kilter'], layoutIds: [1] });
    expect(toggleLayoutFilter({ boardTypes: ['kilter'], layoutIds: [1] }, 1)).toEqual({
      boardTypes: ['kilter'],
      layoutIds: undefined,
    });
  });

  it('clears the size tier when no longer exactly one layout', () => {
    expect(toggleLayoutFilter({ layoutIds: [1], sizeIds: [11] }, 2)).toEqual({
      layoutIds: [1, 2],
      sizeIds: undefined,
    });
    expect(toggleLayoutFilter({ layoutIds: [1], sizeIds: [11] }, 1)).toEqual({
      layoutIds: undefined,
      sizeIds: undefined,
    });
  });
});

describe('toggleSizeFilter', () => {
  it('adds a whole id group, then removes it on a second toggle', () => {
    const added = toggleSizeFilter({}, [21, 22]);
    expect(added).toEqual({ sizeIds: [21, 22] });
    expect(toggleSizeFilter(added, [21, 22])).toEqual({ sizeIds: undefined });
  });

  it('fills in a partially-selected group rather than removing it', () => {
    expect(toggleSizeFilter({ sizeIds: [21] }, [21, 22])).toEqual({ sizeIds: [21, 22] });
  });
});

describe('toggleMultiBoardTypeFilter', () => {
  it('flips the multi-board-type restriction on and off', () => {
    expect(toggleMultiBoardTypeFilter({})).toEqual({ multiBoardTypeOnly: true });
    expect(toggleMultiBoardTypeFilter({ multiBoardTypeOnly: true })).toEqual({ multiBoardTypeOnly: undefined });
  });
});

describe('clearWallFinderChipFilters', () => {
  it('clears every chip filter but keeps the name/place search', () => {
    expect(
      clearWallFinderChipFilters({
        name: 'movement',
        place: 'Tokyo',
        boardTypes: ['kilter'],
        layoutIds: [1],
        sizeIds: [11],
        multiBoardTypeOnly: true,
      }),
    ).toEqual({
      name: 'movement',
      place: 'Tokyo',
      boardTypes: undefined,
      layoutIds: undefined,
      sizeIds: undefined,
      multiBoardTypeOnly: undefined,
    });
  });
});

describe('buildLayoutOptions', () => {
  it('is empty unless exactly one board type is selected', () => {
    expect(buildLayoutOptions({})).toEqual([]);
    expect(buildLayoutOptions({ boardTypes: ['kilter', 'tension'] })).toEqual([]);
  });

  it('lists every layout for the single selected board type', () => {
    const options = buildLayoutOptions({ boardTypes: ['kilter'] });
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(typeof option.id).toBe('number');
      expect(typeof option.label).toBe('string');
      expect(option.label.length).toBeGreaterThan(0);
    }
  });

  // Woods and MoonBoard are code-driven: they have no rows in the generated
  // LAYOUTS table, so the Aurora-only accessor these builders used to call
  // returned nothing and their chip rows came up empty (#4751).
  it('lists the single Woods layout', () => {
    expect(buildLayoutOptions({ boardTypes: ['woods'] })).toEqual([{ id: WOODS_LAYOUTS.woods.id, label: 'Original' }]);
  });

  it('lists every MoonBoard layout', () => {
    expect(buildLayoutOptions({ boardTypes: ['moonboard'] })).toEqual(
      Object.values(MOONBOARD_LAYOUTS).map((layout) => ({ id: layout.id, label: layout.name })),
    );
  });

  // The regression guard the two cases above exist to generalise: a board added
  // to SUPPORTED_BOARDS without a layout source silently ships an empty chip row,
  // which reads as a broken filter rather than an absent one.
  it('offers at least one layout for every supported board type', () => {
    for (const boardType of SUPPORTED_BOARDS) {
      expect(buildLayoutOptions({ boardTypes: [boardType] }).length).toBeGreaterThan(0);
    }
  });
});

describe('buildSizeOptions', () => {
  it('is empty unless exactly one board type AND one layout are selected', () => {
    expect(buildSizeOptions({ boardTypes: ['kilter'] })).toEqual([]);
    expect(buildSizeOptions({ boardTypes: ['kilter'], layoutIds: [1, 2] })).toEqual([]);
  });

  it('groups a real board type + layout into size chips carrying their ids', () => {
    // Derive a valid layout id from the same data source the screen uses.
    const [layout] = buildLayoutOptions({ boardTypes: ['kilter'] });
    expect(layout).toBeDefined();
    const options = buildSizeOptions({ boardTypes: ['kilter'], layoutIds: [layout.id] });
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(typeof option.label).toBe('string');
      expect(option.sizeIds.length).toBeGreaterThan(0);
    }
  });

  // Both Woods sizes, as separate chips — an 8x10 climb can't be queued onto a
  // 12x12 board, so the two must never collapse into one label. Ids come from
  // the catalogue (a renumber there is not this builder's business); the labels
  // stay literal because grouping BY label is the behaviour under test, and
  // deriving both sides would make the assertion tautological.
  it('offers both Woods sizes under the Woods layout', () => {
    expect(buildSizeOptions({ boardTypes: ['woods'], layoutIds: [WOODS_LAYOUTS.woods.id] })).toEqual([
      { label: '8 x 10', sizeIds: [WOODS_SIZES['8x10'].id] },
      { label: '12 x 12', sizeIds: [WOODS_SIZES['12x12'].id] },
    ]);
  });

  it("offers MoonBoard's single size under a MoonBoard layout", () => {
    expect(
      buildSizeOptions({ boardTypes: ['moonboard'], layoutIds: [MOONBOARD_LAYOUTS['moonboard-2024'].id] }),
    ).toEqual([{ label: 'Standard', sizeIds: [MOONBOARD_SIZE.id] }]);
  });

  it('stays empty for a layout the selected board type does not have', () => {
    expect(buildSizeOptions({ boardTypes: ['woods'], layoutIds: [999] })).toEqual([]);
    expect(buildSizeOptions({ boardTypes: ['moonboard'], layoutIds: [999] })).toEqual([]);
  });
});
