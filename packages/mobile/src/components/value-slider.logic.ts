// The arithmetic behind `ValueSlider`. Pure — no React, no react-native, no
// reanimated — so the decisions a gesture worklet makes 60 times a second are
// unit-testable without a gesture, and the UI thread and the JS thread read ONE
// implementation rather than two copies that can drift.
//
// Every function here carries the `'worklet'` directive: they are called from
// inside the pan gesture, where an ordinary JS function would have to go back
// across the bridge to run.
//
// What is NOT here is the shape of any particular track. A slider's mapping
// (ratio <-> value), its haptic ladder and its VoiceOver step are injected by
// the caller from the caller's own domain module — the pace track's log maths
// lives in `playback/playback-speed-report`, the rest track's power curve in
// `queue-control/rest-length.logic`. This file holds what every bounded number
// shares, plus the pieces those callers build their own rules out of.

/** Hold a track ratio inside [0, 1]. */
export function clamp01(ratio: number): number {
  'worklet';
  return ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
}

/** Hold a value inside its slider's range. */
export function clampToRange(value: number, min: number, max: number): number {
  'worklet';
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** The thumb's ratio along the track, from its pixel offset. */
export function positionToRatio(px: number, usable: number): number {
  'worklet';
  return clamp01(usable > 0 ? px / usable : 0);
}

/**
 * The default track mapping: a straight line from `min` to `max`.
 *
 * Right for a slider over a narrow range, and wrong the moment the range spans
 * orders of magnitude — 0.3 s to 60 s mapped linearly buries every sub-second
 * pace in the first half-percent of the track. A caller whose range is like that
 * passes its own pair instead (see `ValueSlider`'s `ratioToValue` prop).
 */
export function linearRatioToValue(ratio: number, min: number, max: number): number {
  'worklet';
  return min + clamp01(ratio) * (max - min);
}

/** Where along a linear track a value sits, 0–1. The inverse of {@link linearRatioToValue}. */
export function linearValueToRatio(value: number, min: number, max: number): number {
  'worklet';
  const span = max - min;
  return clamp01(span > 0 ? (clampToRange(value, min, max) - min) / span : 0);
}

/**
 * Thumb offset (px) for a ratio along the track.
 *
 * Shared by the effect that tracks the committed value on the JS thread and the
 * gesture's `onFinalize` worklet, which has to put the thumb back when a drag is
 * CANCELLED — a cancelled gesture never reaches `onEnd`, so nothing commits, the
 * value the caller mirrors never moves, and the effect that would normally
 * resync it does not re-fire. One implementation, so the two directions cannot
 * drift.
 */
export function trackPosition(ratio: number, usable: number): number {
  'worklet';
  return clamp01(ratio) * Math.max(0, usable);
}

/**
 * The release-magnet: a landing within `tolerance` of `magnet` returns `magnet`
 * exactly, so the value a slider exists to make easy (0:45, 0.75 s) is easy to
 * land on rather than a matter of luck. Anything else comes back untouched.
 *
 * WHICH value a caller judges — the raw landing or the rounded one — is the
 * caller's decision, and the two are not interchangeable: see `ValueSlider`'s
 * `magnet` prop.
 */
export function applyMagnet(rawValue: number, magnet: number | null, tolerance: number): number {
  'worklet';
  if (magnet === null) return rawValue;
  return Math.abs(rawValue - magnet) <= tolerance ? magnet : rawValue;
}

/**
 * Which notch a value sits in — the rung of an evenly spaced ladder, which is
 * what a linear track wants. The slider ticks when this changes.
 *
 * A caller wraps this in its own top-level worklet to get `ValueSlider`'s
 * `notch`; a track whose rungs widen with the value writes that worklet from
 * scratch instead.
 */
export function notchIndex(value: number, notch: number): number {
  'worklet';
  return notch > 0 ? Math.round(value / notch) : 0;
}

/**
 * How far the thumb must travel before the notch may tick again, for a track
 * that asks for the guard (`minNotchTravelPx`, off by default).
 *
 * A linear track never comes near it — its notches are ~16pt apart — but a
 * shaped one is worth tens of seconds per pixel at its far end, where a flick
 * would otherwise fire a haptic every frame. A ladder whose rungs already widen
 * with the value (the pace track's) does not need it, and switching it on there
 * would silently drop every second tick in the bands whose rungs are ~3pt apart.
 */
export const MIN_NOTCH_TRAVEL_PX = 4;

/**
 * Decide whether this drag frame should push a new live value to the caller.
 *
 * The gesture's `onUpdate` worklet runs ~60x/s. Reporting on every frame costs a
 * cross-thread `runOnJS` hop plus a React re-render per frame — the repo's
 * rule-5 anti-pattern. A caller only ever DISPLAYS a rounded value, so the hop
 * is gated on that rounded value changing: `lastReported` is threaded by the
 * caller through a shared value, seeded to something no real frame can equal.
 */
export function shouldReportValue(
  px: number,
  usable: number,
  ratioToValue: (ratio: number) => number,
  round: (raw: number) => number,
  lastReported: number,
): { rounded: number; changed: boolean } {
  'worklet';
  const rounded = round(ratioToValue(positionToRatio(px, usable)));
  return { rounded, changed: rounded !== lastReported };
}

/**
 * One VoiceOver / TalkBack increment or decrement, at a fixed step.
 *
 * Clamped, then rounded, then clamped again: the first clamp keeps the step
 * inside the range, and the second catches a rounding that pushed back out of
 * it. A screen-reader user has no thumb to nudge, so every step they take has to
 * land exactly on a value the slider could otherwise reach.
 *
 * A track whose rungs widen with the value steps its own way instead — see
 * `ValueSlider`'s `adjust` prop.
 */
export function adjustValue(
  value: number,
  step: number,
  min: number,
  max: number,
  round: (raw: number) => number,
): number {
  'worklet';
  return clampToRange(round(clampToRange(value + step, min, max)), min, max);
}
