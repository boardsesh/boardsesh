import { isValidOutlineRing } from '@boardsesh/board-art-geometry/ring';
import type { CanonicalSprayHold, TnutPoint } from '@boardsesh/spray-wall-geometry';
import type { SprayLookPreviewSource } from '../../lib/spray/spray-look-preview';
import type { SprayHoldRing } from './SpraySetupOverlay';
import { sprayPhotoCoverage } from './spray-photo-coverage';

/** Draw only holds whose centres land on photo pixels inside the calibrated crop. */
export function sprayHoldRings(
  holds: readonly CanonicalSprayHold[],
  source: Pick<SprayLookPreviewSource, 'frame' | 'photo' | 'homography'>,
): SprayHoldRing[] {
  const { frame } = source;
  const onPhoto = sprayPhotoCoverage(source);
  return holds.flatMap((hold) => {
    if (!Number.isFinite(hold.r) || hold.r <= 0 || !onPhoto(hold.cx, hold.cy)) return [];
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
