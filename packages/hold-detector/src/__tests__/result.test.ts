import { describe, expect, it } from 'vitest';
import { detectionProposal } from '../result';
import type { DetectResult } from '../detect';

const result = (): DetectResult => ({
  photo: { width: 800, height: 600 },
  holds: [{ cx: 100, cy: 200, r: 10, score: 0.8 }],
  boxes: [[90, 190, 110, 210]],
  threshold: 0.6,
  stats: { holdCount: 1, outlineCount: 0, tiles: 4 },
  timings: { decodeMs: 1, inferMs: 2, postMs: 1 },
});
describe('durable detection proposals', () => {
  it('keeps photo-pixel geometry and confidence', () => {
    expect(detectionProposal(result(), { width: 800, height: 600 }).candidates).toEqual([
      { cx: 100, cy: 200, r: 10, confidence: 0.8, outline: null },
    ]);
  });
  it('refuses results for a differently oriented photo', () => {
    expect(() => detectionProposal(result(), { width: 600, height: 800 })).toThrow('PHOTO_DIMENSION_MISMATCH');
  });
  it.each([NaN, Infinity, -1, 801])('rejects invalid coordinates: %s', (cx) => {
    const detected = result();
    detected.holds[0].cx = cx;
    expect(() => detectionProposal(detected, detected.photo)).toThrow('INVALID_CANDIDATE');
  });
  it('keeps a circle when the outline is degenerate', () => {
    const detected = result();
    detected.holds[0].outline = [0, 0, 0, 0, 0, 0];
    expect(detectionProposal(detected, detected.photo).candidates[0].outline).toBeNull();
  });
  it('accepts a genuine zero-detection result without inventing holds', () => {
    const detected = result();
    detected.holds = [];
    expect(detectionProposal(detected, detected.photo).candidates).toEqual([]);
  });
});
