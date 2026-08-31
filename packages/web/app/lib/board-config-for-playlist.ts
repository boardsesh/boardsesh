import type { UserBoard } from '@boardsesh/shared-schema';
import type { BoardName, BoardDetails, Climb } from './types';
import {
  getSizesForLayoutId,
  getSetsForLayoutAndSize,
  getBoardDetails,
  hasProductSizeEdges,
  LAYOUTS,
} from './board-constants';
import { type MoonBoardLayoutKey, getMoonBoardDetails, MOONBOARD_LAYOUTS, MOONBOARD_SETS } from './moonboard-config';
import { canAddClimbToBoard } from './board-compatibility';

/**
 * Derive BoardDetails for a playlist using the largest available size and all sets.
 * Used when viewing playlists outside of a board session.
 */
export function getBoardDetailsForPlaylist(
  boardType: string,
  layoutId: number | null | undefined,
): BoardDetails | null {
  const boardName = boardType as BoardName;

  if (boardName === 'moonboard') {
    return getMoonBoardDetailsForPlaylist(layoutId);
  }

  const effectiveLayoutId = layoutId ?? getDefaultLayoutForBoard(boardName);
  if (!effectiveLayoutId) return null;

  const sizes = getSizesForLayoutId(boardName, effectiveLayoutId).filter(hasProductSizeEdges);
  if (sizes.length === 0) return null;

  // Pick the size with the largest area
  const largest = sizes.reduce((best, size) => {
    const area = (size.edgeRight - size.edgeLeft) * (size.edgeTop - size.edgeBottom);
    const bestArea = (best.edgeRight - best.edgeLeft) * (best.edgeTop - best.edgeBottom);
    return area > bestArea ? size : best;
  });

  const sets = getSetsForLayoutAndSize(boardName, effectiveLayoutId, largest.id);
  if (sets.length === 0) return null;

  const setIds = sets.map((s) => s.id);

  try {
    return getBoardDetails({
      board_name: boardName,
      layout_id: effectiveLayoutId,
      size_id: largest.id,
      set_ids: setIds,
    });
  } catch {
    return null;
  }
}

function getMoonBoardDetailsForPlaylist(layoutId: number | null | undefined): BoardDetails | null {
  const effectiveLayoutId = layoutId ?? MOONBOARD_LAYOUTS['moonboard-2024'].id;

  const layoutEntry = Object.entries(MOONBOARD_LAYOUTS).find(([, layout]) => layout.id === effectiveLayoutId);
  if (!layoutEntry) return null;

  const [layoutKey] = layoutEntry;
  const sets = MOONBOARD_SETS[layoutKey as MoonBoardLayoutKey] || [];
  const setIds = sets.map((s) => s.id);

  try {
    return getMoonBoardDetails({
      layout_id: effectiveLayoutId,
      set_ids: setIds,
    });
  } catch {
    return null;
  }
}

/**
 * Get the default layout ID for a board type.
 * Returns the first layout in the LAYOUTS map.
 */
export function getDefaultLayoutForBoard(boardType: string): number | null {
  if (boardType === 'moonboard') {
    return MOONBOARD_LAYOUTS['moonboard-2024'].id;
  }

  const boardLayouts = LAYOUTS[boardType as BoardName];
  if (!boardLayouts) return null;

  const ids = Object.keys(boardLayouts).map(Number);
  return ids.length > 0 ? ids[0] : null;
}

/** Default angle per board type. Kilter/MoonBoard default to 40, Tension to 40 (all support it). */
const DEFAULT_ANGLES: Record<string, number> = {
  kilter: 40,
  tension: 40,
  moonboard: 40,
};
const FALLBACK_ANGLE = 40;

/**
 * Get a default angle for a board type.
 */
export function getDefaultAngleForBoard(boardType: string): number {
  return DEFAULT_ANGLES[boardType] ?? FALLBACK_ANGLE;
}

/**
 * Get BoardDetails for a UserBoard by resolving its board type, layout, size, and sets.
 */
export function getUserBoardDetails(board: UserBoard): BoardDetails | null {
  try {
    const setIds = board.setIds.split(',').map(Number);
    if (board.boardType === 'moonboard') {
      return getMoonBoardDetails({ layout_id: board.layoutId, set_ids: setIds }) as BoardDetails;
    }
    return getBoardDetails({
      board_name: board.boardType as BoardName,
      layout_id: board.layoutId,
      size_id: board.sizeId,
      set_ids: setIds,
    });
  } catch {
    return null;
  }
}

export type SessionBoardConfig = {
  boardType: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: number[];
};

export type ClimbFitStatus = 'exact' | 'upsized' | 'incompatible';

export type ClimbFitResult = {
  details: BoardDetails;
  status: ClimbFitStatus;
};

