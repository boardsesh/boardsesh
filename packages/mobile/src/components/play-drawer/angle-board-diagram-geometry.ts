/** SVG sweep direction from vertical to the requested board angle. */
export function getAngleArcSweepFlag(angle: number): 0 | 1 {
  return angle < 0 ? 0 : 1;
}

/**
 * Where a board edge of length `arm`, hinged at `pivot`, ends at `angle`
 * degrees past vertical (SVG space, y down). 0° points straight up; positive
 * angles lean right (overhung), negative ones left (slab).
 */
export function angleGlyphTip(angle: number, pivot: { x: number; y: number }, arm: number): { x: number; y: number } {
  const radians = (angle * Math.PI) / 180;
  return { x: pivot.x + Math.sin(radians) * arm, y: pivot.y - Math.cos(radians) * arm };
}
