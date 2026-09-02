import type { BoardName } from '@boardsesh/shared-schema';
import {
  canAddClimbToBoard,
  type BoardCompatibilityTarget,
  type ClimbCompatibilityInput,
} from '@boardsesh/board-config';
import { getProductSize, getSetsForLayoutAndSize, getSizesForLayoutId } from '@boardsesh/board-constants/product-sizes';
import { getBoardRenderData } from '../board-details';
import { getBoardConfigForClimb } from './board-details-for-playlist';
import type { PlaylistRenderBoard } from './use-playlist-render-board';

export type PlaylistClimbRenderBoardFit = 'exact' | 'upsized' | 'incompatible';

/**
 * The climb fields this resolver reads: board identity + the frames/sizes the
 * fit check needs, plus the angle the fallback board is drawn at. Structural
 * rather than the queue `Climb` so queue items, schema climbs and the thinner
 * board-presence climbs all satisfy it without a cast (see
 * `lib/boards/climb-render-board`, which is the board-shaped door onto this).
 */
export type ClimbRenderBoardInput = ClimbCompatibilityInput & { angle: number };

export type PlaylistClimbRenderBoardResult = {
  renderBoard: PlaylistRenderBoard;
  fit: PlaylistClimbRenderBoardFit;
  incompatible: boolean;
};

function parseSetIds(setIds: string): number[] {
  return setIds
    .split(',')
    .map((setId) => Number(setId))
    .filter((setId) => Number.isFinite(setId) && setId > 0);
}

function toRenderBoard(boardName: BoardName, layoutId: number, sizeId: number, setIds: number[], angle: number) {
  return {
    boardName,
    layoutId,
    sizeId,
    setIds: setIds.join(','),
    angle,
  };
}

// `canAddClimbToBoard` caches its ~1400-entry valid-hold-id Set on the target
// object's IDENTITY, so a fresh target per call rebuilds that Set every time —
// once per queue row, and once per candidate size inside the upsize search. The
// board data behind a `name-layout-size-sets` key is static, so hand the same
// target back for the same key. The FIFO cap only bounds memory; a session
// touches a handful of boards. Mirrors `getBoardRenderData`'s memo.
const RENDER_BOARD_TARGET_CACHE_LIMIT = 32;
const renderBoardTargetCache = new Map<string, BoardCompatibilityTarget>();

export function getPlaylistRenderBoardTarget(renderBoard: PlaylistRenderBoard): BoardCompatibilityTarget {
  const cacheKey = `${renderBoard.boardName}-${renderBoard.layoutId}-${renderBoard.sizeId}-${renderBoard.setIds}`;
  const cached = renderBoardTargetCache.get(cacheKey);
  if (cached) return cached;

  const target = buildPlaylistRenderBoardTarget(renderBoard);
  if (renderBoardTargetCache.size >= RENDER_BOARD_TARGET_CACHE_LIMIT) {
    const oldestKey = renderBoardTargetCache.keys().next().value;
    if (oldestKey !== undefined) renderBoardTargetCache.delete(oldestKey);
  }
  renderBoardTargetCache.set(cacheKey, target);
  return target;
}

function buildPlaylistRenderBoardTarget(renderBoard: PlaylistRenderBoard): BoardCompatibilityTarget {
  const boardName = renderBoard.boardName as BoardName;
  const setIds = parseSetIds(renderBoard.setIds);
  const renderData = getBoardRenderData({
    boardName,
    layoutId: renderBoard.layoutId,
    sizeId: renderBoard.sizeId,
    setIds,
  });

  return {
    board_name: boardName,
    layout_id: renderBoard.layoutId,
    holdsData: renderData?.holdsData,
    // MoonBoard holdsData covers the full grid whichever add-on sets are bolted
    // on, so hand over the wall's sets too. Without them a wooden-set climb reads
    // as an exact fit on a base-only wall: the row renders undimmed, and the tap
    // then falls through the set-scoped backend fetch into a one-item queue.
    set_ids: setIds,
    // The wall's size, for the same reason one rung down: Woods numbers each of
    // its two boards' holds from its own origin, so an 8x10 climb's hold ids all
    // exist on a 12x12 as different holds and hold-id containment alone reads it
    // as an exact fit. Both `canAddClimbToBoard` call sites in this file resolve
    // their target through here, so threading it once covers both.
    size_id: renderBoard.sizeId,
  };
}

