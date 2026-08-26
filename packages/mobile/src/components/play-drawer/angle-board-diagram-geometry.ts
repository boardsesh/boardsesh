/** SVG sweep direction from vertical to the requested board angle. */
export function getAngleArcSweepFlag(angle: number): 0 | 1 {
  return angle < 0 ? 0 : 1;
}
