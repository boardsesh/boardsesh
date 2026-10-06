// The stretch gate on the generated wall looks.
//
// The two real walls are from the October 2026 spike: corner pins as fractions
// of the photo, and the photo's own pixel size. The spike's OpenCV run scored
// them 1.25 and 2.87; this port has to agree to within rounding.
import { describe, expect, it } from 'vite-plus/test';
import { ART_MIN_FRAME_SHORT_EDGE, ART_STRETCH_GOOD_MAX, ART_STRETCH_SOFT_MAX, photoQuality } from '../photo-quality';
import { IDENTITY_HOMOGRAPHY, type Quad, boundingSize, homographyFromAnchors } from '../homography';

function pinsInPixels(fractions: Array<[number, number]>, width: number, height: number): Quad {
  return fractions.map(([x, y]) => [x * width, y * height]);
}

const LUKE: Quad = pinsInPixels(
  [
    [0.0, 0.06],
    [1.0, 0.06],
    [0.93, 0.93],
    [0.08, 0.93],
  ],
  1788,
  2049,
);

const CHERRY_4: Quad = pinsInPixels(
  [
    [0.02, 0.27],
    [0.99, 0.24],
    [0.76, 0.78],
    [0.3, 0.78],
  ],
  1536,
  2048,
);

describe('photoQuality', () => {
  it('scores a rectangle of pins as no stretch at all', () => {
    const quad: Quad = [
      [100, 100],
      [1600, 100],
      [1600, 1300],
      [100, 1300],
    ];
    const quality = photoQuality(quad, boundingSize(quad));
    expect(quality.stretch).toBeCloseTo(1, 6);
    expect(quality.verdict).toBe('good');
    expect(quality.reason).toBe('ok');
  });

  it('matches the spike on a near front-on wall', () => {
    const frame = boundingSize(LUKE);
    const quality = photoQuality(homographyFromAnchors(LUKE, frame), frame);
    expect(quality.stretch).toBeGreaterThan(1.2);
    expect(quality.stretch).toBeLessThan(1.3);
    expect(quality.verdict).toBe('good');
  });

  it('matches the spike on a strongly keystoned wall, and fails it', () => {
    const frame = boundingSize(CHERRY_4);
    const quality = photoQuality(CHERRY_4, frame);
    expect(quality.stretch).toBeGreaterThan(2.8);
    expect(quality.stretch).toBeLessThan(2.95);
    expect(quality.stretch).toBeGreaterThan(ART_STRETCH_SOFT_MAX);
    expect(quality.verdict).toBe('fail');
    expect(quality.reason).toBe('keystone');
  });

  it('calls a moderate keystone soft', () => {
    // Top edge 60% of the bottom edge.
    const quad: Quad = [
      [400, 0],
      [1600, 0],
      [2000, 1500],
      [0, 1500],
    ];
    const quality = photoQuality(quad, boundingSize(quad));
    expect(quality.stretch).toBeGreaterThan(ART_STRETCH_GOOD_MAX);
    expect(quality.stretch).toBeLessThanOrEqual(ART_STRETCH_SOFT_MAX);
    expect(quality.verdict).toBe('soft');
  });

  it('fails a version with no pins', () => {
    const frame = { width: 2000, height: 1500 };
    expect(photoQuality(null, frame)).toMatchObject({ verdict: 'fail', reason: 'no-pins', stretch: null });
    expect(photoQuality([...IDENTITY_HOMOGRAPHY], frame)).toMatchObject({ verdict: 'fail', reason: 'no-pins' });
  });

  it('fails a frame whose short edge is under 1000 px', () => {
    const quad: Quad = [
      [0, 0],
      [1500, 0],
      [1500, ART_MIN_FRAME_SHORT_EDGE - 1],
      [0, ART_MIN_FRAME_SHORT_EDGE - 1],
    ];
    expect(photoQuality(quad, boundingSize(quad))).toMatchObject({
      verdict: 'fail',
      reason: 'small-frame',
      frameShortEdge: ART_MIN_FRAME_SHORT_EDGE - 1,
    });
  });

  it('keeps pins tapped on the photo corners: they solve to the identity and are still pins', () => {
    const quad: Quad = [
      [0, 0],
      [2000, 0],
      [2000, 1500],
      [0, 1500],
    ];
    expect(photoQuality(quad, boundingSize(quad))).toMatchObject({ verdict: 'good', reason: 'ok' });
  });

  it('fails a singular or malformed matrix instead of throwing', () => {
    const frame = { width: 2000, height: 1500 };
    expect(photoQuality([0, 0, 0, 0, 0, 0, 0, 0, 0], frame)).toMatchObject({ verdict: 'fail', reason: 'singular' });
    expect(photoQuality([1, 0, 0, 0, 1, Number.NaN, 0, 0, 1], frame)).toMatchObject({
      verdict: 'fail',
      reason: 'singular',
    });
  });
});
