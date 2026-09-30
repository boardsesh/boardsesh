import { describe, expect, it } from 'vitest';
import { getBoardLayouts, getBoardSetsForLayoutAndSize, getDefaultBoardSizeForLayout } from '@boardsesh/board-config';
import { getBoardGeometry, litHolds } from './board-geometry';

describe('getBoardGeometry', () => {
  it('draws each installed MoonBoard hold set, without the light background art', () => {
    const geometry = getBoardGeometry({ boardName: 'moonboard', layoutId: 2, sizeId: 1, setIds: [2, 3] });
    expect(geometry).not.toBeNull();
    expect(geometry?.imagePaths).toEqual([
      'moonboard/moonboard2016/holdseta.webp',
      'moonboard/moonboard2016/holdsetb.webp',
    ]);
    expect(geometry?.width).toBe(650);
    expect(geometry?.height).toBe(1000);
    // 11 columns × 18 rows.
    expect(geometry?.holds.size).toBe(198);
    expect(geometry?.grid).toMatchObject({ columns: 11, rowTop: 18 });
  });

  it('crops a Mini MoonBoard to its 12 rows', () => {
    const geometry = getBoardGeometry({ boardName: 'moonboard', layoutId: 7, sizeId: 1, setIds: [28] });
    expect(geometry?.grid?.rowTop).toBe(12);
  });

  it('places A1 bottom-left and K18 top-right on the MoonBoard', () => {
    const geometry = getBoardGeometry({ boardName: 'moonboard', layoutId: 2, sizeId: 1, setIds: [2] });
    const a1 = geometry?.holds.get(1);
    const k18 = geometry?.holds.get(198);
    expect(a1 && k18).toBeTruthy();
    if (!a1 || !k18) return;
    expect(a1.cx).toBeLessThan(k18.cx);
    expect(a1.cy).toBeGreaterThan(k18.cy);
  });

  it('draws a Woods board from its dark art, for both sizes', () => {
    const small = getBoardGeometry({ boardName: 'woods', layoutId: 1, sizeId: 1, setIds: [1] });
    const big = getBoardGeometry({ boardName: 'woods', layoutId: 1, sizeId: 2, setIds: [1] });
    expect(small?.imagePaths).toEqual(['woods/woods-8x10-bg.dark.webp']);
    expect(big?.imagePaths).toEqual(['woods/woods-12x12-bg.dark.webp']);
    expect(small?.holds.size).toBeGreaterThan(0);
    expect((big?.holds.size ?? 0) > (small?.holds.size ?? 0)).toBe(true);
    expect(getBoardGeometry({ boardName: 'woods', layoutId: 1, sizeId: 9, setIds: [1] })).toBeNull();
  });

  it('builds the other Aurora brands from their catalogue photos', () => {
    const [layout] = getBoardLayouts('decoy');
    const sizeId = getDefaultBoardSizeForLayout('decoy', layout.id) ?? 0;
    const setIds = getBoardSetsForLayoutAndSize('decoy', layout.id, sizeId).map((set) => set.id);
    const geometry = getBoardGeometry({ boardName: 'decoy', layoutId: layout.id, sizeId, setIds });
    expect(geometry?.imagePaths[0]).toMatch(/^decoy\/product_sizes_layouts_sets\/.+\.webp$/);
    expect(geometry?.holds.size).toBeGreaterThan(0);
  });

  it('builds a Tension board from its catalogue photos and holds', () => {
    const [layout] = getBoardLayouts('tension');
    const sizeId = getDefaultBoardSizeForLayout('tension', layout.id) ?? 0;
    const setIds = getBoardSetsForLayoutAndSize('tension', layout.id, sizeId).map((set) => set.id);
    const geometry = getBoardGeometry({ boardName: 'tension', layoutId: layout.id, sizeId, setIds });
    expect(geometry).not.toBeNull();
    expect(geometry?.imagePaths.length).toBe(setIds.length);
    expect(geometry?.imagePaths.every((path) => path.startsWith('tension/') && path.endsWith('.webp'))).toBe(true);
    expect(geometry?.holds.size).toBeGreaterThan(0);
  });

  it('returns null for a size the board does not have', () => {
    expect(getBoardGeometry({ boardName: 'moonboard', layoutId: 2, sizeId: 99, setIds: [2] })).toBeNull();
  });
});

describe('litHolds', () => {
  it('reads MoonBoard start, hand and finish holds', () => {
    const geometry = getBoardGeometry({ boardName: 'moonboard', layoutId: 2, sizeId: 1, setIds: [2, 3] });
    if (!geometry) throw new Error('expected MoonBoard geometry');
    const holds = litHolds(geometry, 'moonboard', 'p1r42p45r43p198r44');
    expect(holds.map((hold) => [hold.id, hold.role])).toEqual([
      [1, 'start'],
      [45, 'hand'],
      [198, 'finish'],
    ]);
  });

  it('skips holds the board does not have and unknown roles', () => {
    const geometry = getBoardGeometry({ boardName: 'moonboard', layoutId: 2, sizeId: 1, setIds: [2] });
    if (!geometry) throw new Error('expected MoonBoard geometry');
    expect(litHolds(geometry, 'moonboard', 'p999r42p5r99')).toEqual([]);
  });
});
