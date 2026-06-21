import { describe, it, expect } from 'vitest';
import { roundedReportSpeed, shouldReportSpeed } from '../playback-speed-report';

// The pan `onUpdate` worklet runs ~60 frames/s. `shouldReportSpeed` is the gate
// that keeps `runOnJS(reportLive)` (→ setLiveSpeed React state) from firing on
// every frame: it reports only when the 0.1×-rounded display speed changes.

const USABLE = 300; // 320px track - 20px thumb, the real geometry.

/** Replay a drag (a px sequence) through the gate, threading lastReported the
 *  way the worklet threads its shared value, and collect the reported speeds. */
function reportsForDrag(pixels: number[]): number[] {
  // Seed to a value the first frame can't equal so the first real frame reports.
  let lastReported = -1;
  const reported: number[] = [];
  for (const px of pixels) {
    const { rounded, changed } = shouldReportSpeed(px, USABLE, lastReported);
    if (changed) {
      lastReported = rounded;
      reported.push(rounded);
    }
  }
  return reported;
}

describe('shouldReportSpeed gate', () => {
  it('matches the displayed 0.1x-rounded speed', () => {
    // 0.5x..10x over 300px ≈ 0.0317x/px. Endpoints are exact.
    expect(roundedReportSpeed(0, USABLE)).toBe(0.5);
    expect(roundedReportSpeed(USABLE, USABLE)).toBe(10);
    // Mid-track lands at (0.5 + 0.5 * 9.5) = 5.25; Math.round(52.5) = 53 → 5.3.
    expect(roundedReportSpeed(USABLE / 2, USABLE)).toBe(5.3);
  });

  it('reports far fewer times than the frame count over a sub-pixel-per-frame drag', () => {
    // 60 frames of 1px each = 60px of travel ≈ 1.9x. One report per 0.1x step,
    // so ~19 reports vs 60 frames — never one per frame.
    const pixels = Array.from({ length: 60 }, (_, index) => index + 1);
    const reported = reportsForDrag(pixels);

    expect(reported.length).toBeGreaterThan(0);
    expect(reported.length).toBeLessThan(pixels.length);
    // The gate's contract: no two consecutive reports carry the same value.
    for (let index = 1; index < reported.length; index += 1) {
      expect(reported[index]).not.toBe(reported[index - 1]);
    }
  });

  it('does not report when several frames stay within the same 0.1x bucket', () => {
    // ~0.0317x/px, so a 1px nudge near the same spot can stay in one bucket.
    // Frames at the same px never re-report; the first reports, the rest skip.
    let lastReported = roundedReportSpeed(100, USABLE);
    const decisions = [101, 100, 100, 101].map((px) => {
      const result = shouldReportSpeed(px, USABLE, lastReported);
      if (result.changed) lastReported = result.rounded;
      return result.changed;
    });
    // The repeated 100/101 frames that resolve to the same bucket must not all
    // report; at most the boundary crossings do.
    expect(decisions.filter(Boolean).length).toBeLessThan(decisions.length);
  });

  it('still reports every distinct 0.1x step (no coarsening of the live label)', () => {
    // Walk px positions chosen to land on distinct 0.1 buckets and assert each
    // produces a fresh report — the gate must not skip real value changes.
    const distinctPixels = [0, 20, 40, 60, 80]; // ~0.5, 1.1, 1.8, 2.4, 3.0 → all distinct
    const reported = reportsForDrag(distinctPixels);
    expect(new Set(reported).size).toBe(reported.length);
    expect(reported.length).toBe(distinctPixels.length);
  });
});