function resolveGenericRenderBoard(
  climb: ClimbRenderBoardInput,
  fallbackBoardName?: BoardName,
): PlaylistClimbRenderBoardResult | null {
  const boardType = climb.boardType ?? fallbackBoardName;
  if (!boardType) return null;
  const resolved = getBoardConfigForClimb(boardType, climb.layoutId, climb.compatibleSizeIds);
  if (!resolved) return null;
  return {
    renderBoard: toRenderBoard(resolved.boardName, resolved.layoutId, resolved.sizeId, resolved.setIds, climb.angle),
    fit: 'exact',
    incompatible: false,
  };
}

function resolveIncompatibleRenderBoard(
  climb: ClimbRenderBoardInput,
  fallbackBoardName: BoardName,
): PlaylistClimbRenderBoardResult | null {
  const resolved = getBoardConfigForClimb(
    climb.boardType ?? fallbackBoardName,
    climb.layoutId,
    climb.compatibleSizeIds,
  );
  if (!resolved) return null;
  return {
    renderBoard: toRenderBoard(resolved.boardName, resolved.layoutId, resolved.sizeId, resolved.setIds, climb.angle),
    fit: 'incompatible',
    incompatible: true,
  };
}

function resolveUpsizedRenderBoard(
  climb: ClimbRenderBoardInput,
  activeBoard: PlaylistRenderBoard,
): PlaylistClimbRenderBoardResult | null {
  const boardName = activeBoard.boardName as BoardName;
  const activeSize = getProductSize(boardName, activeBoard.sizeId);
  if (!activeSize) return null;

  const activeArea = (activeSize.edgeRight - activeSize.edgeLeft) * (activeSize.edgeTop - activeSize.edgeBottom);
  const activeSetIds = parseSetIds(activeBoard.setIds);

  const candidates = getSizesForLayoutId(boardName, activeBoard.layoutId)
    .filter((size) => size.id !== activeBoard.sizeId)
    .map((size) => ({
      size,
      area: (size.edgeRight - size.edgeLeft) * (size.edgeTop - size.edgeBottom),
    }))
    .filter(({ area }) => area > activeArea)
    .sort((left, right) => left.area - right.area);

  for (const { size } of candidates) {
    const availableSets = getSetsForLayoutAndSize(boardName, activeBoard.layoutId, size.id);
    if (availableSets.length === 0) continue;

    const availableSetIds = new Set(availableSets.map((set) => set.id));
    const preferredSetIds = activeSetIds.filter((setId) => availableSetIds.has(setId));
    const candidateSetIds = preferredSetIds.length > 0 ? preferredSetIds : availableSets.map((set) => set.id);
    const candidateRenderBoard = toRenderBoard(
      boardName,
      activeBoard.layoutId,
      size.id,
      candidateSetIds,
      activeBoard.angle,
    );
    const fit = canAddClimbToBoard(climb, getPlaylistRenderBoardTarget(candidateRenderBoard));

    if (fit.ok) {
      return {
        renderBoard: candidateRenderBoard,
        fit: 'upsized',
        incompatible: true,
      };
    }
  }

  return null;
}

/**
 * Resolve the board a playlist row should render on.
 *
 * The active board wins when it can actually render the climb. A climb from a
 * different board/layout, or one that needs a larger wall, falls back to the
 * climb's own renderable board and is marked incompatible so the row can be
 * dimmed while still opening the drawer.
 */
export function resolvePlaylistClimbRenderBoard(
  climb: ClimbRenderBoardInput,
  activeBoard: PlaylistRenderBoard | null,
  activeBoardTarget?: BoardCompatibilityTarget,
): PlaylistClimbRenderBoardResult | null {
  if (!activeBoard) {
    return resolveGenericRenderBoard(climb);
  }

  const activeBoardName = activeBoard.boardName as BoardName;
  if (
    !climb.boardType ||
    climb.boardType !== activeBoard.boardName ||
    climb.layoutId == null ||
    climb.layoutId !== activeBoard.layoutId
  ) {
    return resolveIncompatibleRenderBoard(climb, activeBoardName);
  }

  const exactFit = canAddClimbToBoard(climb, activeBoardTarget ?? getPlaylistRenderBoardTarget(activeBoard));
  if (exactFit.ok) {
    return {
      renderBoard: activeBoard,
      fit: 'exact',
      incompatible: false,
    };
  }

  return resolveUpsizedRenderBoard(climb, activeBoard) ?? resolveIncompatibleRenderBoard(climb, activeBoardName);
}
