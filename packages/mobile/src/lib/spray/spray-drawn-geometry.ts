// Canonical holds -> the picture a registered wall is DRAWN on right now.
//
// The registry keeps a wall's holds twice when it has a generated look: in the
// photo's pixels (what the hold editor and the reset flows work on) and in the
// art's (`activeSprayArt`). A hold that is not in either list — a lost hold
// drawn as a ghost (#5493) — has to land on whichever picture is on screen.

import { activeSprayArt, type RegisteredSprayWall } from './spray-wall-registry';
import {
  mapCanonicalHoldsToPhoto,
  scaleCanonicalHoldsToArt,
  type CanonicalSprayHold,
  type SprayPhotoHold,
} from './spray-hold-geometry';

/**
 * `holds` in the pixels the wall is drawn in: scaled into the art when a
 * generated look is active, otherwise through the inverse of the version's
 * homography. `null` when neither is possible (no matrix, or one with no
 * inverse).
 */
export function mapCanonicalHoldsForDrawnWall(
  wall: RegisteredSprayWall,
  holds: readonly CanonicalSprayHold[],
): SprayPhotoHold[] | null {
  const art = activeSprayArt(wall);
  if (art) return scaleCanonicalHoldsToArt(holds, art.scale);
  return wall.homography ? mapCanonicalHoldsToPhoto(wall.homography, holds) : null;
}
