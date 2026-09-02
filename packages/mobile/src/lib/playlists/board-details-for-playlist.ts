import type { BoardName } from '@boardsesh/shared-schema';
import {
  getDefaultRenderBoard,
  resolveRenderBoard,
  toBoardName,
  type RenderBoardConfig,
} from '@boardsesh/board-config';

export type PlaylistBoardConfig = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: number[];
};

// The board metadata behind a (boardType, layoutId) key is static, so the
// resolved config never changes — memoise it. Callers hit this per row in
// virtualised lists (session ticks, logbook) and the compute runs a sizes
// filter + biggest-size reduce, so the cache keeps repeat lookups O(1). The
// FIFO cap just bounds memory; the real key space (every board × layout) sits
// well under the limit, so it effectively never evicts.
const BOARD_CONFIG_CACHE_LIMIT = 64;
const boardConfigCache = new Map<string, PlaylistBoardConfig | null>();

/**
 * Resolve a renderable board config for something that only carries `boardType`
 * + `layoutId` — a playlist, or a tick whose payload has no resolved
 * `renderBoard`. This is rung 4 of the shared ladder (`getDefaultRenderBoard`):
 * the layout's biggest size with every set installed, which is all you can say
 * without knowing whose climb it is.
 *
 * Anything that renders a *logged* climb should prefer the `renderBoard` the
 * backend resolved for it — see `renderBoardToPlaylistConfig` — and only fall
 * back here. Returns null when the board/layout can't resolve so the caller
 * falls back cleanly to the plain colour tile. Memoised by board key.
 */
export function getBoardConfigForPlaylist(
  boardType: string,
  layoutId: number | null | undefined,
): PlaylistBoardConfig | null {
  const cacheKey = `${boardType}-${layoutId ?? ''}`;
  const cached = boardConfigCache.get(cacheKey);
  if (cached !== undefined) return cached;

  // `boardType` is a free-form string off the playlist/tick record; a resolved
  // config means the shared helper's own `toBoardName` guard accepted it.
  const resolved = getDefaultRenderBoard(boardType, layoutId);
  const boardName = toBoardName(boardType);
  const result = resolved && boardName ? { boardName, ...resolved } : null;

  if (boardConfigCache.size >= BOARD_CONFIG_CACHE_LIMIT) {
    const oldestKey = boardConfigCache.keys().next().value;
    if (oldestKey !== undefined) boardConfigCache.delete(oldestKey);
  }
  boardConfigCache.set(cacheKey, result);
  return result;
}

/**
 * The board config to draw a specific CLIMB on its own board — the same rung-4
 * fallback as `getBoardConfigForPlaylist`, except the climb's own
 * `compatibleSizeIds` picks the size.
 *
 * That distinction only matters where a board's sizes have independent hold
 * coordinate spaces. Woods numbers the 8x10's holds 0-484 and the 12x12's 0-893
 * each from its own origin, so an 8x10 climb's ids all exist on the 12x12 as
 * COMPLETELY DIFFERENT holds: the layout default (always the 12x12) doesn't fail
 * to render, it silently renders a different climb. `resolveRenderBoard` has the
 * per-board rules for this; with no tick board and no owner boards it degrades to
 * exactly `getDefaultRenderBoard` whenever the climb names no sizes, so a climb
 * without `compatibleSizeIds` keeps today's answer.
 *
 * See `docs/board-art-geometry.md` for the coordinate contract.
 */
export function getBoardConfigForClimb(
  boardType: string,
  layoutId: number | null | undefined,
  compatibleSizeIds: readonly number[] | null | undefined,
): PlaylistBoardConfig | null {
  const boardName = toBoardName(boardType);
  if (!boardName) return null;
  // Cheap to compute (no per-hold work) and called once per resolve rather than
  // once per row, so this deliberately skips the memo above: keying a cache on a
  // size LIST is more bookkeeping than the reduce it would save.
  const resolved = resolveRenderBoard({ boardType, climbLayoutId: layoutId, compatibleSizeIds });
  return resolved ? { boardName, ...resolved } : null;
}

/**
 * The board config to draw a logged climb on: the `renderBoard` the backend
 * resolved (the board it was climbed on, or the closest one the climber has),
 * falling back to the layout default for payloads that don't carry one — an
 * older app talking to an older server, or a feed that doesn't resolve it.
 */
export function renderBoardToPlaylistConfig(
  boardType: string,
  layoutId: number | null | undefined,
  renderBoard: RenderBoardConfig | null | undefined,
): PlaylistBoardConfig | null {
  const boardName = toBoardName(boardType);
  if (boardName && renderBoard && renderBoard.setIds.length > 0) {
    return {
      boardName,
      layoutId: renderBoard.layoutId,
      sizeId: renderBoard.sizeId,
      setIds: renderBoard.setIds,
    };
  }
  return getBoardConfigForPlaylist(boardType, layoutId);
}
