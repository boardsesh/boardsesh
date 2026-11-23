import { describe, it, expect } from 'vite-plus/test';
import { SearchGymsInputSchema } from '../validation/schemas/gyms';
import { SearchBoardsInputSchema } from '../validation/schemas/boards';

// The board-type filter (gym + board search) is enforced in SQL — a gym→board
// EXISTS join for gyms, an inArray for boards. These tests cover the input
// contract those queries depend on: the `boardTypes` array must accept valid
// board names, reject junk, and stay optional so unfiltered search is unchanged.

describe('SearchGymsInput board-type filter', () => {
  it('accepts a multi-select array of valid board types', () => {
    const parsed = SearchGymsInputSchema.parse({ boardTypes: ['kilter', 'tension'] });
    expect(parsed.boardTypes).toEqual(['kilter', 'tension']);
  });

  it('stays optional — an unfiltered search leaves boardTypes undefined', () => {
    expect(SearchGymsInputSchema.parse({}).boardTypes).toBeUndefined();
  });

  it('rejects an unknown board type', () => {
    expect(SearchGymsInputSchema.safeParse({ boardTypes: ['not-a-board'] }).success).toBe(false);
  });
});

describe('SearchBoardsInput board-type filter', () => {
  it('accepts a multi-select array of valid board types', () => {
    const parsed = SearchBoardsInputSchema.parse({ boardTypes: ['kilter'] });
    expect(parsed.boardTypes).toEqual(['kilter']);
  });

  it('still accepts the legacy singular boardType alongside the array', () => {
    const parsed = SearchBoardsInputSchema.parse({ boardType: 'tension', boardTypes: ['kilter'] });
    expect(parsed.boardType).toBe('tension');
    expect(parsed.boardTypes).toEqual(['kilter']);
  });

  it('rejects an unknown board type', () => {
    expect(SearchBoardsInputSchema.safeParse({ boardTypes: ['nope'] }).success).toBe(false);
  });
});

// The layout/size filters compose into the same gym→board EXISTS join (gyms) and
// inArray conditions (boards). These cover the input contract: numeric-id arrays
// that stay optional, plus the gym-only multiBoardTypeOnly flag.

describe('SearchGymsInput layout/size/multi-board filters', () => {
  it('accepts layoutIds and sizeIds as numeric-id arrays', () => {
    const parsed = SearchGymsInputSchema.parse({ boardTypes: ['kilter'], layoutIds: [1, 8], sizeIds: [11, 12] });
    expect(parsed.layoutIds).toEqual([1, 8]);
    expect(parsed.sizeIds).toEqual([11, 12]);
  });

  it('accepts multiBoardTypeOnly as a boolean', () => {
    expect(SearchGymsInputSchema.parse({ multiBoardTypeOnly: true }).multiBoardTypeOnly).toBe(true);
  });

  it('stays optional — an unfiltered search leaves the new fields undefined', () => {
    const parsed = SearchGymsInputSchema.parse({});
    expect(parsed.layoutIds).toBeUndefined();
    expect(parsed.sizeIds).toBeUndefined();
    expect(parsed.multiBoardTypeOnly).toBeUndefined();
  });

  it('rejects non-integer or negative ids', () => {
    expect(SearchGymsInputSchema.safeParse({ layoutIds: [1.5] }).success).toBe(false);
    expect(SearchGymsInputSchema.safeParse({ sizeIds: [-1] }).success).toBe(false);
  });
});

describe('SearchBoardsInput layout/size filters', () => {
  it('accepts layoutIds and sizeIds as numeric-id arrays', () => {
    const parsed = SearchBoardsInputSchema.parse({ boardTypes: ['kilter'], layoutIds: [1], sizeIds: [11] });
    expect(parsed.layoutIds).toEqual([1]);
    expect(parsed.sizeIds).toEqual([11]);
  });

  it('stays optional — an unfiltered search leaves them undefined', () => {
    const parsed = SearchBoardsInputSchema.parse({});
    expect(parsed.layoutIds).toBeUndefined();
    expect(parsed.sizeIds).toBeUndefined();
  });

  it('rejects non-integer ids', () => {
    expect(SearchBoardsInputSchema.safeParse({ sizeIds: [2.2] }).success).toBe(false);
  });
});

describe('SearchBoardsInput angle filter', () => {
  it('accepts exact angles including overhanging and slab walls', () => {
    expect(SearchBoardsInputSchema.parse({ angles: [-90, -5, 0, 40, 90] }).angles).toEqual([-90, -5, 0, 40, 90]);
  });

  it('keeps omitted and empty angles unfiltered', () => {
    expect(SearchBoardsInputSchema.parse({}).angles).toBeUndefined();
    expect(SearchBoardsInputSchema.parse({ angles: [] }).angles).toEqual([]);
  });

  it.each([{ angles: [-91] }, { angles: [91] }, { angles: [40.5] }, { angles: Array.from({ length: 51 }, () => 40) }])(
    'rejects invalid angles $angles',
    ({ angles }) => {
      expect(SearchBoardsInputSchema.safeParse({ angles }).success).toBe(false);
    },
  );
});
