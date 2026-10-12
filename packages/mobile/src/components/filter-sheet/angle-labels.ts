// The angle filter's stops and wording, kept free of React so a capsule
// builder or a token row can name an angle range without the rail.

const ANGLE_STEP = 5;
const MIN_FILTER_ANGLE = -5;
const MAX_FILTER_ANGLE = 70;

/** −5° to 70° in 5° steps: every angle the supported boards tilt to. */
export const DEFAULT_FILTER_ANGLES: readonly number[] = Array.from(
  { length: (MAX_FILTER_ANGLE - MIN_FILTER_ANGLE) / ANGLE_STEP + 1 },
  (_, index) => MIN_FILTER_ANGLE + index * ANGLE_STEP,
);

/** "40°", and "−5°" with a true minus sign rather than a hyphen. */
export function formatAngleLabel(angle: number): string {
  return `${angle < 0 ? '−' : ''}${Math.abs(angle)}°`;
}

/** "40°" for one angle, "20°–40°" for a range (en dash). */
export function formatAngleRangeLabel(minAngle: number, maxAngle: number): string {
  return minAngle === maxAngle
    ? formatAngleLabel(minAngle)
    : `${formatAngleLabel(minAngle)}–${formatAngleLabel(maxAngle)}`;
}
