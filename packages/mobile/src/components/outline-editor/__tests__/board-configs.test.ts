import { describe, expect, it } from 'vitest';
import { BOARD_DISPLAY_ORDER } from '@boardsesh/shared-schema';
import { outlineEditorLayouts, outlineEditorSetIds, outlineEditorSizes } from '../board-configs';

describe('outlineEditorLayouts', () => {
  it('lists at least one layout for every supported board', () => {
    for (const boardName of BOARD_DISPLAY_ORDER) {
      expect(outlineEditorLayouts(boardName).length, boardName).toBeGreaterThan(0);
    }
  });

  it('covers MoonBoard and Woods, which carry no Aurora product-size rows', () => {
    expect(outlineEditorLayouts('moonboard').map((layout) => layout.name)).toContain('MoonBoard 2024');
    expect(outlineEditorLayouts('woods')).toEqual([{ id: 1, name: 'Original' }]);
  });
});

describe('outlineEditorSizes', () => {
  it('lists at least one size for every board’s first layout', () => {
    for (const boardName of BOARD_DISPLAY_ORDER) {
      const firstLayout = outlineEditorLayouts(boardName)[0];
      expect(outlineEditorSizes(boardName, firstLayout.id).length, boardName).toBeGreaterThan(0);
    }
  });

  it('keeps the two Woods boards apart — their hold ids mean different things', () => {
    expect(outlineEditorSizes('woods', 1).map((size) => size.id)).toEqual([1, 2]);
  });
});

describe('outlineEditorSetIds', () => {
  it('returns every set of the layout and size, comma separated', () => {
    // MoonBoard 2016 ships three sets; a shard is traced with all of them.
    expect(outlineEditorSetIds('moonboard', 2, 1)).toBe('2,3,4');
  });

  it('returns the synthetic Woods set', () => {
    expect(outlineEditorSetIds('woods', 1, 2)).toBe('1');
  });

  it('returns the Aurora sets of a real Kilter config', () => {
    expect(outlineEditorSetIds('kilter', 1, 28).length).toBeGreaterThan(0);
  });
});
