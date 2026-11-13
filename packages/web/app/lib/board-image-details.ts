// This leaf is safe in client components: it never imports the full geometry or renderer pipeline.
export {
  getBoardImageDetailsForBoard,
  toBoardImageDetails,
  type BoardImageDetails,
} from '@boardsesh/board-config/image-metadata';

import { getSizesForLayoutId, getSetsForLayoutAndSize, LAYOUTS } from '@boardsesh/board-constants/catalog-metadata';
import { MOONBOARD_LAYOUTS, MOONBOARD_SETS, type MoonBoardLayoutKey } from '@boardsesh/board-config/moonboard-metadata';
import { getBoardImageDetailsForBoard, type BoardImageDetails } from '@boardsesh/board-config/image-metadata';
import type { BoardName } from './types';

/** Match playlist display defaults without importing its interactive compatibility helpers. */
export function getBoardImageDetailsForPlaylist(
  boardType: string,
  layoutId: number | null | undefined,
): BoardImageDetails | null {
  if (boardType === 'moonboard') {
    const effectiveLayoutId = layoutId ?? MOONBOARD_LAYOUTS['moonboard-2024'].id;
    const layoutEntry = Object.entries(MOONBOARD_LAYOUTS).find(([, layout]) => layout.id === effectiveLayoutId);
    if (!layoutEntry) return null;
    const setIds = MOONBOARD_SETS[layoutEntry[0] as MoonBoardLayoutKey].map((set) => set.id);
    return getBoardImageDetailsForBoard({
      board_name: boardType,
      layout_id: effectiveLayoutId,
      size_id: 1,
      set_ids: setIds,
    });
  }
  const boardName = boardType as BoardName;
  const effectiveLayoutId = layoutId ?? Number(Object.keys(LAYOUTS[boardName] ?? {})[0]);
  if (!effectiveLayoutId) return null;
  const sizes = getSizesForLayoutId(boardName, effectiveLayoutId);
  if (sizes.length === 0) return null;
  const largest = sizes.reduce((best, size) =>
    (size.edgeRight - size.edgeLeft) * (size.edgeTop - size.edgeBottom) >
    (best.edgeRight - best.edgeLeft) * (best.edgeTop - best.edgeBottom)
      ? size
      : best,
  );
  const sets = getSetsForLayoutAndSize(boardName, effectiveLayoutId, largest.id);
  if (sets.length === 0) return null;
  try {
    return getBoardImageDetailsForBoard({
      board_name: boardName,
      layout_id: effectiveLayoutId,
      size_id: largest.id,
      set_ids: sets.map((set) => set.id),
    });
  } catch {
    return null;
  }
}
