/**
 * Default board configuration for a layout, used to draw a climb when the exact
 * size/sets are not known.
 */

import { getDefaultRenderBoard } from '@boardsesh/board-config';
import type { BoardName } from '@/app/lib/types';
import type { SetIdList } from '@/app/lib/board-data';
import { tryConstructSlugViewUrl } from '@/app/lib/url-utils';

export type DefaultBoardConfig = {
  sizeId: number;
  setIds: SetIdList;
};

/**
 * The board configuration to draw a climb on when nothing better is known: the
 * layout's biggest size with every set installed. Rung 4 of the shared ladder in
 * `@boardsesh/board-config`, so web and mobile make the same guess — and so
 * layouts the old hardcoded table didn't list (Decoy, Touchstone, Grasshopper,
 * the orphaned Kilter layouts 2-7) render instead of showing no thumbnail.
 *
 * Anything drawing a *logged* climb should prefer the `renderBoard` the backend
 * resolved for that ascent — the board it was climbed on, or the closest one the
 * climber has — and only fall back here. Returns null when the board or layout
 * can't be resolved at all.
 */
export function getDefaultBoardConfig(boardName: BoardName, layoutId: number): DefaultBoardConfig | null {
  const resolved = getDefaultRenderBoard(boardName, layoutId);
  return resolved ? { sizeId: resolved.sizeId, setIds: resolved.setIds } : null;
}

/**
 * Get the board path for a climb based on the default configuration.
 * Used for constructing URLs to climb view pages.
 */
export function getDefaultClimbViewPath(
  boardName: BoardName,
  layoutId: number,
  angle: number,
  climbUuid: string,
  climbName?: string,
): string | null {
  const config = getDefaultBoardConfig(boardName, layoutId);
  if (!config) return null;

  return (
    tryConstructSlugViewUrl(boardName, layoutId, config.sizeId, config.setIds, angle, climbUuid, climbName) ??
    `/${boardName}/${layoutId}/${config.sizeId}/${config.setIds.join(',')}/${angle}/view/${climbUuid}`
  );
}
