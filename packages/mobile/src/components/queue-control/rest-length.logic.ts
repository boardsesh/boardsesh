// The rest-length domain: the rules that are about a REST, as opposed to the
// slider arithmetic every bounded number shares (`components/value-slider.logic`).
// Pure — no React, no react-native — so each rule is unit-testable without a
// native tree, and the gesture worklet and the JS thread read the same one.
//
// Why this shape. The control before it was a 27-chip rail, and on a 393pt
// screen only `Off · 0:15 · 0:30 · 0:45 · 1:00 · 1:15` were on screen: 2:00 and
// 3:00 — the rests people actually take — needed a horizontal scroll. So the
// rest length is now the cadence pill's shape: tap steps 30 s and wraps,
// long-press opens the fine slider.
//
// Two ladders, deliberately different lengths:
//   - the TAP ladder is 0:30 → 10:00 in 30 s rungs, then back to `Off`. Twenty
//     rungs is the most a thumb should ever walk, and past 10:00 nobody is
//     tapping anyway — that is what the slider is for.
//   - the SLIDER covers 0:15 → 1:00:00 at 15 s resolution. `Off` is not a
//     position on it: it is a mode, reached by the tap-wrap.

import { adjustValue, applyMagnet, clamp01, clampToRange, notchIndex } from '../value-slider.logic';
import { formatRestTimerElapsed } from '../../lib/rest-timer';

/** The shortest rest the slider offers. Below this the countdown is over before
 *  the pill has finished animating. */
export const MIN_REST_LENGTH_SECONDS = 15;

/** The longest. An hour is the far end of a max-strength block's recovery. */
export const MAX_REST_LENGTH_SECONDS = 3600;

/** What the slider quantises to, everywhere along the track. */
export const REST_LENGTH_RESOLUTION_SECONDS = 15;

/** One tap. */
export const REST_LENGTH_TAP_STEP_SECONDS = 30;

/** The tap ladder's last rung — past it, the next tap wraps to `Off`. */
export const MAX_TAP_REST_LENGTH_SECONDS = 600;

/** How often the slider ticks under the thumb. */
export const REST_LENGTH_NOTCH_SECONDS = 30;

/** The haptic ladder, as `ValueSlider` takes it. A named top-level function, not
 *  a closure built in a render: a fresh identity would rebuild the pan gesture. */
export function restLengthNotch(seconds: number): number {
  'worklet';
  return notchIndex(seconds, REST_LENGTH_NOTCH_SECONDS);
}

/** Where the slider opens when the rest is `Off`, and the rest a first tap
 *  reaches in two. */
export const DEFAULT_REST_LENGTH_SECONDS = 60;

/**
 * The exponent the track is shaped by — see `restSecondsAtRatio`.
 *
 * A LINEAR 15 s–1 h track would put every rest a climber actually takes
 * (0:30–3:00) inside the first 4.6% of it — about 15pt on a 393pt screen, which
 * is the rail's bug again in a different control. At 2.5 the track spends its
 * pixels where the values are: 0:30 lands 11% along, 1:00 at 17%, 3:00 at 29%,
 * 10:00 at 48%, and the last quarter carries 30:00–1:00:00, where 15 s of
 * precision is noise anyway.
 *
 * A power curve rather than the pace slider's logarithm because this range is
 * 240:1 with a floor that matters: a log track pins 0:15 and 1:00:00 the same
 * way, but spends a quarter of itself on 0:15–1:00, where there are only three
 * rungs to land on.
 *
 * The DOMAIN is untouched by this — still 15 s to an hour at 15 s resolution.
 * Only the pixels are shaped.
 */
export const REST_LENGTH_CURVE = 2.5;

/** Rest length at a 0..1 position along the track. */
export function restSecondsAtRatio(ratio: number): number {
  'worklet';
  return (
    MIN_REST_LENGTH_SECONDS +
    Math.pow(clamp01(ratio), REST_LENGTH_CURVE) * (MAX_REST_LENGTH_SECONDS - MIN_REST_LENGTH_SECONDS)
  );
}

/** Position along the track (0..1) for a rest length. The inverse of
 *  {@link restSecondsAtRatio}, so a cancelled drag puts the thumb back exactly
 *  where the committed rest says it belongs. */
export function restRatioForSeconds(seconds: number): number {
  'worklet';
  const span = MAX_REST_LENGTH_SECONDS - MIN_REST_LENGTH_SECONDS;
  const linear = clamp01(
    (clampToRange(seconds, MIN_REST_LENGTH_SECONDS, MAX_REST_LENGTH_SECONDS) - MIN_REST_LENGTH_SECONDS) / span,
  );
  return Math.pow(linear, 1 / REST_LENGTH_CURVE);
}

/** The rest the release-magnet pulls to. */
export const REST_LENGTH_MAGNET_SECONDS = 60;

