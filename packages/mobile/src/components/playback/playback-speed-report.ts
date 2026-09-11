// Pure maths for the seconds-per-frame slider. Extracted so the per-frame
// `runOnJS(reportLive)` decision (which otherwise lives only inside a reanimated
// worklet) is unit-testable, and so the gate, the reported value and the thumb
// position can never drift apart.
//
// The slider's `onUpdate` worklet runs ~60x/s during a drag. Reporting the live
// value up to React (`onLiveChange` -> `setLiveValue`) on every frame floods the
// JS thread with a cross-thread hop + a PlaybackControls re-render per frame —
// the rule-5 anti-pattern. The displayed label only shows what `roundPaceSeconds`
// keeps, so we gate the hop on THAT changing, not on the raw frame.
//
// One unit, one range. This file used to carry a second pair of gates for the
// play drawer's multiplier, with its own copy of the 0.1/10 speed bounds; the
// multiplier is gone (#4633) and both surfaces now read seconds a frame.

import { MAX_PACE_MS, MIN_AUTHORED_PACE_MS } from '@boardsesh/playback-react';

/**
 * Seconds-per-frame range the pace slider offers, in the unit the slider works
 * in. Derived from the engine's authoring bounds rather than restated, so the
 * control can't drift off the range the wall accepts — the floor is deliberately
 * above the transport's own `MIN_PACE_MS` (200ms), which is the BLE throughput
 * limit an authored pace must keep headroom above. The reader drives the wall
 * over that same transport, so it gets the same floor.
 */
export const MIN_PACE_SECONDS = MIN_AUTHORED_PACE_MS / 1000;
export const MAX_PACE_SECONDS = MAX_PACE_MS / 1000;

/**
 * The track is logarithmic, not linear: equal thumb travel is equal
 * PROPORTIONAL change.
 *
 * 0.3s to 60s is a 200:1 span. Mapped linearly, everything a boulderer cares
 * about — 0.3s to 1s — would sit inside the first half-percent of the track,
 * unreachable with a thumb. On a log track that span gets about a quarter of it,
 * and the 10s-to-60s end that endurance routes live in gets a bit over a third.
 */
const PACE_LOG_SPAN = Math.log(MAX_PACE_SECONDS / MIN_PACE_SECONDS);

/** Seconds-per-frame at a 0..1 position along the track. */
export function paceSecondsAtRatio(ratio: number): number {
  'worklet';
  const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  return MIN_PACE_SECONDS * Math.exp(clamped * PACE_LOG_SPAN);
}

/** Position along the track (0..1) for a seconds-per-frame value. */
export function paceRatioForSeconds(seconds: number): number {
  'worklet';
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  const ratio = Math.log(seconds / MIN_PACE_SECONDS) / PACE_LOG_SPAN;
  return ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
}

/**
 * The precision the pill shows, and therefore the precision the live-report gate
 * works in: tenths below 10s, whole seconds at or above it.
 *
 * A tenth of a second is noise on a 40s frame, and dropping it keeps the longest
 * label the slider can produce to four glyphs ("9.9s", "60s") — the pill's width
 * is a fixed layout contract.
 */
export function roundPaceSeconds(seconds: number): number {
  'worklet';
  return seconds < 10 ? Math.round(seconds * 10) / 10 : Math.round(seconds);
}

/**
 * The displayed seconds-per-frame for a thumb position, matching the value
 * `reportLive` forwards via `onLiveChange`. `usable` is the draggable track span
 * in px (`trackWidth - THUMB_SIZE`); `px` is the clamped thumb offset.
 */
export function roundedReportPaceSeconds(px: number, usable: number): number {
  'worklet';
  return roundPaceSeconds(paceSecondsAtRatio(usable > 0 ? px / usable : 0));
}

/**
 * Decide whether this drag frame should push a new live value. Returns the
 * rounded seconds for the position and whether it differs from the last one
 * reported (`lastReported`, threaded by the caller through a shared value, seeded
 * to a value the first real frame can't equal). When `changed` is false the
 * caller skips the `runOnJS(reportLive)` hop entirely.
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
 * Size of one rung on the pace ladder at a given value — the haptic tick spacing
 * and the VoiceOver adjust step.
 *
 * Proportional, like the track. The fixed 0.5 the linear slider used would fire
 * a tick roughly once per pixel at the slow end of a log track, and would take a
 * VoiceOver user 119 swipes to cross the range.
 */
