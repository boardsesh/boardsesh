import type { ClimbSearchInput } from '@boardsesh/shared-schema';

/** A computed playlist never inherits unrelated filters from the search sheet. */
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
  };
}
