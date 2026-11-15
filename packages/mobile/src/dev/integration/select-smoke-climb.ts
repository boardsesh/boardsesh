import type { Climb, UserBoard } from '@boardsesh/shared-schema';
import type { SearchClimbsQueryResponse } from '../../lib/graphql/operations';

export type SmokeSearchSnapshot = {
  input: unknown;
  pages: readonly SearchClimbsQueryResponse[];
  updatedAt: number;
};

function record(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

/** Never open an old board's cached row after a board switch. */
export function selectSmokeClimb(searches: readonly SmokeSearchSnapshot[], board: UserBoard): Climb | null {
  const matching = searches
    .filter(
      ({ input }) =>
        record(input) &&
        input.boardName === board.boardType &&
        input.layoutId === board.layoutId &&
        input.sizeId === board.sizeId &&
        input.setIds === board.setIds &&
        input.angle === board.angle,
    )
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const climb = matching[0]?.pages[0]?.searchClimbs.climbs[0];
  if (!climb || !climb.frames || climb.boardType !== board.boardType || climb.layoutId !== board.layoutId) return null;
  return climb;
}