/**
 * How close a release has to land to take the magnet.
 *
 * Deliberately wider than half a notch (7.5 s) and no wider: at 10 s, landing on
 * 1:00 exactly takes a 20 s-wide band instead of a 15 s one — a third more
 * thumb — while 0:45 and 1:15 keep 12.5 s of their own 15 s and stay reachable.
 * A magnet wide enough to swallow its neighbours is not a magnet, it is a gap.
 */
export const REST_LENGTH_MAGNET_TOLERANCE_SECONDS = 10;

/** Whether a persisted setting counts as a real rest length. `Off` (null) has no
 *  deadline, and neither does a zero — both mean "count up instead". */
export function hasRestLength(targetSeconds: number | null): targetSeconds is number {
  return targetSeconds !== null && Number.isFinite(targetSeconds) && targetSeconds > 0;
}

/**
 * The pill's label for a rest length.
 *
 * `formatRestTimerElapsed`, never `formatRestTimerTarget`: the compact target
 * format collapses whole minutes to `2m`, so stepping the pill would swap
 * notation every other tap (`1:30 · 2m · 2:30`) and the digits would jump width
 * under the thumb.
 */
export function formatRestLength(seconds: number): string {
  return formatRestTimerElapsed(seconds);
}

/** Hold a value inside the range the slider offers. Clamps WITHOUT quantising,
 *  so an arbitrary persisted rest (someone's old 100 s) survives a round trip. */
export function clampRestLength(seconds: number): number {
  'worklet';
  if (!Number.isFinite(seconds)) return DEFAULT_REST_LENGTH_SECONDS;
  return Math.min(MAX_REST_LENGTH_SECONDS, Math.max(MIN_REST_LENGTH_SECONDS, seconds));
}

/**
 * Clamp AND snap to the slider's 15 s resolution — `ValueSlider`'s `round` for
 * this control, so it runs inside the gesture worklet.
 */
export function quantizeRestLength(seconds: number): number {
  'worklet';
  const clamped = clampRestLength(seconds);
  const snapped = Math.round(clamped / REST_LENGTH_RESOLUTION_SECONDS) * REST_LENGTH_RESOLUTION_SECONDS;
  return Math.min(MAX_REST_LENGTH_SECONDS, Math.max(MIN_REST_LENGTH_SECONDS, snapped));
}

/**
 * What a release commits — `ValueSlider`'s `magnet` for this control.
 *
 * The window is judged on the RAW landing, not on the 15 s rung it would
 * otherwise round to, and that is the only order that does anything here: 52 s
 * rounds to 0:45, which is 15 s from the magnet and would never be pulled in.
 * Everything outside the window keeps the rung it landed on.
 */
export function magnetRestLength(rounded: number, rawSeconds: number): number {
  'worklet';
  const pulled = applyMagnet(rawSeconds, REST_LENGTH_MAGNET_SECONDS, REST_LENGTH_MAGNET_TOLERANCE_SECONDS);
  return pulled === REST_LENGTH_MAGNET_SECONDS ? pulled : rounded;
}

/**
 * One VoiceOver / TalkBack step, up or down — one notch, landing on the 15 s
 * ladder and stopping at both ends. `Off` is not on the track, so it is not on
 * this ladder either: the tap gesture owns it.
 */
export function adjustRestLength(seconds: number, direction: 1 | -1): number {
  'worklet';
  return adjustValue(
    seconds,
    direction * REST_LENGTH_NOTCH_SECONDS,
    MIN_REST_LENGTH_SECONDS,
    MAX_REST_LENGTH_SECONDS,
    quantizeRestLength,
  );
}

/**
 * One tap: the next 30 s rung strictly above the current rest, wrapping to `Off`
 * past 10:00. `Off` itself steps to 0:30, so the whole cycle is
 * `Off → 0:30 → 1:00 → … → 10:00 → Off`.
 *
 * An arbitrary persisted rest steps to the next MULTIPLE of 30 above it (100 s →
 * 2:00), rather than to 100 + 30: a tap is how you get back onto the ladder, not
 * how you carry an odd number up it. Nothing rewrites the odd value until the
 * climber taps — see `sliderRestLength`.
 */
export function nextRestLength(current: number | null): number | null {
  if (!hasRestLength(current)) return REST_LENGTH_TAP_STEP_SECONDS;
  const next = (Math.floor(current / REST_LENGTH_TAP_STEP_SECONDS) + 1) * REST_LENGTH_TAP_STEP_SECONDS;
  return next > MAX_TAP_REST_LENGTH_SECONDS ? null : next;
}

/** The rest length the slider opens at: the persisted one when there is one
 *  (including an off-ladder one, unrounded), otherwise 1:00. */
export function sliderRestLength(persistedSeconds: number | null): number {
  return hasRestLength(persistedSeconds) ? clampRestLength(persistedSeconds) : DEFAULT_REST_LENGTH_SECONDS;
}
