import { describe, it, expect } from 'vitest';
import { ANGLES, MOONBOARD_LAYOUTS, MOONBOARD_SIZE, WOODS_LAYOUTS, WOODS_SIZES } from '@boardsesh/board-config';
import { CATALOGUE_BOARD_TYPES } from '@boardsesh/board-constants';
import type { BoardName } from '@boardsesh/shared-schema';
import { buildAngleOptions, buildLayoutOptions, buildSizeOptions, countSelectedSizeGroups } from '../filter-options';

describe('buildLayoutOptions', () => {
  it('is empty unless exactly one board type is selected', () => {
    expect(buildLayoutOptions({})).toEqual([]);
    expect(buildLayoutOptions({ boardTypes: ['kilter', 'tension'] })).toEqual([]);
  });

  it('lists every layout for the single selected board type', () => {
    const kilter = buildLayoutOptions({ boardTypes: ['kilter'] });
    expect(kilter.length).toBeGreaterThan(0);
    expect(kilter.every((option) => option.label.length > 0)).toBe(true);
  });

  it('covers the code-driven boards the Aurora-only helper misses', () => {
    expect(buildLayoutOptions({ boardTypes: ['woods'] })).toEqual([
      { id: WOODS_LAYOUTS.woods.id, label: WOODS_LAYOUTS.woods.name },
    ]);
    expect(buildLayoutOptions({ boardTypes: ['moonboard'] })).toHaveLength(Object.keys(MOONBOARD_LAYOUTS).length);
  });

  it('offers at least one layout for every catalogue board type', () => {
    for (const boardType of CATALOGUE_BOARD_TYPES) {
      expect(buildLayoutOptions({ boardTypes: [boardType as BoardName] }).length).toBeGreaterThan(0);
    }
  });

  it('is empty for a spray wall — there is nothing to cascade', () => {
    expect(buildLayoutOptions({ boardTypes: ['spray'] })).toEqual([]);
  });
});

describe('buildSizeOptions', () => {
  it('is empty unless exactly one board type AND one layout are selected', () => {
    expect(buildSizeOptions({ boardTypes: ['kilter'] })).toEqual([]);
    expect(buildSizeOptions({ boardTypes: ['kilter'], layoutIds: [1, 8] })).toEqual([]);
  });

  it('groups sizes sharing a display name into one chip carrying every id', () => {
    const options = buildSizeOptions({ boardTypes: ['kilter'], layoutIds: [8] });
    expect(options.length).toBeGreaterThan(0);
    // The Homewall ships several LED-kit variants under one set of dimensions;
    // a climber choosing a gym does not pick between them.
    expect(options.some((option) => option.sizeIds.length > 1)).toBe(true);
    expect(new Set(options.map((option) => option.label)).size).toBe(options.length);
  });

  it("offers both Woods sizes and MoonBoard's single one", () => {
    const woods = buildSizeOptions({ boardTypes: ['woods'], layoutIds: [WOODS_LAYOUTS.woods.id] });
    const ascending = (left: number, right: number) => left - right;
    expect(woods.flatMap((option) => option.sizeIds).sort(ascending)).toEqual(
      Object.values(WOODS_SIZES)
        .map((size) => size.id)
        .sort(ascending),
    );
    const moonboard = buildSizeOptions({
      boardTypes: ['moonboard'],
      layoutIds: [MOONBOARD_LAYOUTS['moonboard-2016'].id],
    });
    expect(moonboard.flatMap((option) => option.sizeIds)).toEqual([MOONBOARD_SIZE.id]);
  });

  it('stays empty for a layout the selected board type does not have', () => {
    expect(buildSizeOptions({ boardTypes: ['woods'], layoutIds: [9999] })).toEqual([]);
    expect(buildSizeOptions({ boardTypes: ['spray'], layoutIds: [1] })).toEqual([]);
  });
});

describe('buildAngleOptions', () => {
  it('is empty unless exactly one board type is selected', () => {
    expect(buildAngleOptions({})).toEqual([]);
    expect(buildAngleOptions({ boardTypes: ['kilter', 'moonboard'] })).toEqual([]);
  });

  it('offers the Aurora ladder for Kilter', () => {
    expect(buildAngleOptions({ boardTypes: ['kilter'] }).map((option) => option.angle)).toEqual([...ANGLES.kilter]);
  });

  it('offers exactly [25, 40] for MoonBoard — never the flag-gated wide list', () => {
    // The directory is anonymous and cache-backed: a shareable URL must not
    // depend on whether the reader has `moonboard-wide-angles` switched on.
    expect(buildAngleOptions({ boardTypes: ['moonboard'] }).map((option) => option.angle)).toEqual([25, 40]);
  });

  it("keeps Grasshopper's negative angle", () => {
    const angles = buildAngleOptions({ boardTypes: ['grasshopper'] }).map((option) => option.angle);
    expect(angles[0]).toBe(-5);
  });

  it('starts Woods at 20', () => {
    expect(buildAngleOptions({ boardTypes: ['woods'] })[0]?.angle).toBe(20);
  });

  it('is not empty for any catalogue board type', () => {
    for (const boardType of CATALOGUE_BOARD_TYPES) {
      expect(buildAngleOptions({ boardTypes: [boardType as BoardName] }).length).toBeGreaterThan(0);
    }
  });
});

describe('countSelectedSizeGroups', () => {
  it('counts one click as one, however many Aurora ids it carries', () => {
    const grouped = buildSizeOptions({ boardTypes: ['kilter'], layoutIds: [8] }).find(
      (option) => option.sizeIds.length > 1,
    );
    expect(grouped).toBeDefined();
    expect(countSelectedSizeGroups({ boardTypes: ['kilter'], layoutIds: [8], sizeIds: grouped!.sizeIds })).toBe(1);
  });

  it('counts two chips as two', () => {
    const options = buildSizeOptions({ boardTypes: ['kilter'], layoutIds: [8] });
    const sizeIds = [...options[0].sizeIds, ...options[1].sizeIds];
    expect(countSelectedSizeGroups({ boardTypes: ['kilter'], layoutIds: [8], sizeIds })).toBe(2);
  });

  it('is zero with nothing selected, and never zero while filtering', () => {
    expect(countSelectedSizeGroups({ boardTypes: ['kilter'], layoutIds: [8] })).toBe(0);
    // An id the current option tree cannot place still counts as a decision, or
    // a stale link would claim no active filters while narrowing the list.
    expect(countSelectedSizeGroups({ boardTypes: ['kilter'], layoutIds: [8], sizeIds: [999999] })).toBe(1);
  });
});
