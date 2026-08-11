import type { BoardName } from '@boardsesh/shared-schema';
import { getDefaultRenderBoard, toBoardName, type RenderBoardConfig } from '@boardsesh/board-config';

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
