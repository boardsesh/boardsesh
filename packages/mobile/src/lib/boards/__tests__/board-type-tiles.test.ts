import { describe, expect, it } from 'vitest';
import type { BoardName, PopularBoardConfig } from '@boardsesh/shared-schema';
import { SUPPORTED_BOARDS } from '@boardsesh/board-config';
import { boardTypeArt, boardTypeTilesFit, splitBoardTypes } from '../board-type-tiles';
import { boardTypeLabel } from '../../../components/board-discovery/board-builder-labels';

describe('splitBoardTypes', () => {
  it('tiles MoonBoard, Kilter and Tension, and lists the rest by name', () => {
    const { featured, others } = splitBoardTypes(SUPPORTED_BOARDS, boardTypeLabel);
    expect(featured).toEqual(['moonboard', 'kilter', 'tension']);
    expect(others.map(boardTypeLabel)).toEqual(others.map(boardTypeLabel).sort((a, b) => a.localeCompare(b)));
    // Every catalogue type is offered once, and spray never.
    expect(new Set([...featured, ...others])).toEqual(new Set(SUPPORTED_BOARDS));
    expect([...featured, ...others]).not.toContain('spray');
  });

  it('never draws an empty tile for a type the build leaves out', () => {
    const withoutMoonboard: BoardName[] = ['kilter', 'tension', 'decoy'];
    expect(splitBoardTypes(withoutMoonboard, boardTypeLabel)).toEqual({
      featured: ['kilter', 'tension'],
      others: ['decoy'],
    });
  });
});

describe('boardTypeArt', () => {
  it('draws the setup Set up will open on: the most used one', () => {
    const popular = [
      { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: [1, 20] },
    ] as unknown as PopularBoardConfig[];
    expect(boardTypeArt('kilter', popular)).toEqual({ boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20' });
  });

  it("falls back to the catalogue's first layout and size, with every set, before the list lands", () => {
    for (const boardName of SUPPORTED_BOARDS) {
      const art = boardTypeArt(boardName, undefined);
      expect(art?.boardType).toBe(boardName);
      expect(art?.setIds.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('boardTypeTilesFit', () => {
  it.each([
    { width: 320, fontScale: 1, fits: false },
    { width: 375, fontScale: 1, fits: true },
    { width: 402, fontScale: 1.3, fits: true },
    { width: 402, fontScale: 1.4, fits: false },
  ])('$width pt at $fontScale: $fits', ({ width, fontScale, fits }) => {
    expect(boardTypeTilesFit(width, fontScale)).toBe(fits);
  });
});
