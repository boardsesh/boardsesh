// Pure gating logic for the speed-slider's live-value reporting. Extracted so
// the per-frame `runOnJS(reportLive)` decision (which otherwise lives only
// inside a reanimated worklet) is unit-testable, and so the gate and the
// reported value can never drift apart.
//
// The slider's `onUpdate` worklet runs ~60×/s during a drag. Reporting the live
// value up to React (`onLiveChange` → `setLiveSpeed`) on every frame floods the
// JS thread with a cross-thread hop + a PlaybackControls re-render per frame —
// the rule-5 anti-pattern. The displayed label only shows 0.1× precision, so we
// gate the hop on the 0.1-rounded speed actually changing, not on the raw frame.

const MIN_SPEED = 0.5;
const MAX_SPEED = 10;

/**
 * The displayed (0.1×-rounded) speed for a thumb position, matching the value
 * `reportLive` forwards via `onLiveChange`. `usable` is the draggable track span
 * in px (`trackWidth - THUMB_SIZE`); `px` is the clamped thumb offset.
 */
export function roundedReportSpeed(px: number, usable: number): number {
  'worklet';
  const ratio = usable > 0 ? px / usable : 0;
  const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  return Math.round((MIN_SPEED + clamped * (MAX_SPEED - MIN_SPEED)) * 10) / 10;
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
