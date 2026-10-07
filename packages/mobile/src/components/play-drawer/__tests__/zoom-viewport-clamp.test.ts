import { describe, expect, it } from 'vitest';
import { clampTranslation } from '@boardsesh/play-view';
import { clampAxisTranslation, transformOriginInViewport } from '../zoom-viewport-clamp';

/** Where the zoomed photo's leading edge lands for a translate, in viewport points. */
function leadingEdge(translation: number, scale: number, renderExtent: number, offset: number): number {
  return offset + renderExtent / 2 + translation - (scale * renderExtent) / 2;
}

describe('clampAxisTranslation without a viewport', () => {
  it('is exactly the old render-box clamp across a sweep of scales, sizes and pans', () => {
    for (const extent of [1, 199.5, 360, 393, 640, 852.33]) {
      for (const scale of [0.5, 1, 1.0001, 1.5, 2, Math.PI, 4, 7.25, 8]) {
        for (const translation of [-5000, -321.7, -1, -0, 0, 0.3, 12, 480, 5000]) {
          const old = clampTranslation(translation, translation, scale, extent, extent).x;
          expect(clampAxisTranslation(translation, scale, extent, 0, 0, extent)).toBe(old);
        }
      }
    }
  });

  it('caps the pan at ±(s − 1)·r / 2', () => {
    expect(clampAxisTranslation(1000, 3, 300, 0, 0, 300)).toBe(300);
    expect(clampAxisTranslation(-1000, 3, 300, 0, 0, 300)).toBe(-300);
    expect(clampAxisTranslation(120, 3, 300, 0, 0, 300)).toBe(120);
  });
});

describe('clampAxisTranslation with a viewport', () => {
  // A 390-wide editor, a 300-wide photo centred in it, the whole width visible.
  const renderExtent = 300;
  const offset = 45;
  const bandStart = 0;
  const bandEnd = 390;

  it('does not pan at all at 1x or below', () => {
    expect(clampAxisTranslation(80, 1, renderExtent, offset, bandStart, bandEnd)).toBe(0);
    expect(clampAxisTranslation(-80, 0.6, renderExtent, offset, bandStart, bandEnd)).toBe(0);
  });

  it('lets the photo’s leading edge reach the band’s start and no further', () => {
    const scale = 4;
    const translation = clampAxisTranslation(1e6, scale, renderExtent, offset, bandStart, bandEnd);
    expect(leadingEdge(translation, scale, renderExtent, offset)).toBeCloseTo(bandStart, 9);
  });

  it('lets the photo’s trailing edge reach the band’s end and no further', () => {
    const scale = 4;
    const translation = clampAxisTranslation(-1e6, scale, renderExtent, offset, bandStart, bandEnd);
    const trailingEdge = leadingEdge(translation, scale, renderExtent, offset) + scale * renderExtent;
    expect(trailingEdge).toBeCloseTo(bandEnd, 9);
  });

  it('keeps a photo smaller than the band anywhere inside it', () => {
    // 1.1 × 300 = 330, narrower than the 390 band: it may slide but never leave.
    const scale = 1.1;
    const scaled = scale * renderExtent;
    const furthestRight = clampAxisTranslation(1e6, scale, renderExtent, offset, bandStart, bandEnd);
    const furthestLeft = clampAxisTranslation(-1e6, scale, renderExtent, offset, bandStart, bandEnd);
    expect(leadingEdge(furthestRight, scale, renderExtent, offset) + scaled).toBeCloseTo(bandEnd, 9);
    expect(leadingEdge(furthestLeft, scale, renderExtent, offset)).toBeCloseTo(bandStart, 9);
    // A small pan inside that room is left alone.
    expect(clampAxisTranslation(5, scale, renderExtent, offset, bandStart, bandEnd)).toBe(5);
  });

  it('keeps the 1x position reachable just past 1x, so zooming out never jumps', () => {
    const nearlyOne = 1.000001;
    expect(clampAxisTranslation(0, nearlyOne, renderExtent, offset, bandStart, bandEnd)).toBe(0);
  });

  it('handles a band that stops short of the viewport (the bottom bar’s reserve)', () => {
    // A 600-tall photo at y = 30 in an 844-tall editor whose bars cover the
    // bottom 124 points: the band is [0, 720].
    const extent = 600;
    const top = 30;
    const scale = 3;
    const lowest = clampAxisTranslation(-1e6, scale, extent, top, 0, 720);
    const highest = clampAxisTranslation(1e6, scale, extent, top, 0, 720);
    expect(leadingEdge(lowest, scale, extent, top) + scale * extent).toBeCloseTo(720, 9);
    expect(leadingEdge(highest, scale, extent, top)).toBeCloseTo(0, 9);
    // Asymmetric: the band's middle is not the photo's centre.
    expect(Math.abs(lowest)).not.toBeCloseTo(Math.abs(highest), 3);
  });

  it('clamps an in-range translation to itself', () => {
    expect(clampAxisTranslation(-37.5, 2, renderExtent, offset, bandStart, bandEnd)).toBe(-37.5);
  });
});

describe('transformOriginInViewport', () => {
  it('is the render box centre without a viewport', () => {
    expect(transformOriginInViewport(0, 360)).toBe(180);
  });

  it('is the fitted photo’s centre inside a viewport', () => {
    expect(transformOriginInViewport(45, 300)).toBe(195);
  });
});
