// The arithmetic `ValueSlider` runs inside a gesture worklet, 60 times a second.
// Every rule here is one a slider got wrong at least once: a thumb that jumped
// before layout, a magnet that swallowed its neighbours, and a live-value hop
// fired on every frame.
//
// The SHAPE of a track is not tested here, because it isn't here: each caller
// injects its own mapping and tests it in its own module (`rest-length.logic`,
// `playback-speed-report`). What this file guards is the part every bounded
// number shares, and the straight line a caller gets when it shapes nothing.
import { describe, expect, it } from 'vitest';
import {
  adjustValue,
  applyMagnet,
  clamp01,
  clampToRange,
  linearRatioToValue,
  linearValueToRatio,
  notchIndex,
  positionToRatio,
  shouldReportValue,
  trackPosition,
} from '../value-slider.logic';

/** A tenth, the way the playback pill displays a pace. */
function roundTenth(raw: number): number {
  return Math.round(raw * 10) / 10;
}

/** 15 seconds, the way the rest pill displays a rest. */
function roundQuarterMinute(raw: number): number {
  return Math.round(raw / 15) * 15;
}

/** The default mapping over a narrow range, as `ValueSlider` builds it. */
function linearTrack(ratio: number): number {
  return linearRatioToValue(ratio, 0.1, 10);
}

describe('clamp01 / clampToRange / positionToRatio', () => {
  it('holds a ratio on the track', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(0.25)).toBe(0.25);
  });

  it('holds a value in its range, and falls back to the floor for a non-number', () => {
    expect(clampToRange(-5, 1, 10)).toBe(1);
    expect(clampToRange(50, 1, 10)).toBe(10);
    expect(clampToRange(Number.NaN, 1, 10)).toBe(1);
  });

  it('collapses to zero before layout has given the track a width', () => {
    // `usable` is 0 until onLayout lands; without this the thumb divides by it.
    expect(positionToRatio(40, 0)).toBe(0);
    expect(positionToRatio(40, -10)).toBe(0);
  });
});

describe('the default mapping — a linear track', () => {
  it('puts the ends of the range at the ends of the track', () => {
    expect(linearRatioToValue(0, 0.1, 10)).toBe(0.1);
    expect(linearRatioToValue(1, 0.1, 10)).toBe(10);
    expect(linearValueToRatio(0.1, 0.1, 10)).toBe(0);
    expect(linearValueToRatio(10, 0.1, 10)).toBe(1);
  });

  it('is a straight line between them', () => {
    expect(linearRatioToValue(0.5, 0, 10)).toBe(5);
    expect(linearValueToRatio(5, 0, 10)).toBe(0.5);
  });

  it('clamps anything past either end, in both directions', () => {
    expect(linearRatioToValue(-1, 0.1, 10)).toBe(0.1);
    expect(linearRatioToValue(2, 0.1, 10)).toBe(10);
    expect(linearValueToRatio(-4, 0.1, 10)).toBe(0);
    expect(linearValueToRatio(99, 0.1, 10)).toBe(1);
  });

  it('does not divide by a zero span', () => {
    expect(linearValueToRatio(3, 2, 2)).toBe(0);
  });
});

describe('trackPosition', () => {
  it('puts the ends of the track at the ends of the usable span', () => {
    expect(trackPosition(0, 200)).toBe(0);
    expect(trackPosition(1, 200)).toBe(200);
  });

  it('collapses to zero before layout, rather than placing the thumb off-track', () => {
    expect(trackPosition(0.5, 0)).toBe(0);
    expect(trackPosition(0.5, -10)).toBe(0);
  });

  it('is the inverse of the mapping a drag reports', () => {
    // The two directions live in one module precisely so a cancelled drag can put
    // the thumb back exactly where the committed value says it belongs.
    const px = trackPosition(linearValueToRatio(4.2, 0.1, 10), 300);
    expect(linearRatioToValue(positionToRatio(px, 300), 0.1, 10)).toBeCloseTo(4.2, 6);
  });
});

