// Pure gating logic for the playback slider's live-value reporting. Extracted so
// the per-frame `runOnJS(reportLive)` decision (which otherwise lives only
// inside a reanimated worklet) is unit-testable, and so the gate and the
// reported value can never drift apart.
//
// The slider's `onUpdate` worklet runs ~60×/s during a drag. Reporting the live
// value up to React (`onLiveChange` → `setLiveValue`) on every frame floods the
// JS thread with a cross-thread hop + a PlaybackControls re-render per frame —
// the rule-5 anti-pattern. The displayed label only shows one decimal of
// precision, so we gate the hop on the 0.1-rounded value actually changing, not
// on the raw frame.
//
// Two units share the slider: the reader's ×multiplier (play drawer) and the
// setter's seconds-per-frame (create drawer). Each gets its own named pair so a
// call site can't accidentally gate a pace drag against the speed range — the
// two ranges differ, so the wrong pair would report a value the pill never shows.

import { MAX_PACE_MS, MIN_AUTHORED_PACE_MS } from '@boardsesh/playback-react';

const MIN_SPEED = 0.1;
const MAX_SPEED = 10;

/**
 * Seconds-per-frame range the creator's pace slider offers, in the unit the
 * slider works in. Derived from the engine's authoring bounds rather than
 * restated, so the control can't drift off the range the wall accepts — the
 * floor is deliberately above the transport's own `MIN_PACE_MS` (200ms), which
 * is the BLE throughput limit an authored pace must keep headroom above.
 */
export const MIN_PACE_SECONDS = MIN_AUTHORED_PACE_MS / 1000;
export const MAX_PACE_SECONDS = MAX_PACE_MS / 1000;

/** The 0.1-rounded value a thumb position maps to within an arbitrary range. */
function roundedForRange(px: number, usable: number, min: number, max: number): number {
  'worklet';
  const ratio = usable > 0 ? px / usable : 0;
  const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  return Math.round((min + clamped * (max - min)) * 10) / 10;
}

/**
 * The displayed (0.1×-rounded) speed for a thumb position, matching the value
 * `reportLive` forwards via `onLiveChange`. `usable` is the draggable track span
 * in px (`trackWidth - THUMB_SIZE`); `px` is the clamped thumb offset.
 */
export function roundedReportSpeed(px: number, usable: number): number {
  'worklet';
  return roundedForRange(px, usable, MIN_SPEED, MAX_SPEED);
}

/**
 * Decide whether this drag frame should push a new live value. Returns the
 * 0.1-rounded speed for the position and whether it differs from the last one
 * reported (`lastReported`, threaded by the caller through a shared value, seeded
 * to a value the first real frame can't equal). When `changed` is false the
 * caller skips the `runOnJS(reportLive)` hop entirely.
 */
export function shouldReportSpeed(
  px: number,
  usable: number,
  lastReported: number,
): { rounded: number; changed: boolean } {
  'worklet';
  const rounded = roundedReportSpeed(px, usable);
  return { rounded, changed: rounded !== lastReported };
}

/**
 * The displayed (0.1s-rounded) seconds-per-frame for a thumb position — the pace
 * counterpart of {@link roundedReportSpeed}, over the 0.3–10s authoring range.
 */
export function roundedReportPaceSeconds(px: number, usable: number): number {
  'worklet';
  return roundedForRange(px, usable, MIN_PACE_SECONDS, MAX_PACE_SECONDS);
}

/**
 * The pace counterpart of {@link shouldReportSpeed}: gates the live report on the
 * 0.1s-rounded seconds changing, so a pace drag costs the JS thread one hop per
 * tenth of a second authored rather than one per rendered frame.
 */
export function shouldReportPaceSeconds(
  px: number,
  usable: number,
  lastReported: number,
): { rounded: number; changed: boolean } {
  'worklet';
  const rounded = roundedReportPaceSeconds(px, usable);
  return { rounded, changed: rounded !== lastReported };
}

/**
 * Hold a seconds-per-frame value inside the range the slider offers. Used on
 * every committed pace (drag release, track tap, preset cycle, VoiceOver
 * adjust), so no path can author a pace the wall can't keep up with.
 *
 * Deliberately clamps WITHOUT rounding: the display rounds to a tenth, but the
 * release-magnet commits 0.75s (the engine's `DEFAULT_PACE_MS`) exactly, and a
 * tenth-rounding clamp would quietly turn that default into 800ms.
 */
export function clampPaceSeconds(seconds: number): number {
  'worklet';
  if (!Number.isFinite(seconds)) return MIN_PACE_SECONDS;
  return Math.min(MAX_PACE_SECONDS, Math.max(MIN_PACE_SECONDS, seconds));
}
