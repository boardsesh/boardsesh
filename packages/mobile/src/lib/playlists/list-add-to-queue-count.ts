// The "Add 12 to queue" count of a list with views (a playlist, a smart list, a
// setter page). Its own module: it reads every row's render board, which pulls
// in the board catalogue, and playlist-view.ts stays free of that.

import type { Climb } from '@boardsesh/queue';
import { resolvePlaylistClimbRenderBoard } from './playlist-climb-render-board';
import type { PlaylistRenderBoard } from './use-playlist-render-board';

export type ListAddToQueueCountInput = {
  /** The list's count with no filter, or null while the rows on screen are not filtered. */
  unfilteredCount: number | null;
  /** The filtered count, from the response the rows on screen came in. */
  totalCount: number | undefined;
  /** The settled view keeps only climbs on the active board ("Fits my board"). */
  fitsBoard: boolean;
  hasNextPage: boolean;
  renderBoard: PlaylistRenderBoard | null;
  /** The rows on screen. */
  climbs: readonly Climb[];
};

/**
 * "Add 12 to queue" while the rows on screen are filtered, and only when the
 * number is exactly what the board-scoped add takes: with "Fits my board" on,
 * every counted climb is on this board; otherwise only once every row is
 * loaded, counting the ones this board can show (the rest are dimmed and left
 * out by the add). Undefined keeps the plain "Add to queue", and so does a list
 * with nothing addable: the tap then says there is nothing for this board.
 */
export function listAddToQueueCount({
  unfilteredCount,
  totalCount,
  fitsBoard,
  hasNextPage,
  renderBoard,
  climbs,
}: ListAddToQueueCountInput): number | undefined {
  if (unfilteredCount == null || totalCount === undefined) return undefined;
  if (fitsBoard) return totalCount;
  if (hasNextPage || !renderBoard) return undefined;
  let addableCount = 0;
  for (const climb of climbs) {
    const resolved = resolvePlaylistClimbRenderBoard(climb, renderBoard);
    if (resolved && !resolved.incompatible) addableCount += 1;
  }
  return addableCount > 0 ? addableCount : undefined;
}
