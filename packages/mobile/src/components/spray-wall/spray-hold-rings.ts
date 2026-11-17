import { isValidOutlineRing } from '@boardsesh/board-art-geometry/ring';
import {
  invert,
  mapPoint,
  type CanonicalSprayHold,
  type ReferenceSize,
  type TnutPoint,
} from '@boardsesh/spray-wall-geometry';
import type { SprayLookPreviewSource } from '../../lib/spray/spray-look-preview';
import type { SprayHoldRing } from './SpraySetupOverlay';

function withinImage(x: number, y: number, size: ReferenceSize) {
  return x >= 0 && x <= size.width && y >= 0 && y <= size.height;
}

/** Draw only holds whose centres land on photo pixels inside the calibrated crop. */
export function sprayHoldRings(
  holds: readonly CanonicalSprayHold[],
  { frame, photo, homography }: Pick<SprayLookPreviewSource, 'frame' | 'photo' | 'homography'>,
): SprayHoldRing[] {
  let frameToPhoto;
  try {
    frameToPhoto = invert(homography);
  } catch {
    return [];
  }
  return holds.flatMap((hold) => {
    if (!Number.isFinite(hold.r) || hold.r <= 0 || !withinImage(hold.cx, hold.cy, frame)) return [];
    const [photoX, photoY] = mapPoint(frameToPhoto, hold.cx, hold.cy);
    if (!withinImage(photoX, photoY, photo)) return [];
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
    return [{ id: hold.id, points }];
  });
}
