// Pure, node-testable index<->angle mapping shared by both platform AngleSlider
// files. The native Slider runs in the INDEX domain (`0..count-1`) rather than
// the angle-value domain, so the stops stay evenly spaced even when the angle
// values are non-uniform (MoonBoard `[25, 40]`). Keeping the mapping + the
// haptic-on-snap handler here means the iOS and Android components can't drift,
// and it's unit-tested without mounting a native @expo/ui tree.

import { hapticSelection } from '../../lib/haptics';

/** Clamp `index` into the valid `[0, count - 1]` range. Empty set => 0. */
export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, index));
}

/**
 * The slider index for an angle: its position in `angles`. Falls back to the
 * first stop (index 0) when `value` isn't in the set (e.g. an external value
 * that doesn't match any stop), mirroring the old component's behaviour.
 */
export function sliderIndexForAngle(angles: number[], value: number): number {
  const found = angles.indexOf(value);
  return found === -1 ? 0 : found;
}

/**
 * The stops a slider should offer when `value` may not be one of them: `angles`
 * with `value` inserted in order. A tick synced from Aurora can carry an angle
 * the board's table doesn't list (37°), and `sliderIndexForAngle` would park the
 * thumb on the first stop beside a readout that says 37°. A slider must never
 * show an angle it isn't set to. A caller that wants the climber to be able to
 * pick 37 back after moving off it passes the opening value, not the live one.
 *
 * Returns `angles` itself (same reference) when `value` is already a stop or
 * isn't a finite number, and never mutates it.
 */
export function withCurrentAngle(angles: number[], value: number): number[] {
  if (!Number.isFinite(value) || angles.includes(value)) return angles;
  return [...angles, value].sort((left, right) => left - right);
}

/** The snapped stop index for a (possibly continuous) slider value. */
export function snappedIndexForSliderValue(angles: number[], sliderValue: number): number {
  return clampIndex(Math.round(sliderValue), angles.length);
}

/**
 * The real angle from `angles` nearest a (possibly continuous) slider value.
 * Always returns a member of the set so the preview callback never emits an
 * off-stop value. Returns `undefined` only for an empty set (no angle exists).
 */
export function angleForSliderValue(angles: number[], sliderValue: number): number | undefined {
  return angles[snappedIndexForSliderValue(angles, sliderValue)];
}

/**
 * Build the `onValueChange` handler used by both platform AngleSlider
 * implementations. On each native tick it snaps the slider value to the nearest
 * stop index; when that index differs from the current `valueIndex` it fires a
 * selection haptic and emits the snapped angle via `onChange`. Gating both on an
 * index CHANGE (not every continuous tick) preserves the old haptic-on-snap feel
 * and keeps `onChange` emitting a real angle exactly once per crossing.
 *
 * `valueIndex` is the slider's current (controlled) index, so it doubles as the
 * "last emitted index": the parent commits each emitted angle straight back as
 * the next `value`, which re-derives `valueIndex`, so a re-render rebuilds this
 * handler with the new baseline.
 *
 * `haptic` is injectable so the unit test can assert it fires without a native
 * haptics module; production call sites use the default `hapticSelection`.
 */
export function makeAngleSliderHandler(
  angles: number[],
  valueIndex: number,
  onChange: (angle: number) => void,
  haptic: () => void = hapticSelection,
): (sliderValue: number) => void {
  return (sliderValue: number) => {
    const index = snappedIndexForSliderValue(angles, sliderValue);
    if (index === valueIndex) return;
    const angle = angles[index];
    if (angle === undefined) return;
    haptic();
    onChange(angle);
  };
}
