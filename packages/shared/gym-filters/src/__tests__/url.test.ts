import { describe, it, expect } from 'vitest';
import { appendGymBoardFilterParams, parseGymBoardFilter, toGymBoardFilterInput } from '../url';
import type { GymBoardFilter } from '../filter-state';

/** Round-trip helper: state -> URL string -> state. */
function roundTrip(filter: GymBoardFilter): GymBoardFilter {
  const params = new URLSearchParams();
  appendGymBoardFilterParams(params, filter);
  const asSearchParams: Record<string, string[]> = {};
  for (const key of new Set(params.keys())) asSearchParams[key] = params.getAll(key);
  return parseGymBoardFilter(asSearchParams);
}

describe('round trip', () => {
  const cases: GymBoardFilter[] = [
    {},
    { boardTypes: ['kilter'] },
    { boardTypes: ['kilter', 'tension'] },
    { boardTypes: ['kilter'], layoutIds: [8] },
    { boardTypes: ['kilter'], layoutIds: [8], sizeIds: [23, 24] },
    { boardTypes: ['kilter'], angles: [40] },
    { boardTypes: ['kilter'], layoutIds: [8], angles: [40, 45] },
    { boardTypes: ['grasshopper'], angles: [-5] },
    { boardTypes: ['moonboard'], angles: [25, 40] },
  ];

  it.each(cases)('survives %j', (filter) => {
    const parsed = roundTrip(filter);
    expect(parsed.boardTypes).toEqual(filter.boardTypes);
    expect(parsed.layoutIds).toEqual(filter.layoutIds);
    expect(parsed.sizeIds).toEqual(filter.sizeIds);
    expect(parsed.angles).toEqual(filter.angles);
  });
});

describe('the cascade gates what is even parseable', () => {
  it('drops a layout with no board type to scope it', () => {
    expect(parseGymBoardFilter({ layout: '8' }).layoutIds).toBeUndefined();
  });

  it('drops a layout under two board types', () => {
    // Layout id 1 is Kilter Original AND Touchstone Winter 2020 AND Grasshopper
    // 2020 AND So iLL Summer 2024; the resolver's `layout_id IN (...)` carries no
    // board-type scoping, so this would be a wrong answer, not a narrow one.
    const parsed = parseGymBoardFilter({ boardType: ['kilter', 'tension'], layout: '1' });
    expect(parsed.layoutIds).toBeUndefined();
  });

  it('drops a layout the board type does not have', () => {
    expect(parseGymBoardFilter({ boardType: 'kilter', layout: '999999' }).layoutIds).toBeUndefined();
  });

  it('drops a size with no single layout to scope it', () => {
    expect(parseGymBoardFilter({ boardType: 'kilter', size: '23' }).sizeIds).toBeUndefined();
    expect(parseGymBoardFilter({ boardType: 'kilter', layout: ['1', '8'], size: '23' }).sizeIds).toBeUndefined();
  });

  it('keeps angles across a two-layout selection — they hang off the board type', () => {
    const parsed = parseGymBoardFilter({ boardType: 'kilter', layout: ['1', '8'], angle: '40' });
    expect(parsed.layoutIds).toEqual([1, 8]);
    expect(parsed.angles).toEqual([40]);
  });
});

describe('illegal values are dropped, never forwarded', () => {
  it('rejects an angle the board cannot be set to', () => {
    expect(parseGymBoardFilter({ boardType: 'kilter', angle: '41' }).angles).toBeUndefined();
    expect(parseGymBoardFilter({ boardType: 'kilter', angle: '-5' }).angles).toBeUndefined();
    expect(parseGymBoardFilter({ boardType: 'moonboard', angle: '45' }).angles).toBeUndefined();
  });

  it('accepts the negative angle only where it exists', () => {
    expect(parseGymBoardFilter({ boardType: 'grasshopper', angle: '-5' }).angles).toEqual([-5]);
  });

  it('rejects non-canonical integer spellings', () => {
    for (const bad of ['1.5', 'abc', '', ' 8', '08', '+8', '1e1', 'NaN', 'Infinity']) {
      expect(parseGymBoardFilter({ boardType: 'kilter', layout: bad }).layoutIds).toBeUndefined();
    }
  });

  it('rejects a board type nobody has built, and spray', () => {
    expect(parseGymBoardFilter({ boardType: 'soill-deluxe' }).boardTypes).toBeUndefined();
    // A spray wall is one climber's own wall, never a directory facet.
    expect(parseGymBoardFilter({ boardType: 'spray' }).boardTypes).toBeUndefined();
  });

  it('caps a crafted URL before it walks the catalogue', () => {
    const angles = Array.from({ length: 500 }, () => '40');
    expect(parseGymBoardFilter({ boardType: 'kilter', angle: angles }).angles).toEqual([40]);
    const layouts = Array.from({ length: 500 }, (_, index) => String(index));
    // Only ids inside the first slice can survive, so the result is bounded.
    expect((parseGymBoardFilter({ boardType: 'kilter', layout: layouts }).layoutIds ?? []).length).toBeLessThanOrEqual(
      20,
    );
  });
});

describe('normalisation keeps one selection to one URL', () => {
  it('dedupes and sorts ids', () => {
    expect(parseGymBoardFilter({ boardType: 'kilter', angle: ['45', '40', '40'] }).angles).toEqual([40, 45]);
  });

  it('spells the same selection the same way whatever order it arrived in', () => {
    const first = parseGymBoardFilter({ boardType: ['tension', 'kilter'], angle: ['45', '40'] });
    const second = parseGymBoardFilter({ boardType: ['kilter', 'tension'], angle: ['40', '45'] });
    const render = (filter: GymBoardFilter) => {
      const params = new URLSearchParams();
      appendGymBoardFilterParams(params, filter);
      return params.toString();
    };
    expect(render(first)).toBe(render(second));
  });
});

describe('lockedBoardTypes — the facet routes', () => {
  it('pins the board type and ignores any ?boardType= in the URL', () => {
    const parsed = parseGymBoardFilter({ boardType: 'tension' }, { lockedBoardTypes: ['kilter'] });
    expect(parsed.boardTypes).toEqual(['kilter']);
  });

  it('unlocks the layout tier with no query param at all', () => {
    const parsed = parseGymBoardFilter({ layout: '8' }, { lockedBoardTypes: ['kilter'] });
    expect(parsed.layoutIds).toEqual([8]);
  });

  it('omitBoardTypes keeps the board type in the path, not the query', () => {
    const params = new URLSearchParams();
    appendGymBoardFilterParams(params, { boardTypes: ['kilter'], layoutIds: [8] }, { omitBoardTypes: true });
    expect(params.toString()).toBe('layout=8');
  });
});

describe('toGymBoardFilterInput', () => {
  it('omits empty arrays so the emitted SQL is unchanged for existing callers', () => {
    expect(toGymBoardFilterInput({})).toEqual({});
    expect(toGymBoardFilterInput({ boardTypes: [], layoutIds: [], sizeIds: [], angles: [] })).toEqual({});
  });

  it('forwards every set term', () => {
    expect(
      toGymBoardFilterInput({
        boardTypes: ['kilter'],
        layoutIds: [8],
        sizeIds: [23, 24],
        angles: [40],
        multiBoardTypeOnly: true,
      }),
    ).toEqual({
      boardTypes: ['kilter'],
      layoutIds: [8],
      sizeIds: [23, 24],
      angles: [40],
      multiBoardTypeOnly: true,
    });
  });
});
