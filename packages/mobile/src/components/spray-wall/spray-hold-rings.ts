import { isValidOutlineRing, pointInRing } from '@boardsesh/board-art-geometry/ring';
import type { CanonicalSprayHold, ReferenceSize, TnutPoint } from '@boardsesh/spray-wall-geometry';
import type { SprayHoldRing } from './SpraySetupOverlay';

function intersectsPhoto(points: TnutPoint[]): boolean {
  const inside = (coordinate: number) => coordinate >= 0 && coordinate <= 1;
  for (const [index, start] of points.entries()) {
    if (inside(start.x) && inside(start.y)) return true;
    const end = points[(index + 1) % points.length];
    for (const edge of [0, 1]) {
      if (start.x < edge !== end.x < edge) {
        const along = (edge - start.x) / (end.x - start.x);
        if (inside(start.y + along * (end.y - start.y))) return true;
      }
      if (start.y < edge !== end.y < edge) {
        const along = (edge - start.y) / (end.y - start.y);
        if (inside(start.x + along * (end.x - start.x))) return true;
      }
    }
  }
  // A silhouette can enclose the whole photo without crossing any edge.
  return pointInRing(
    points.flatMap(({ x, y }) => [x, y]),
    0.5,
    0.5,
  );
}

/** Hold silhouettes in normalized photo coordinates; a hold without a valid outline is drawn as a circle. */
export function sprayHoldRings(holds: readonly CanonicalSprayHold[], frame: ReferenceSize): SprayHoldRing[] {
  return holds.flatMap((hold) => {
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
    return intersectsPhoto(points) ? [{ id: hold.id, points }] : [];
  });
}
