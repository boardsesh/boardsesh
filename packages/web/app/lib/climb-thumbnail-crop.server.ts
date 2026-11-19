import 'server-only';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import type { BoardDetails, BoardImageDetails, Climb } from '@/app/lib/types';
import { getClimbThumbnailCrop, type ClimbThumbnailCrop } from './climb-thumbnail-crop';

/** Resolve geometry once per board configuration, never serialize the catalogue to rows. */
export function buildClimbThumbnailCrops(
  climbs: readonly Climb[],
  resolveBoard: (climb: Climb) => BoardImageDetails | null,
): Record<string, ClimbThumbnailCrop> {
  const geometryByConfig = new Map<string, BoardDetails | null>();
  const crops: Record<string, ClimbThumbnailCrop> = {};
  for (const climb of climbs) {
    const identity = resolveBoard(climb);
    if (!identity || identity.board_name === 'spray') continue;
    const key = [identity.board_name, identity.layout_id, identity.size_id, identity.set_ids.join(',')].join(':');
    if (!geometryByConfig.has(key)) {
      try {
        geometryByConfig.set(key, getBoardDetailsForBoard(identity));
      } catch {
        geometryByConfig.set(key, null);
      }
    }
    const geometry = geometryByConfig.get(key);
    const crop = geometry && getClimbThumbnailCrop(geometry, climb.frames);
    if (crop) crops[climb.uuid] = crop;
  }
  return crops;
}