function paceNotchStep(seconds: number): number {
  'worklet';
  if (seconds < 1) return 0.1;
  if (seconds < 10) return 0.5;
  return 5;
}

/**
 * Rung index for a pace, so a drag can tick once per rung crossed. Monotonic in
 * `seconds`; the gaps between bands are deliberate — this is an identity, not a
 * count. About 35 rungs span the whole track.
 */
export function paceNotch(seconds: number): number {
  'worklet';
  if (seconds < 1) return Math.round(seconds * 10);
  if (seconds < 10) return 10 + Math.round(seconds * 2);
  return 40 + Math.round(seconds / 5);
}

/**
 * Gap between two values the pill can display, at a given magnitude — the same
 * rule `roundPaceSeconds` rounds by, named so the magnet can reason in it.
 */
function paceDisplayStep(seconds: number): number {
  'worklet';
  return seconds < 10 ? 0.1 : 1;
}

/**
 * Commit `magnetSeconds` exactly when the thumb is released within one displayed
 * step of it, so the pace that matters most on this surface is easy to land on.
 *
 * The window has to be expressed in DISPLAYED steps, not as a percentage. `raw`
 * has already been rounded for display, so around the 0.75s default the only
 * reachable values are 0.7 and 0.8 — both 0.05 away. A proportional window of a
 * few percent is narrower than that gap, which would make the magnet dead code
 * and the default pace impossible to land on.
 *
 * Snapping to the UN-rounded magnet is the point: the pill reads "0.8s" either
 * way, but the committed pace is `DEFAULT_PACE_MS` on the nose rather than 800ms.
 */
export function snapToMagnet(raw: number, magnetSeconds: number): number {
  'worklet';
  if (!Number.isFinite(magnetSeconds) || magnetSeconds <= 0) return raw;
  return Math.abs(raw - magnetSeconds) <= paceDisplayStep(magnetSeconds) ? magnetSeconds : raw;
}

/**
 * Hold a seconds-per-frame value inside the range the slider offers. Used on
 * every committed pace (drag release, track tap, preset cycle, VoiceOver
 * adjust), so no path can author a pace the wall can't keep up with.
 *
 * Deliberately clamps WITHOUT rounding: the display rounds, but the
 * release-magnet commits an exact value (the climb's own pace for a reader,
 * `DEFAULT_PACE_MS` for a setter) and a rounding clamp would quietly turn a
 * 750ms default into 800ms.
 */
export function clampPaceSeconds(seconds: number): number {
  'worklet';
  if (!Number.isFinite(seconds)) return MIN_PACE_SECONDS;
  return Math.min(MAX_PACE_SECONDS, Math.max(MIN_PACE_SECONDS, seconds));
}

/**
 * The pace one rung above (`direction` 1) or below (-1) this one, clamped into
 * range. Used by the slider's VoiceOver `adjustable` actions.
 *
 * Stepping DOWN reads the band just below the current value, so leaving a band
 * lands on its neighbour rather than skipping it: 10s down is 9.5s, not 5s.
 */
export function paceSecondsAtNotchOffset(seconds: number, direction: 1 | -1): number {
  const step = direction > 0 ? paceNotchStep(seconds) : paceNotchStep(seconds - 1e-6);
  return clampPaceSeconds(roundPaceSeconds(seconds + direction * step));
}

/**
 * Thumb offset (px) for a pace — the inverse of `roundedReportPaceSeconds`.
 *
 * Shared by the effect that tracks the committed value on the JS thread and the
 * gesture's `onFinalize` worklet, which has to put the thumb back when a drag is
 * CANCELLED. A cancelled gesture never reaches `onEnd`, so nothing commits and
 * the value the pill mirrors never moves — meaning the effect that would
 * normally resync it does not re-fire, and the pill is left reading a pace the
 * climb does not have. Living in one place keeps the two directions from
 * drifting, and lets both be tested without a gesture.
 */
export function valueToTrackPosition(seconds: number, usable: number): number {
  'worklet';
  return paceRatioForSeconds(seconds) * Math.max(0, usable);
}
