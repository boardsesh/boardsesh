import { describe, it, expect } from 'vitest';
import {
  clampPaceSeconds,
  roundedReportPaceSeconds,
  roundedReportSpeed,
  shouldReportPaceSeconds,
  shouldReportSpeed,
  valueToTrackPosition,
  MAX_PACE_SECONDS,
  MIN_PACE_SECONDS,
} from '../playback-speed-report';

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
    // 0.1x..10x over 300px = 0.033x/px. Endpoints are exact.
    expect(roundedReportSpeed(0, USABLE)).toBe(0.1);
    expect(roundedReportSpeed(USABLE, USABLE)).toBe(10);
    // Mid-track lands at (0.1 + 0.5 * 9.9) = 5.05; Math.round(50.5) = 51 → 5.1.
    expect(roundedReportSpeed(USABLE / 2, USABLE)).toBe(5.1);
  });

  it('reports far fewer times than the frame count over a sub-pixel-per-frame drag', () => {
    // 60 frames of 1px each = 60px of travel ≈ 2.0x. One report per 0.1x step,
    // so ~20 reports vs 60 frames — never one per frame.
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
    // 0.033x/px, so a 1px nudge near the same spot can stay in one bucket.
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

// The creator authors the climb's own cadence in seconds per frame, over a
// different range (0.3–10s) than the reader's multiplier. Same gate, its own
// pair — using the speed pair for a pace drag would report values the pill never
// shows, because the two ranges don't line up.

/** Replay a pace drag through its gate, the way `reportsForDrag` does for speed. */
function paceReportsForDrag(pixels: number[]): number[] {
  let lastReported = -1;
  const reported: number[] = [];
  for (const px of pixels) {
    const { rounded, changed } = shouldReportPaceSeconds(px, USABLE, lastReported);
    if (changed) {
      lastReported = rounded;
      reported.push(rounded);
    }
  }
  return reported;
}

describe('shouldReportPaceSeconds gate', () => {
  it('spans the authored pace range, endpoints exact', () => {
    expect(roundedReportPaceSeconds(0, USABLE)).toBe(MIN_PACE_SECONDS);
    expect(roundedReportPaceSeconds(USABLE, USABLE)).toBe(MAX_PACE_SECONDS);
    // A thumb dragged past either end clamps rather than running off the range.
    expect(roundedReportPaceSeconds(-40, USABLE)).toBe(MIN_PACE_SECONDS);
    expect(roundedReportPaceSeconds(USABLE + 40, USABLE)).toBe(MAX_PACE_SECONDS);
    // Never below 0.3s: MIN_PACE_MS (200ms) is the BLE throughput floor and an
    // authored pace has to keep headroom above it.
    expect(MIN_PACE_SECONDS).toBeGreaterThan(0.2);
  });

  it('reports far fewer times than the frame count over a slow drag', () => {
    // 0.3–10s over 300px = 0.032s/px, so ~3px per 0.1s bucket: a 60-frame,
    // 1px-per-frame drag must cost ~20 hops, not 60.
    const pixels = Array.from({ length: 60 }, (_, index) => index + 1);
    const reported = paceReportsForDrag(pixels);

    expect(reported.length).toBeGreaterThan(0);
    expect(reported.length).toBeLessThan(pixels.length);
    for (let index = 1; index < reported.length; index += 1) {
      expect(reported[index]).not.toBe(reported[index - 1]);
    }
  });

  it('does not report while several frames stay inside one 0.1s bucket', () => {
    let lastReported = roundedReportPaceSeconds(100, USABLE);
    const decisions = [100, 100, 100, 100].map((px) => {
      const result = shouldReportPaceSeconds(px, USABLE, lastReported);
      if (result.changed) lastReported = result.rounded;
      return result.changed;
    });
    expect(decisions.filter(Boolean)).toHaveLength(0);
  });

  it('still reports every distinct 0.1s step', () => {
    // ~0.032s/px, so 6px apart is always a fresh bucket.
    const distinctPixels = [0, 6, 12, 18, 24];
    const reported = paceReportsForDrag(distinctPixels);
    expect(new Set(reported).size).toBe(reported.length);
    expect(reported.length).toBe(distinctPixels.length);
  });
});

describe('clampPaceSeconds', () => {
  it('holds an authored pace inside 0.3-10s', () => {
    expect(clampPaceSeconds(0.05)).toBe(MIN_PACE_SECONDS);
    expect(clampPaceSeconds(60)).toBe(MAX_PACE_SECONDS);
    expect(clampPaceSeconds(1.5)).toBe(1.5);
  });

  it('passes the 0.75s default through untouched', () => {
    // The slider's release-magnet lands on DEFAULT_PACE_MS exactly; a clamp that
    // also rounded to a tenth would turn the app default into 800ms.
    expect(clampPaceSeconds(0.75)).toBe(0.75);
  });

  it('falls back to the floor for a value that is not a number', () => {
    expect(clampPaceSeconds(Number.NaN)).toBe(MIN_PACE_SECONDS);
  });
});

// The inverse mapping. It exists because a CANCELLED drag never reaches
// `onEnd`: nothing commits, the mirrored value never moves, and the effect that
// would resync the pill therefore never re-fires — so the gesture has to put
// both the thumb and the pill back itself.
describe('valueToTrackPosition', () => {
  const USABLE = 200;

  it('puts the ends of the range at the ends of the track', () => {
    expect(valueToTrackPosition(MIN_PACE_SECONDS, MIN_PACE_SECONDS, MAX_PACE_SECONDS, USABLE)).toBe(0);
    expect(valueToTrackPosition(MAX_PACE_SECONDS, MIN_PACE_SECONDS, MAX_PACE_SECONDS, USABLE)).toBe(USABLE);
  });

  it('round-trips against the position-to-value mapping the drag reports', () => {
    // The two directions live in one module precisely so they cannot drift.
    // Values on the 0.1 display grid: the reporter rounds to a tenth, which is
    // exactly why `clampPaceSeconds` does not (see its note on the 0.75s magnet).
    for (const seconds of [0.3, 0.8, 1.5, 4, 10]) {
      const px = valueToTrackPosition(seconds, MIN_PACE_SECONDS, MAX_PACE_SECONDS, USABLE);
      expect(roundedReportPaceSeconds(px, USABLE)).toBe(seconds);
    }
  });

  it('puts the magnet default back on the track, rounding only for display', () => {
    // 0.75s is DEFAULT_PACE_MS and the release magnet, so a cancelled drag has
    // to restore that exact position — the pill may render it as 0.8s.
    const px = valueToTrackPosition(0.75, MIN_PACE_SECONDS, MAX_PACE_SECONDS, USABLE);
    expect(px).toBeCloseTo((0.45 / (MAX_PACE_SECONDS - MIN_PACE_SECONDS)) * USABLE, 5);
    expect(roundedReportPaceSeconds(px, USABLE)).toBe(0.8);
  });

  it('holds a value from outside the range on the track', () => {
    expect(valueToTrackPosition(-5, MIN_PACE_SECONDS, MAX_PACE_SECONDS, USABLE)).toBe(0);
    expect(valueToTrackPosition(999, MIN_PACE_SECONDS, MAX_PACE_SECONDS, USABLE)).toBe(USABLE);
  });

  it('collapses to zero before layout has given the track a width', () => {
    // `usable` is 0 until onLayout lands; without this the thumb would jump.
    expect(valueToTrackPosition(5, MIN_PACE_SECONDS, MAX_PACE_SECONDS, 0)).toBe(0);
    expect(valueToTrackPosition(5, MIN_PACE_SECONDS, MAX_PACE_SECONDS, -10)).toBe(0);
  });

  it('does not divide by a zero span', () => {
    expect(valueToTrackPosition(3, 2, 2, USABLE)).toBe(0);
  });
});
