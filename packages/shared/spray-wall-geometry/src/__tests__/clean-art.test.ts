// The generated wall looks: frame size, the hold mask and the warp.
//
// The warp is checked against points we can compute by hand: each anchor of
// the photo has to land on its corner of the canonical frame, and the identity
// map has to behave like a plain resize.
import { describe, expect, it } from 'vite-plus/test';
import { ART_CIRCLE_POINTS, artFeather, canonicalArtSize, holdMaskRings, warpBilinear } from '../clean-art';
import { IDENTITY_HOMOGRAPHY, type Quad, boundingSize, homographyFromAnchors, invert } from '../homography';

describe('canonicalArtSize', () => {
  it('keeps a frame under the cap at its own size', () => {
    expect(canonicalArtSize({ width: 1200, height: 900 })).toEqual({ width: 1200, height: 900, scale: 1 });
  });

  it('caps the long edge at 2048 and keeps the aspect', () => {
    const size = canonicalArtSize({ width: 4096, height: 3000 });
    expect(size.width).toBe(2048);
    expect(size.height).toBe(1500);
    expect(size.scale).toBe(0.5);
  });

  it('takes a custom cap', () => {
    expect(canonicalArtSize({ width: 1000, height: 2000 }, 500)).toEqual({ width: 250, height: 500, scale: 0.25 });
  });
});

describe('holdMaskRings', () => {
  it('uses the traced outline, in radius units around the centre, scaled', () => {
    const [ring] = holdMaskRings([{ cx: 100, cy: 200, r: 50, outline: [-1, 0, 0, -1, 1, 0, 0, 1] }], 0.5);
    expect(ring.points).toEqual([25, 100, 50, 75, 75, 100, 50, 125]);
    // 4% of a 25 px art radius rounds to 1.
    expect(ring.grow).toBe(1);
  });

  it('falls back to a 32-point circle for no outline or one under three points', () => {
    const rings = holdMaskRings(
      [
        { cx: 10, cy: 10, r: 5 },
        { cx: 10, cy: 10, r: 5, outline: [0, 1, 1, 0] },
        { cx: 10, cy: 10, r: 5, outline: [0, 1, 1, 0, Number.NaN, 1] },
      ],
      1,
    );
    expect(rings).toHaveLength(3);
    for (const ring of rings) {
      expect(ring.points).toHaveLength(ART_CIRCLE_POINTS * 2);
      // First point is at angle 0: (cx + r, cy).
      expect(ring.points[0]).toBeCloseTo(15);
      expect(ring.points[1]).toBeCloseTo(10);
    }
  });

  it('grows big holds by 4% of their radius', () => {
    const [ring] = holdMaskRings([{ cx: 0, cy: 0, r: 200 }], 1);
    expect(ring.grow).toBe(8);
  });

  it('skips a hold with no usable radius', () => {
    expect(holdMaskRings([{ cx: 0, cy: 0, r: 0 }], 1)).toEqual([]);
  });
});

describe('artFeather', () => {
  it('is 6% of the median radius in art pixels', () => {
    expect(artFeather([10, 100, 50], 1)).toBeCloseTo(3);
    expect(artFeather([40, 60], 0.5)).toBeCloseTo(1.5);
  });

  it('never drops below 1 px', () => {
    expect(artFeather([2, 3], 1)).toBe(1);
    expect(artFeather([100], 0.01)).toBe(1);
  });

  it('assumes a 10 px radius with no holds', () => {
    expect(artFeather([], 1)).toBe(1);
    expect(artFeather([], 10)).toBeCloseTo(6);
  });
});

/** A photo whose pixel value encodes its own coordinates, so a sample says where it came from. */
function gradientPhoto(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels[(y * width + x) * 2] = x;
      pixels[(y * width + x) * 2 + 1] = y;
    }
  }
  return pixels;
}

describe('warpBilinear', () => {
  it('is a plain copy under the identity at scale 1', () => {
    const photo = gradientPhoto(40, 30);
    expect(warpBilinear(photo, 40, 30, 2, IDENTITY_HOMOGRAPHY, 40, 30, 1)).toEqual(photo);
  });

  it('is a resize under the identity at scale 0.5', () => {
    const photo = gradientPhoto(40, 30);
    const out = warpBilinear(photo, 40, 30, 2, IDENTITY_HOMOGRAPHY, 20, 15, 0.5);
    // Destination pixel (5, 7) has its centre at canonical (11, 15), which is
    // halfway between source pixels 10 and 11 (x) and 14 and 15 (y).
    expect(out[(7 * 20 + 5) * 2]).toBe(11);
    expect(out[(7 * 20 + 5) * 2 + 1]).toBe(15);
  });

  it('lands each anchor on its corner of the frame', () => {
    const quad: Quad = [
      [20, 10],
      [180, 30],
      [170, 150],
      [30, 140],
    ];
    const frame = boundingSize(quad);
    const canonicalToPhoto = invert(homographyFromAnchors(quad, frame));
    const photo = gradientPhoto(200, 160);
    const out = warpBilinear(photo, 200, 160, 2, canonicalToPhoto, frame.width, frame.height, 1);
    const at = (x: number, y: number) => [out[(y * frame.width + x) * 2], out[(y * frame.width + x) * 2 + 1]];
    // Corner pixels sample half a pixel inside the frame, so allow a pixel or two.
    const corners: Array<[number, number, [number, number]]> = [
      [0, 0, quad[0]],
      [frame.width - 1, 0, quad[1]],
      [frame.width - 1, frame.height - 1, quad[2]],
      [0, frame.height - 1, quad[3]],
    ];
    for (const [x, y, [photoX, photoY]] of corners) {
      const [sampledX, sampledY] = at(x, y);
      expect(Math.abs(sampledX - photoX)).toBeLessThanOrEqual(2);
      expect(Math.abs(sampledY - photoY)).toBeLessThanOrEqual(2);
    }
  });

  it('leaves pixels that map outside the photo at zero', () => {
    const photo = new Uint8Array(10 * 10).fill(255);
    // Shift the canonical frame 20 px right of the photo.
    const out = warpBilinear(photo, 10, 10, 1, [1, 0, 20, 0, 1, 0, 0, 0, 1], 10, 10, 1);
    expect(out.every((value) => value === 0)).toBe(true);
  });

  it('refuses a source buffer shorter than its stated size', () => {
    expect(() => warpBilinear(new Uint8Array(3), 2, 2, 1, IDENTITY_HOMOGRAPHY, 1, 1, 1)).toThrow();
  });
});