describe('applyMagnet', () => {
  it('pulls a landing inside the tolerance onto the magnet exactly', () => {
    expect(applyMagnet(1.04, 1, 0.1)).toBe(1);
    expect(applyMagnet(0.9, 1, 0.1)).toBe(1);
  });

  it('leaves everything outside it alone', () => {
    expect(applyMagnet(1.2, 1, 0.1)).toBe(1.2);
    expect(applyMagnet(0.5, 1, 0.1)).toBe(0.5);
  });

  it('is a no-op for a slider without one', () => {
    expect(applyMagnet(4.2, null, 0.1)).toBe(4.2);
  });

  it('gives a different answer on the raw landing than on the rounded one', () => {
    // Which is why `ValueSlider` takes the magnet as a function and lets each
    // caller pick: the rest slider judges 52s before it becomes 0:45 (and pulls
    // it to 1:00), and the pace slider judges the displayed value so that its
    // commit can be the un-rounded 750ms default.
    expect(roundQuarterMinute(applyMagnet(52, 60, 10))).toBe(60);
    expect(applyMagnet(roundQuarterMinute(52), 60, 10)).toBe(45);
  });
});

describe('notchIndex', () => {
  it('changes once per notch crossed', () => {
    expect(notchIndex(1.1, 0.5)).toBe(notchIndex(1.2, 0.5));
    expect(notchIndex(1.1, 0.5)).not.toBe(notchIndex(1.6, 0.5));
  });

  it('does not divide by a zero notch', () => {
    expect(notchIndex(4, 0)).toBe(0);
  });
});

describe('shouldReportValue — the per-frame gate', () => {
  const USABLE = 300;

  /** Replay a drag through the gate, threading `lastReported` the way the worklet
   *  threads its shared value. */
  function reportsForDrag(pixels: number[], round: (raw: number) => number): number[] {
    let lastReported = Number.NaN;
    const reported: number[] = [];
    for (const px of pixels) {
      const { rounded, changed } = shouldReportValue(px, USABLE, linearTrack, round, lastReported);
      if (changed) {
        lastReported = rounded;
        reported.push(rounded);
      }
    }
    return reported;
  }

  it('costs one hop per displayed step, not one per rendered frame', () => {
    const pixels = Array.from({ length: 60 }, (_, index) => index + 1);
    const reported = reportsForDrag(pixels, roundTenth);

    expect(reported.length).toBeGreaterThan(0);
    expect(reported.length).toBeLessThan(pixels.length);
    for (let index = 1; index < reported.length; index += 1) {
      expect(reported[index]).not.toBe(reported[index - 1]);
    }
  });

  it('reports nothing while the frames stay inside one displayed step', () => {
    const first = shouldReportValue(100, USABLE, linearTrack, roundTenth, Number.NaN);
    expect(first.changed).toBe(true);
    expect(shouldReportValue(100, USABLE, linearTrack, roundTenth, first.rounded).changed).toBe(false);
  });

  it('gets coarser when the caller rounds coarser — the gate follows the display', () => {
    const pixels = Array.from({ length: 60 }, (_, index) => index + 1);
    expect(reportsForDrag(pixels, (raw) => Math.round(raw)).length).toBeLessThan(
      reportsForDrag(pixels, roundTenth).length,
    );
  });

  it('survives a frame before layout, when there is no usable span', () => {
    expect(shouldReportValue(0, 0, linearTrack, roundTenth, Number.NaN).rounded).toBe(0.1);
  });
});

describe('adjustValue — one VoiceOver step', () => {
  it('steps and stops at both ends', () => {
    expect(adjustValue(1, 0.5, 0.1, 10, roundTenth)).toBe(1.5);
    expect(adjustValue(9.8, 0.5, 0.1, 10, roundTenth)).toBe(10);
    expect(adjustValue(0.3, -0.5, 0.1, 10, roundTenth)).toBe(0.1);
  });

  it('lands on a value the slider itself could reach', () => {
    // Rounded, not just clamped: a screen-reader user has no thumb to nudge, so
    // a step that landed between two displayed values would be unreachable again.
    expect(adjustValue(100, 30, 15, 3600, roundQuarterMinute)).toBe(135);
  });

  it('clamps AFTER rounding too, so a rounding cannot push out of range', () => {
    expect(adjustValue(3598, 1, 15, 3600, (raw) => Math.round(raw / 15) * 15)).toBe(3600);
  });
});
