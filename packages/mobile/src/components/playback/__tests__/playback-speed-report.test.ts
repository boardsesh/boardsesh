import { describe, it, expect } from 'vitest';
import {
  clampPaceSeconds,
  paceNotch,
  paceRatioForSeconds,
  paceSecondsAtNotchOffset,
  paceSecondsAtRatio,
  roundPaceSeconds,
  roundedReportPaceSeconds,
  shouldReportPaceSeconds,
  snapToMagnet,
  valueToTrackPosition,
  MAX_PACE_SECONDS,
  MIN_PACE_SECONDS,
} from '../playback-speed-report';

// The pan `onUpdate` worklet runs ~60 frames/s. `shouldReportPaceSeconds` is the
// gate that keeps `runOnJS(reportLive)` (-> setLiveValue React state) from firing
// on every frame: it reports only when the DISPLAYED pace changes.

const USABLE = 300; // 320px track - 20px thumb, the real geometry.

/** Replay a drag (a px sequence) through the gate, threading lastReported the
 *  way the worklet threads its shared value, and collect the reported paces. */
function paceReportsForDrag(pixels: number[]): number[] {
  // Seed to a value the first frame can't equal so the first real frame reports.
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

describe('the log track', () => {
  it('puts the ends of the range at the ends of the track', () => {
    expect(paceSecondsAtRatio(0)).toBeCloseTo(MIN_PACE_SECONDS, 10);
    expect(paceSecondsAtRatio(1)).toBeCloseTo(MAX_PACE_SECONDS, 10);
    expect(paceRatioForSeconds(MIN_PACE_SECONDS)).toBeCloseTo(0, 10);
    expect(paceRatioForSeconds(MAX_PACE_SECONDS)).toBeCloseTo(1, 10);
  });

  it('round-trips a pace through the track position', () => {
    for (const seconds of [0.3, 0.5, 0.75, 1, 2, 5, 10, 20, 30, 60]) {
      expect(paceSecondsAtRatio(paceRatioForSeconds(seconds))).toBeCloseTo(seconds, 8);
    }
  });

  it('gives the fast end a reachable share of the track', () => {
    // The reason for the curve. Across a 200:1 range a LINEAR track would put
    // 0.3s-1s inside its first 0.35% — about one pixel of a 300px track, which
    // is not a thing a thumb can land on. The curve gives it about a quarter.
    const fastEndShare = paceRatioForSeconds(1) - paceRatioForSeconds(MIN_PACE_SECONDS);
    expect(fastEndShare).toBeGreaterThan(0.2);

    const linearShare = (1 - MIN_PACE_SECONDS) / (MAX_PACE_SECONDS - MIN_PACE_SECONDS);
    expect(linearShare).toBeLessThan(0.02);
  });

  it('spends equal travel on equal proportional change', () => {
    // What "logarithmic" buys: doubling costs the same drag anywhere on the
    // track, so the control feels the same at half a second and at half a minute.
    const oneToTwo = paceRatioForSeconds(2) - paceRatioForSeconds(1);
    const fifteenToThirty = paceRatioForSeconds(30) - paceRatioForSeconds(15);
    expect(oneToTwo).toBeCloseTo(fifteenToThirty, 10);
  });

  it('holds a pace from outside the range on the track', () => {
    // `resolveStoredPaceMs` deliberately does not clamp, so a climb can carry a
    // pace the slider cannot express. The thumb parks at the end rather than
    // running off it — the pill still shows the real value.
    expect(paceRatioForSeconds(120)).toBe(1);
    expect(paceRatioForSeconds(0.05)).toBe(0);
    expect(paceRatioForSeconds(0)).toBe(0);
    expect(paceRatioForSeconds(Number.NaN)).toBe(0);
  });
});

describe('roundPaceSeconds', () => {
  it('keeps tenths below ten seconds', () => {
    expect(roundPaceSeconds(0.34)).toBe(0.3);
    expect(roundPaceSeconds(0.75)).toBe(0.8);
    expect(roundPaceSeconds(9.94)).toBe(9.9);
  });

  it('drops the decimal from ten seconds up', () => {
    // A tenth of a second is noise on a 40s frame, and dropping it keeps the
    // pill's longest label at four glyphs ("9.9s"), which is a layout contract.
    expect(roundPaceSeconds(10)).toBe(10);
    expect(roundPaceSeconds(10.4)).toBe(10);
    expect(roundPaceSeconds(10.6)).toBe(11);
    expect(roundPaceSeconds(59.6)).toBe(60);
  });

  it('never produces a label longer than four glyphs', () => {
    for (let px = 0; px <= USABLE; px += 1) {
      const label = String(roundPaceSeconds(paceSecondsAtRatio(px / USABLE)));
      expect(label.length).toBeLessThanOrEqual(4);
    }
  });
});

describe('shouldReportPaceSeconds gate', () => {
  it('spans the pace range, endpoints exact', () => {
    expect(roundedReportPaceSeconds(0, USABLE)).toBe(MIN_PACE_SECONDS);
    expect(roundedReportPaceSeconds(USABLE, USABLE)).toBe(MAX_PACE_SECONDS);
    // A thumb dragged past either end clamps rather than running off the range.
    expect(roundedReportPaceSeconds(-40, USABLE)).toBe(MIN_PACE_SECONDS);
    expect(roundedReportPaceSeconds(USABLE + 40, USABLE)).toBe(MAX_PACE_SECONDS);
    // Never below 0.3s: MIN_PACE_MS (200ms) is the BLE throughput floor and a
    // pace driving the wall has to keep headroom above it — the reader's floor
    // as much as the setter's, since both write frames over the same transport.
    expect(MIN_PACE_SECONDS).toBeGreaterThan(0.2);
  });

  it('reaches the full range the catalogue uses', () => {
    expect(MAX_PACE_SECONDS).toBeGreaterThanOrEqual(60);
  });

  it('reports far fewer times than the frame count over a slow drag', () => {
    const pixels = Array.from({ length: 60 }, (_, index) => index + 1);
    const reported = paceReportsForDrag(pixels);

    expect(reported.length).toBeGreaterThan(0);
    expect(reported.length).toBeLessThan(pixels.length);
    for (let index = 1; index < reported.length; index += 1) {
      expect(reported[index]).not.toBe(reported[index - 1]);
    }
  });

  it('does not report while several frames stay inside one bucket', () => {
    let lastReported = roundedReportPaceSeconds(100, USABLE);
    const decisions = [100, 100, 100, 100].map((px) => {
      const result = shouldReportPaceSeconds(px, USABLE, lastReported);
      if (result.changed) lastReported = result.rounded;
      return result.changed;
    });
    expect(decisions.filter(Boolean)).toHaveLength(0);
  });

  it('still reports every distinct step', () => {
    const distinctPixels = [0, 20, 40, 60, 80];
    const reported = paceReportsForDrag(distinctPixels);
    expect(new Set(reported).size).toBe(reported.length);
    expect(reported.length).toBe(distinctPixels.length);
  });
});

describe('paceNotch', () => {
  it('rises with the pace, so a drag crosses rungs in one direction', () => {
    let previous = -Infinity;
    for (let px = 0; px <= USABLE; px += 1) {
      const notch = paceNotch(roundedReportPaceSeconds(px, USABLE));
      expect(notch).toBeGreaterThanOrEqual(previous);
      previous = notch;
    }
  });

  it('ticks often enough to feel notched, rarely enough not to buzz', () => {
    // A fixed 0.5s step (what the linear slider used) would fire ~119 times
    // across this range, most of them inside the last third of the track.
    const notches = new Set<number>();
    for (let px = 0; px <= USABLE; px += 1) {
      notches.add(paceNotch(roundedReportPaceSeconds(px, USABLE)));
    }
    expect(notches.size).toBeGreaterThan(15);
    expect(notches.size).toBeLessThan(60);
  });

  it('widens its rungs with the value rather than holding one step', () => {
    expect(paceNotch(0.4)).not.toBe(paceNotch(0.5));
    expect(paceNotch(2)).not.toBe(paceNotch(2.5));
    expect(paceNotch(2)).toBe(paceNotch(2.2));
    expect(paceNotch(30)).toBe(paceNotch(31));
    expect(paceNotch(30)).not.toBe(paceNotch(35));
  });
});

describe('paceSecondsAtNotchOffset', () => {
  it('steps one rung at a time in both directions', () => {
    expect(paceSecondsAtNotchOffset(0.5, 1)).toBe(0.6);
    expect(paceSecondsAtNotchOffset(0.5, -1)).toBe(0.4);
    expect(paceSecondsAtNotchOffset(2, 1)).toBe(2.5);
    expect(paceSecondsAtNotchOffset(2, -1)).toBe(1.5);
    expect(paceSecondsAtNotchOffset(20, 1)).toBe(25);
    expect(paceSecondsAtNotchOffset(20, -1)).toBe(15);
  });

  it('lands on the neighbour when it leaves a band, not past it', () => {
    // Stepping down out of a band has to read the band BELOW, or 10s down would
    // be 5s: a VoiceOver user would be unable to reach anything between.
    expect(paceSecondsAtNotchOffset(10, -1)).toBe(9.5);
    expect(paceSecondsAtNotchOffset(1, -1)).toBe(0.9);
    expect(paceSecondsAtNotchOffset(0.9, 1)).toBe(1);
    expect(paceSecondsAtNotchOffset(9.5, 1)).toBe(10);
  });

  it('stops at the ends of the range', () => {
    expect(paceSecondsAtNotchOffset(MIN_PACE_SECONDS, -1)).toBe(MIN_PACE_SECONDS);
    expect(paceSecondsAtNotchOffset(MAX_PACE_SECONDS, 1)).toBe(MAX_PACE_SECONDS);
  });

  it('crosses the whole range in a swipe count a person would tolerate', () => {
    let seconds = MIN_PACE_SECONDS;
    let swipes = 0;
    while (seconds < MAX_PACE_SECONDS && swipes < 500) {
      seconds = paceSecondsAtNotchOffset(seconds, 1);
      swipes += 1;
    }
    expect(seconds).toBe(MAX_PACE_SECONDS);
    expect(swipes).toBeLessThan(40);
  });
});

describe('snapToMagnet', () => {
  it('fires at all on the 0.75s default, which a proportional window would not', () => {
    // The bug this function exists to prevent. `raw` arrives already rounded for
    // display, so around 0.75s the only reachable values are 0.7 and 0.8 — both
    // 0.05 away. Any window narrower than that (a few percent of 0.75 is 0.03)
    // makes the magnet dead code and the default pace impossible to land on.
    expect(snapToMagnet(0.7, 0.75)).toBe(0.75);
    expect(snapToMagnet(0.8, 0.75)).toBe(0.75);
  });

  it('commits the un-rounded magnet, not the label', () => {
    // The pill reads "0.8s" either way; the pace written to the climb is
    // DEFAULT_PACE_MS on the nose rather than 800ms.
    expect(snapToMagnet(0.8, 0.75)).not.toBe(0.8);
  });

  it('leaves a deliberate pace alone', () => {
    expect(snapToMagnet(0.5, 0.75)).toBe(0.5);
    expect(snapToMagnet(2, 0.75)).toBe(2);
  });

  it('widens its window with the magnet, in displayed steps', () => {
    // Past ten seconds the pill steps by whole seconds, so the window does too.
    expect(snapToMagnet(11, 12)).toBe(12);
    expect(snapToMagnet(13, 12)).toBe(12);
    expect(snapToMagnet(14, 12)).toBe(14);
  });

  it('does nothing when there is no magnet to pull to', () => {
    expect(snapToMagnet(3, 0)).toBe(3);
    expect(snapToMagnet(3, Number.NaN)).toBe(3);
  });
});

describe('clampPaceSeconds', () => {
  it('holds a pace inside the range the control offers', () => {
    expect(clampPaceSeconds(0.05)).toBe(MIN_PACE_SECONDS);
    expect(clampPaceSeconds(120)).toBe(MAX_PACE_SECONDS);
    expect(clampPaceSeconds(4)).toBe(4);
  });

  it('passes the 0.75s default through untouched', () => {
    // Clamping must not round: the release-magnet commits exactly
    // DEFAULT_PACE_MS, and a tenth-rounding clamp would make it 800ms.
    expect(clampPaceSeconds(0.75)).toBe(0.75);
  });

  it('falls back to the floor for a value that is not a number', () => {
    // Both non-finite cases land on the floor, including Infinity. Nothing can
    // actually reach here with one — every caller reads off a bounded track —
    // so this is a backstop, not a conversion.
    expect(clampPaceSeconds(Number.NaN)).toBe(MIN_PACE_SECONDS);
    expect(clampPaceSeconds(Number.POSITIVE_INFINITY)).toBe(MIN_PACE_SECONDS);
  });
});

describe('valueToTrackPosition', () => {
  it('puts the ends of the range at the ends of the track', () => {
    expect(valueToTrackPosition(MIN_PACE_SECONDS, USABLE)).toBe(0);
    expect(valueToTrackPosition(MAX_PACE_SECONDS, USABLE)).toBe(USABLE);
  });

  it('round-trips against the position-to-value mapping the drag reports', () => {
    // The two directions live apart — one in a JS effect, one in a cancel
    // worklet — so a drift between them would put the thumb somewhere the pill
    // does not agree with, and only on a CANCELLED drag.
    for (const seconds of [0.3, 0.5, 1, 2.5, 5, 10, 25, 60]) {
      const px = valueToTrackPosition(seconds, USABLE);
      expect(roundedReportPaceSeconds(px, USABLE)).toBe(roundPaceSeconds(seconds));
    }
  });

  it('holds a value from outside the range on the track', () => {
    expect(valueToTrackPosition(120, USABLE)).toBe(USABLE);
    expect(valueToTrackPosition(0.05, USABLE)).toBe(0);
  });

  it('collapses to zero before layout has given the track a width', () => {
    expect(valueToTrackPosition(5, 0)).toBe(0);
    expect(valueToTrackPosition(5, -10)).toBe(0);
  });
});
