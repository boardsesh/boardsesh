import { placementRingPathData, radiusRingToBoardPx, ringToPathData } from './stroke';
import type { HoldGeometry } from './spray-hold-tools';

/**
 * A hold's boundary as an SVG subpath in board px: its traced ring, or the
 * circle at `r`. Shared by the ring layer and the selection overlay so the two
 * can never draw the same hold two different shapes.
 */
export function holdPathData(hold: HoldGeometry): string {
  const placement = { id: 0, cx: hold.cx, cy: hold.cy, r: hold.r };
  return hold.outline ? ringToPathData(radiusRingToBoardPx(hold.outline, placement)) : placementRingPathData(placement);
}

/** Reducer geometry is immutable; board and active loupe can share its path. */
const cachedPaths = new WeakMap<HoldGeometry, string>();

export function cachedHoldPathData(hold: HoldGeometry): string {
  const cached = cachedPaths.get(hold);
  if (cached !== undefined) return cached;
  const path = holdPathData(hold);
  cachedPaths.set(hold, path);
  return path;
}
