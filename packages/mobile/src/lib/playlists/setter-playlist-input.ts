import { getBoardCapabilities } from '@boardsesh/board-config';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';

/**
 * A computed playlist never inherits unrelated filters from the search sheet.
 *
 * On an angle-bound board (Woods) it asks for every angle: a setter's page is
 * their whole catalogue, and without the opt-in the search keeps only the climbs
 * set at the viewer's current angle (#5642) — a setter reached from a feed card
 * would show a fraction of their climbs, with no filter sheet on this page to
 * widen it. Gated on the capability because on Kilter the same opt-in is the
 * ~5.6 s cross-angle query (see `angleBoundClimbs` in @boardsesh/board-config).
 */
export function setterPlaylistInput(
  setter: string,
  board: Pick<ClimbSearchInput, 'boardName' | 'layoutId' | 'sizeId' | 'setIds' | 'angle'>,
): ClimbSearchInput {
  return {
    boardName: board.boardName,
    layoutId: board.layoutId,
    sizeId: board.sizeId,
    setIds: board.setIds,
    angle: board.angle,
    setter: [setter],
    sortBy: 'creation',
    sortOrder: 'desc',
    boulders: true,
    routes: true,
    ...(getBoardCapabilities(board.boardName).angleBoundClimbs ? { crossAngleStats: true } : {}),
  };
}
