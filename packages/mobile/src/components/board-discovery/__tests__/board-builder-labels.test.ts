import { describe, it, expect } from 'vitest';
import {
  boardTypeLabel,
  cleanLayoutName,
  formatSizeLabel,
  formatSizeDimensions,
  formatDefaultBoardName,
} from '../board-builder-labels';

describe('boardTypeLabel', () => {
  it('uses trademark-correct names', () => {
    expect(boardTypeLabel('kilter')).toBe('Kilter');
    expect(boardTypeLabel('tension')).toBe('Tension');
    expect(boardTypeLabel('moonboard')).toBe('MoonBoard');
  });

  it('falls back to a capitalized name for unknown boards', () => {
    expect(boardTypeLabel('custom')).toBe('Custom');
  });
});

describe('cleanLayoutName', () => {
  it('strips the board-type prefix and "Board"', () => {
    expect(cleanLayoutName('Kilter Board Original', 'kilter')).toBe('Original');
    expect(cleanLayoutName('Kilter Board Homewall', 'kilter')).toBe('Homewall');
  });

  it('drops "Layout" and the "2" in Tension Board 2', () => {
    expect(cleanLayoutName('Original Layout', 'tension')).toBe('Original');
    expect(cleanLayoutName('Tension Board 2 Mirror', 'tension')).toBe('Mirror');
    expect(cleanLayoutName('Tension Board 2 Spray', 'tension')).toBe('Spray');
  });

  it('falls back to the raw name when cleaning empties it', () => {
    expect(cleanLayoutName('Kilter Board', 'kilter')).toBe('Kilter Board');
  });
});

describe('formatSizeLabel', () => {
  it('surfaces the kit description to disambiguate repeated dimensions', () => {
    expect(formatSizeLabel({ name: '10x12', description: 'Full Ride LED Kit' })).toBe('10×12 · Full Ride');
    expect(formatSizeLabel({ name: '10x12', description: 'Mainline LED Kit' })).toBe('10×12 · Mainline');
    expect(formatSizeLabel({ name: '10x12', description: 'Auxiliary LED Kit' })).toBe('10×12 · Auxiliary');
  });

  it('shows just the dimensions when there is no kit description', () => {
    expect(formatSizeLabel({ name: '12 high x 12 wide', description: '' })).toBe('12×12');
    expect(formatSizeLabel({ name: '7x10', description: null })).toBe('7×10');
  });
});

describe('formatSizeDimensions', () => {
  it('returns just the × dimensions', () => {
    expect(formatSizeDimensions({ name: '10x12' })).toBe('10×12');
    expect(formatSizeDimensions({ name: '12 high x 16 wide' })).toBe('12×16');
  });
});

describe('formatDefaultBoardName', () => {
  it('combines owner, board type, layout, and size dimensions', () => {
    expect(
      formatDefaultBoardName({
        userName: 'Marco',
        boardName: 'kilter',
        layoutName: 'Kilter Board Original',
        size: { name: '12x12' },
      }),
    ).toBe("Marco's Kilter Original 12×12");
  });

  it('drops the possessive when there is no user name', () => {
    expect(
      formatDefaultBoardName({
        userName: null,
        boardName: 'tension',
        layoutName: 'Tension Board 2 Mirror',
        size: { name: '12 high x 16 wide' },
      }),
    ).toBe('Tension Mirror 12×16');
  });

  it('omits the size when none is selected yet', () => {
    expect(
      formatDefaultBoardName({ userName: 'Sam', boardName: 'kilter', layoutName: 'Kilter Board Homewall', size: null }),
    ).toBe("Sam's Kilter Homewall");
  });
});
