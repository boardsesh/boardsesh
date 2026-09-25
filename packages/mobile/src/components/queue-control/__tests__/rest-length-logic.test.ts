// The rules that let one number be driven by two gestures without the two
// disagreeing: the tap ladder wraps through `Off`, the slider never rewrites a
// rest the climber did not touch, and the shaped track keeps the rests people
// actually take inside reach of a thumb.
//
// The generic slider arithmetic is tested with the slider (`value-slider.logic`).
// What is asserted here is everything that is about a REST — the track's own
// shape, its rounding, its ladder and its magnet — because those are the numbers
// that decide whether 1:00 is landable and whether 0:45 still exists. The slider
// takes them as injected worklets, so this file is where they are pinned down.
import { describe, expect, it } from 'vitest';
import { positionToRatio, shouldReportValue, trackPosition } from '../../value-slider.logic';
import {
  DEFAULT_REST_LENGTH_SECONDS,
  MAX_REST_LENGTH_SECONDS,
  MAX_TAP_REST_LENGTH_SECONDS,
  MIN_REST_LENGTH_SECONDS,
  adjustRestLength,
  clampRestLength,
  formatRestLength,
  hasRestLength,
  magnetRestLength,
  nextRestLength,
  quantizeRestLength,
  restLengthNotch,
  restRatioForSeconds,
  restSecondsAtRatio,
  sliderRestLength,
} from '../rest-length.logic';

/** Where a rest length sits along its own track, 0–1. */
const ratioFor = restRatioForSeconds;

/** Where a rest length would sit on a LINEAR track of the same range — the
 *  control this one replaced. */
function linearRatioFor(seconds: number): number {
  return (seconds - MIN_REST_LENGTH_SECONDS) / (MAX_REST_LENGTH_SECONDS - MIN_REST_LENGTH_SECONDS);
}

/** What a release commits — the 15 s ladder, then the magnet, exactly as
 *  `ValueSlider` composes them for this control. */
function commitRestLength(rawSeconds: number): number {
  return magnetRestLength(quantizeRestLength(rawSeconds), rawSeconds);
}

describe('nextRestLength — one tap', () => {
  it('walks Off → 0:30 → 1:00 → … → 10:00 → Off and back round', () => {
    const walked: (number | null)[] = [];
    let current: number | null = null;
    for (let tap = 0; tap < 21; tap += 1) {
      current = nextRestLength(current);
      walked.push(current);
    }

    expect(walked.slice(0, 4)).toEqual([30, 60, 90, 120]);
    expect(walked[19]).toBe(MAX_TAP_REST_LENGTH_SECONDS);
    // The twenty-first tap is the wrap: the ladder's last rung is 10:00.
    expect(walked[20]).toBeNull();
    expect(nextRestLength(walked[20])).toBe(30);
  });

  it('steps an off-ladder rest to the next 30 s ABOVE it, not to plus-30', () => {
    // Someone carrying 100s from the old stepper. One tap puts them back on the
    // ladder rather than carrying the odd offset up the whole range.
    expect(nextRestLength(100)).toBe(120);
    expect(nextRestLength(1)).toBe(30);
    expect(nextRestLength(59)).toBe(60);
  });

  it('wraps to Off from anything past the tap ladder, however it got there', () => {
    // Reachable only by dragging the slider — a tap from up here means "I am
    // done with long rests", and walking 90 more rungs is not an answer.
    expect(nextRestLength(900)).toBeNull();
    expect(nextRestLength(MAX_REST_LENGTH_SECONDS)).toBeNull();
  });

  it('treats a zero or a broken value as Off rather than dividing by it', () => {
    expect(nextRestLength(0)).toBe(30);
    expect(nextRestLength(Number.NaN)).toBe(30);
  });
});

describe('sliderRestLength — where the slider opens', () => {
  it('opens at 1:00 when the rest is Off, because Off is not a position', () => {
    expect(sliderRestLength(null)).toBe(DEFAULT_REST_LENGTH_SECONDS);
    expect(sliderRestLength(0)).toBe(DEFAULT_REST_LENGTH_SECONDS);
  });

  it('opens at an arbitrary persisted rest WITHOUT rounding it', () => {
    expect(sliderRestLength(100)).toBe(100);
    expect(sliderRestLength(3599)).toBe(3599);
  });

  it('holds a value from outside the range inside it', () => {
    expect(sliderRestLength(5)).toBe(MIN_REST_LENGTH_SECONDS);
    expect(sliderRestLength(9999)).toBe(MAX_REST_LENGTH_SECONDS);
  });
});

