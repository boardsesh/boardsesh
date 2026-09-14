import { describe, it, expect } from 'vitest';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { SUPPORTED_BOARDS as PICKER_BOARDS } from '@boardsesh/board-config';
import { BOARD_FILTER_TYPES, BOARD_TYPES, LAYOUT_ORDER, getLayoutDisplayName, sortLayoutKeys } from '../layouts';

describe('BOARD_TYPES', () => {
  it('covers every board the schema knows, including spray', () => {
    // The profile hooks fan out one `userTicks` request per entry, so a board
    // missing here is a board whose ascents are never fetched — they vanish
    // from the logbook, the charts and the lifetime totals rather than showing
    // as zero.
    expect([...BOARD_TYPES].sort()).toEqual([...SUPPORTED_BOARDS].sort());
    expect(BOARD_TYPES).toContain('spray');
  });

  it('is the schema list, not the board-picker list', () => {
    // These two lists genuinely differ: the picker excludes spray outright and
    // gates MoonBoard on a feature flag. Ticks exist regardless of what a picker
    // offers, so the profile must read the wider list — and this assertion goes
    // red the moment someone swaps the import back.
    const missingFromPicker = [...SUPPORTED_BOARDS].filter((boardName) => !PICKER_BOARDS.includes(boardName));
    expect(missingFromPicker).not.toHaveLength(0);
    for (const boardName of missingFromPicker) {
      expect(BOARD_TYPES, boardName).toContain(boardName);
    }
  });
});

describe('BOARD_FILTER_TYPES', () => {
  it('offers no spray row — the filter would be permanently empty', () => {
    // Fetching spray ticks is right (they are ordinary ticks); offering a filter
    // for a board nobody can have one on is a dead control. SW-11 (#5444) gives
    // the filter a real spray story.
    expect(BOARD_FILTER_TYPES).not.toContain('spray');
  });

  it('is a subset of what the profile fetches', () => {
    // A filter row for a board we never fetch would select an always-empty view.
    for (const boardName of BOARD_FILTER_TYPES) {
      expect(BOARD_TYPES, boardName).toContain(boardName);
    }
  });
});

describe('getLayoutDisplayName', () => {
  it('names the Woods layout from the override, not from the Aurora tables', () => {
    // Woods is code-driven: `getLayout('woods', 1)` reads the generated layout
    // tables, which carry no Woods rows, so without the override every Woods
    // series on the profile charts would read "Woods (Layout 1)".
    expect(getLayoutDisplayName('woods', 1)).toBe('Woods Board');
  });

  it('still falls back for a layout no board knows about', () => {
    expect(getLayoutDisplayName('woods', 99)).toBe('Woods (Layout 99)');
  });

  it('keeps the Aurora and MoonBoard names it already had', () => {
    expect(getLayoutDisplayName('kilter', 1)).toBe('Kilter Original');
    expect(getLayoutDisplayName('moonboard', 2)).toBe('MoonBoard 2016');
  });
});

describe('LAYOUT_ORDER', () => {
  it('places Woods after the MoonBoard layouts rather than alphabetically', () => {
    expect(LAYOUT_ORDER).toContain('woods-1');
    expect(LAYOUT_ORDER.indexOf('woods-1')).toBeGreaterThan(LAYOUT_ORDER.indexOf('moonboard-5'));
    expect(sortLayoutKeys(['woods-1', 'kilter-1', 'moonboard-1'])).toEqual(['kilter-1', 'moonboard-1', 'woods-1']);
  });

  it('sorts an unordered key after every ordered one', () => {
    expect(sortLayoutKeys(['decoy-2', 'woods-1'])).toEqual(['woods-1', 'decoy-2']);
  });
});
