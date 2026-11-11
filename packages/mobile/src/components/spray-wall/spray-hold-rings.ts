import { isValidOutlineRing } from '@boardsesh/board-art-geometry/ring';
import type { CanonicalSprayHold, ReferenceSize, TnutPoint } from '@boardsesh/spray-wall-geometry';
import type { SprayHoldRing } from './SpraySetupOverlay';

/** Hold silhouettes in normalized photo coordinates; a hold without a valid outline is drawn as a circle. */
export function sprayHoldRings(holds: readonly CanonicalSprayHold[], frame: ReferenceSize): SprayHoldRing[] {
  return holds.map((hold) => {
    const outline = isValidOutlineRing(hold.outline)
      ? hold.outline
      : Array.from({ length: 64 }, (_, index) => {
          const angle = Math.floor(index / 2) * (Math.PI / 16);
          return index % 2 ? Math.sin(angle) : Math.cos(angle);
        });
    const points: TnutPoint[] = [];
    for (let index = 0; index + 1 < outline.length; index += 2)
      points.push({
        x: (hold.cx + outline[index] * hold.r) / frame.width,
        y: (hold.cy + outline[index + 1] * hold.r) / frame.height,
      });
    return { id: hold.id, points };
  });
}