describe('the shaped track', () => {
  it('spends the track where the rests are: 0:30–3:00 gets a fifth of it', () => {
    // A LINEAR 15s–1h track would put this whole range inside the first 4.6% —
    // about 15pt on a 393pt screen, which is the chip rail's bug over again.
    expect(ratioFor(180) - ratioFor(30)).toBeGreaterThan(0.15);
    expect(ratioFor(60)).toBeGreaterThan(0.15);
    expect(ratioFor(600)).toBeGreaterThan(0.4);
  });

  it('spends more of the track on the low end than a linear one would', () => {
    expect(ratioFor(120)).toBeGreaterThan(linearRatioFor(120) * 5);
  });

  it('pins both ends of the track to both ends of the range', () => {
    expect(ratioFor(MIN_REST_LENGTH_SECONDS)).toBe(0);
    expect(ratioFor(MAX_REST_LENGTH_SECONDS)).toBe(1);
    expect(restSecondsAtRatio(0)).toBe(MIN_REST_LENGTH_SECONDS);
    expect(restSecondsAtRatio(1)).toBe(MAX_REST_LENGTH_SECONDS);
    expect(trackPosition(ratioFor(MAX_REST_LENGTH_SECONDS), 300)).toBe(300);
  });

  it('clamps anything past either end rather than running off the track', () => {
    expect(restSecondsAtRatio(-1)).toBe(MIN_REST_LENGTH_SECONDS);
    expect(restSecondsAtRatio(2)).toBe(MAX_REST_LENGTH_SECONDS);
    expect(ratioFor(1)).toBe(0);
    expect(ratioFor(99999)).toBe(1);
  });

  it('is monotonic, so the thumb never goes backwards under a forward drag', () => {
    let previous = -1;
    for (let step = 0; step <= 100; step += 1) {
      const seconds = restSecondsAtRatio(step / 100);
      expect(seconds).toBeGreaterThan(previous);
      previous = seconds;
    }
  });

  it('round-trips every rest it is asked for, so a cancelled drag lands home', () => {
    for (const seconds of [15, 30, 60, 180, 600, 1800, 3600]) {
      expect(restSecondsAtRatio(ratioFor(seconds))).toBeCloseTo(seconds, 6);
    }
  });

  it('lands every 15 s rung exactly, so a scrub can reach each one', () => {
    for (const seconds of [15, 30, 45, 60, 120, 180, 600, 1800, 3600]) {
      const rung = shouldReportValue(
        trackPosition(ratioFor(seconds), 300),
        300,
        restSecondsAtRatio,
        quantizeRestLength,
        Number.NaN,
      );
      expect(rung.rounded).toBe(seconds);
    }
  });

  it('reads the same rest at a thumb position as the position it puts that rest at', () => {
    const px = trackPosition(ratioFor(600), 300);
    expect(restSecondsAtRatio(positionToRatio(px, 300))).toBeCloseTo(600, 6);
  });

  it('ticks once per 30 s crossed, which is what the haptic fires on', () => {
    expect(restLengthNotch(60)).toBe(restLengthNotch(70));
    expect(restLengthNotch(90)).not.toBe(restLengthNotch(60));
  });
});

describe('quantizeRestLength / clampRestLength', () => {
  it('snaps to the 15 s ladder', () => {
    expect(quantizeRestLength(52)).toBe(45);
    expect(quantizeRestLength(53)).toBe(60);
    expect(quantizeRestLength(100)).toBe(105);
  });

  it('never leaves the range, even at the rounding edges', () => {
    expect(quantizeRestLength(1)).toBe(MIN_REST_LENGTH_SECONDS);
    expect(quantizeRestLength(3599)).toBe(MAX_REST_LENGTH_SECONDS);
    expect(clampRestLength(Number.NaN)).toBe(DEFAULT_REST_LENGTH_SECONDS);
  });

  it('clamps WITHOUT rounding, so a persisted odd rest survives a round trip', () => {
    expect(clampRestLength(100)).toBe(100);
  });
});

describe('the release magnet, as this control composes it', () => {
  it('pulls a landing near 1:00 onto 1:00 exactly', () => {
    expect(commitRestLength(52)).toBe(60);
    expect(commitRestLength(70)).toBe(60);
    expect(commitRestLength(60)).toBe(60);
  });

  it('leaves 0:45 and 1:15 reachable — a magnet that swallows its neighbours is a gap', () => {
    expect(commitRestLength(49)).toBe(45);
    expect(commitRestLength(71)).toBe(75);
    expect(commitRestLength(40)).toBe(45);
  });

  it('is the 15 s ladder everywhere else', () => {
    expect(commitRestLength(187)).toBe(180);
    expect(commitRestLength(1790)).toBe(1785);
  });

  it('judges the window on the RAW landing, which is the only order that pulls', () => {
    // 52s rounds to 0:45 first, and 0:45 is 15s from the magnet — a window
    // measured after the rounding would never pull anything in.
    expect(magnetRestLength(quantizeRestLength(52), 52)).toBe(60);
    expect(magnetRestLength(quantizeRestLength(52), quantizeRestLength(52))).toBe(45);
  });
});

describe('one VoiceOver step — the user with no thumb', () => {
  it('steps a notch at a time', () => {
    expect(adjustRestLength(60, 1)).toBe(90);
    expect(adjustRestLength(60, -1)).toBe(30);
  });

  it('puts an off-ladder rest back on the ladder instead of carrying its offset', () => {
    expect(adjustRestLength(100, 1)).toBe(135);
    expect(adjustRestLength(100, -1)).toBe(75);
  });

  it('stops at both ends rather than wrapping — the tap gesture owns Off', () => {
    expect(adjustRestLength(MIN_REST_LENGTH_SECONDS, -1)).toBe(MIN_REST_LENGTH_SECONDS);
    expect(adjustRestLength(MAX_REST_LENGTH_SECONDS, 1)).toBe(MAX_REST_LENGTH_SECONDS);
  });
});

describe('formatRestLength', () => {
  it('keeps ONE notation, never the compact target format', () => {
    // The bug this guards: `formatRestTimerTarget` renders whole minutes as "2m",
    // so the pill would swap notation every other tap (`1:30 · 2m · 2:30`).
    expect(formatRestLength(120)).toBe('2:00');
    expect(formatRestLength(105)).toBe('1:45');
    expect(formatRestLength(15)).toBe('0:15');
    expect(formatRestLength(3600)).toBe('1:00:00');
  });
});

describe('hasRestLength', () => {
  it('treats Off and a zero-length rest as no deadline at all', () => {
    expect(hasRestLength(null)).toBe(false);
    expect(hasRestLength(0)).toBe(false);
    expect(hasRestLength(-1)).toBe(false);
  });

  it('accepts any positive rest length, on the ladder or not', () => {
    expect(hasRestLength(15)).toBe(true);
    expect(hasRestLength(100)).toBe(true);
  });
});