function buildDetailsSafely(
  boardName: BoardName,
  layoutId: number,
  sizeId: number,
  setIds: number[],
): BoardDetails | null {
  if (boardName === 'moonboard') {
    try {
      return getMoonBoardDetails({ layout_id: layoutId, set_ids: setIds }) as BoardDetails;
    } catch {
      return null;
    }
  }
  try {
    return getBoardDetails({
      board_name: boardName,
      layout_id: layoutId,
      size_id: sizeId,
      set_ids: setIds,
    });
  } catch {
    return null;
  }
}

/**
 * Resolve a BoardDetails for rendering a playlist climb preview, preferring
 * the user's current session board. If the climb fits the session's size/sets,
 * render at that size. If not, find the smallest larger size on the same
 * layout that fits. If nothing fits (or the layout/board type don't match),
 * fall back to the generic largest-size playlist details.
 */
export function resolveBoardDetailsForClimb(
  climb: Climb,
  sessionBoard: SessionBoardConfig | null,
): ClimbFitResult | null {
  const climbBoardType = climb.boardType as BoardName | undefined;
  const climbLayoutId = climb.layoutId ?? null;

  // No session at all — behave like before: pick the generic (largest) preview.
  if (!sessionBoard) {
    const details = getBoardDetailsForPlaylist(climbBoardType ?? '', climbLayoutId);
    return details ? { details, status: 'exact' } : null;
  }

  // Layout or board type mismatch — fully incompatible, render on generic preview.
  if (
    !climbBoardType ||
    climbBoardType !== sessionBoard.boardType ||
    climbLayoutId == null ||
    climbLayoutId !== sessionBoard.layoutId
  ) {
    const details = getBoardDetailsForPlaylist(climbBoardType ?? sessionBoard.boardType, climbLayoutId);
    return details ? { details, status: 'incompatible' } : null;
  }

  // Try the exact session config first.
  const exactDetails = buildDetailsSafely(
    sessionBoard.boardType,
    sessionBoard.layoutId,
    sessionBoard.sizeId,
    sessionBoard.setIds,
  );
  if (exactDetails) {
    // `BoardDetails` already carries `size_id`, which is what `canAddClimbToBoard`
    // reads for its size-containment rule — nothing extra to thread here. It only
    // bites when the climb also names its `compatibleSizeIds`, which is how a
    // Woods 8x10 climb stops reading as an exact fit on a 12x12 wall whose hold
    // ids happen to cover the same numbers.
    const fit = canAddClimbToBoard(climb, exactDetails);
    if (fit.ok) {
      return { details: exactDetails, status: 'exact' };
    }
  }

  // Otherwise walk larger sizes on the same layout and pick the smallest that fits.
  // Moonboard doesn't have multiple sizes — skip the search. We also bail out
  // when the exact session details couldn't be built: without them we don't
  // know the session's area, and defaulting to 0 would let smaller sizes slip
  // through as "upsized" candidates.
  if (sessionBoard.boardType !== 'moonboard' && exactDetails) {
    const sessionArea =
      (exactDetails.edge_right - exactDetails.edge_left) * (exactDetails.edge_top - exactDetails.edge_bottom);

    const candidates = getSizesForLayoutId(sessionBoard.boardType, sessionBoard.layoutId)
      .filter(hasProductSizeEdges)
      .filter((size) => size.id !== sessionBoard.sizeId)
      .map((size) => ({
        size,
        area: (size.edgeRight - size.edgeLeft) * (size.edgeTop - size.edgeBottom),
      }))
      .filter(({ area }) => area > sessionArea)
      .sort((a, b) => a.area - b.area);

    for (const { size } of candidates) {
      const availableSets = getSetsForLayoutAndSize(sessionBoard.boardType, sessionBoard.layoutId, size.id);
      if (availableSets.length === 0) continue;

      const availableSetIds = new Set(availableSets.map((s) => s.id));
      const preferredSetIds = sessionBoard.setIds.filter((id) => availableSetIds.has(id));
      // If the user's session sets don't exist on this size, use every set the
      // size publishes so the climb's holds stand a chance of rendering.
      const setIdsToTry = preferredSetIds.length > 0 ? preferredSetIds : availableSets.map((s) => s.id);

      const candidateDetails = buildDetailsSafely(sessionBoard.boardType, sessionBoard.layoutId, size.id, setIdsToTry);
      if (!candidateDetails) continue;

      const fit = canAddClimbToBoard(climb, candidateDetails);
      if (fit.ok) {
        return { details: candidateDetails, status: 'upsized' };
      }
    }
  }

  // Nothing fit — fall back to the generic (largest) preview and mark incompatible.
  const fallback = getBoardDetailsForPlaylist(climbBoardType, climbLayoutId);
  return fallback ? { details: fallback, status: 'incompatible' } : null;
}
