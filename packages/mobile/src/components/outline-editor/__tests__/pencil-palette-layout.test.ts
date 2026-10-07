import { describe, expect, it } from 'vitest';
import {
  PENCIL_PALETTE_BUTTON_SIZE,
  PENCIL_PALETTE_EDGE_MARGIN,
  PENCIL_PALETTE_RADIUS,
  pencilPaletteCentre,
  pencilPaletteOffsets,
} from '../pencil-palette-layout';

const REACH = PENCIL_PALETTE_RADIUS + PENCIL_PALETTE_BUTTON_SIZE / 2 + PENCIL_PALETTE_EDGE_MARGIN;
const IPAD = { areaWidth: 1180, areaHeight: 820 };

describe('pencilPaletteCentre', () => {
  it('opens under the Pencil tip when there is room', () => {
    expect(pencilPaletteCentre({ x: 600, y: 400, ...IPAD })).toEqual({ x: 600, y: 400 });
  });

  it('pulls in from every edge so no button leaves the screen', () => {
    expect(pencilPaletteCentre({ x: 5, y: 10, ...IPAD })).toEqual({ x: REACH, y: REACH });
    expect(pencilPaletteCentre({ x: 1179, y: 819, ...IPAD })).toEqual({
      x: IPAD.areaWidth - REACH,
      y: IPAD.areaHeight - REACH,
    });
  });

  it('opens mid-screen when the Pencil was not hovering', () => {
    expect(pencilPaletteCentre({ x: null, y: null, ...IPAD })).toEqual({ x: 590, y: 410 });
  });

  it('centres in a space too small for the whole ring', () => {
    expect(pencilPaletteCentre({ x: 10, y: 10, areaWidth: 150, areaHeight: 900 })).toEqual({ x: 75, y: REACH });
  });
});

describe('pencilPaletteOffsets', () => {
  it('starts straight above the tip and spaces the buttons evenly round it', () => {
    const offsets = pencilPaletteOffsets(5);
    expect(offsets).toHaveLength(5);
    expect(offsets[0]).toEqual({ dx: 0, dy: -PENCIL_PALETTE_RADIUS });
    for (const { dx, dy } of offsets) {
      expect(Math.hypot(dx, dy)).toBeCloseTo(PENCIL_PALETTE_RADIUS, 1);
    }
    // Clockwise on screen: the second button is up and to the right.
    expect(offsets[1].dx).toBeGreaterThan(0);
    expect(offsets[1].dy).toBeLessThan(0);
  });

  it('keeps neighbouring buttons from overlapping', () => {
    const offsets = pencilPaletteOffsets(5);
    for (let index = 0; index < offsets.length; index += 1) {
      const next = offsets[(index + 1) % offsets.length];
      const gap = Math.hypot(next.dx - offsets[index].dx, next.dy - offsets[index].dy);
      expect(gap).toBeGreaterThan(PENCIL_PALETTE_BUTTON_SIZE);
    }
  });
});
