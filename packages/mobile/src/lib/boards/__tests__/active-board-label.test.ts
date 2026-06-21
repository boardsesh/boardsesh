import { describe, it, expect, vi } from 'vitest';
import { formatActiveBoardLabel } from '../active-board-label';

vi.mock('@boardsesh/board-config', () => ({
  formatBoardDisplayName: (boardType: string) => `Display:${boardType}`,
}));

describe('formatActiveBoardLabel', () => {
  it('returns null when there is no active board', () => {
    expect(formatActiveBoardLabel(null)).toBeNull();
    expect(formatActiveBoardLabel(undefined)).toBeNull();
  });

  it('uses a trimmed custom board name with the angle when present', () => {
    expect(
      formatActiveBoardLabel({
        name: '  Garage Wall  ',
        angle: 40,
        boardType: 'kilter',
        sizeName: '12x12',
        layoutName: 'Homewall',
      }),
    ).toBe('Garage Wall • 40°');
  });

  it('falls back to display board name, size, and angle for unnamed boards', () => {
    expect(
      formatActiveBoardLabel({
        name: '   ',
        angle: 45,
        boardType: 'tension',
        sizeName: '12x12',
        layoutName: 'Spray',
      }),
    ).toBe('Display:tension • 12x12 • 45°');
  });

  it('uses the layout name when the size name is missing', () => {
    expect(
      formatActiveBoardLabel({
        angle: 25,
        boardType: 'moonboard',
        sizeName: null,
        layoutName: '2019',
      }),
    ).toBe('Display:moonboard • 2019 • 25°');
  });

  it('keeps zero degrees and omits missing optional labels', () => {
    expect(
      formatActiveBoardLabel({
        angle: 0,
        boardType: 'kilter',
        sizeName: null,
        layoutName: null,
      }),
    ).toBe('Display:kilter • 0°');
  });
});
