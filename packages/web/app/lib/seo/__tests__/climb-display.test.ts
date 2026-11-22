import { describe, expect, it } from 'vite-plus/test';
import { boardConfigForSearch, climbBoardForSearch, climbGradeForSearch } from '../climb-display';

describe('readable climb search copy', () => {
  it('puts complete V grades first without losing the Font grade', () => {
    expect(climbGradeForSearch('6a/V3')).toBe('V3 (6a)');
    expect(climbGradeForSearch('V10/7c+')).toBe('V10 (7c+)');
    expect(climbGradeForSearch('V12')).toBe('V12');
    expect(climbGradeForSearch('7a')).toBe('7a');
  });
  it('uses a human board name once', () => {
    expect(climbBoardForSearch('kilter', 'Kilter Board Original')).toBe('Kilter Board Original');
    expect(climbBoardForSearch('tension', 'Original')).toBe('Tension Original');
    expect(climbBoardForSearch('moonboard')).toBe('MoonBoard');
  });
});

describe('board configuration search name', () => {
  it('names the layout and the size, so two sizes at one angle get two titles', () => {
    expect(
      boardConfigForSearch({
        board_name: 'kilter',
        layout_name: 'Kilter Board Original',
        size_name: '12 x 12 with kickboard',
      }),
    ).toBe('Kilter Board Original 12x12');
    expect(
      boardConfigForSearch({ board_name: 'kilter', layout_name: 'Kilter Board Original', size_name: '7 x 10' }),
    ).toBe('Kilter Board Original 7x10');
  });

  it('keeps a size name that is not a pair of dimensions', () => {
    expect(
      boardConfigForSearch({ board_name: 'tension', layout_name: 'Original Layout', size_name: 'Full Wall' }),
    ).toBe('Tension Original Layout Full Wall');
  });

  it('leaves out the placeholder size every MoonBoard layout shares', () => {
    expect(
      boardConfigForSearch({ board_name: 'moonboard', layout_name: 'MoonBoard 2016', size_name: 'Standard' }),
    ).toBe('MoonBoard 2016');
  });

  it('falls back to the board brand when the catalogue has no names', () => {
    expect(boardConfigForSearch({ board_name: 'kilter' })).toBe('Kilter');
  });
});
