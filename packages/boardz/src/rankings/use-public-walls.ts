import { useQuery } from '@tanstack/react-query';
import { SEARCH_BOARDS, type SearchBoardsQueryResponse } from '@boardsesh/graphql/operations/boards';
import { graphqlRequest } from '../api/graphql-client';
import type { ActiveBoard } from '../board/active-board';

// The server's page maximum. It lists the newest walls first and can't sort by
// activity, so the busiest are picked from the newest fifty.
const PAGE_SIZE = 50;
const MAX_WALLS = 8;

/**
 * Walls with this board's layout and size that anyone can see (gyms' boards and
 * climbers' shared ones) where someone has logged a send. Most climbers first.
 */
export function usePublicWalls(board: Pick<ActiveBoard, 'boardName' | 'layoutId' | 'sizeId'> | null) {
  return useQuery({
    queryKey: ['publicWalls', board?.boardName, board?.layoutId, board?.sizeId],
    queryFn: async () => {
      if (!board) return [];
      const { searchBoards } = await graphqlRequest<SearchBoardsQueryResponse>(SEARCH_BOARDS, {
        input: { boardType: board.boardName, layoutIds: [board.layoutId], sizeIds: [board.sizeId], limit: PAGE_SIZE },
      });
      return searchBoards.boards
        .filter((wall) => wall.totalAscents > 0)
        .sort(
          (first, second) => second.uniqueClimbers - first.uniqueClimbers || second.totalAscents - first.totalAscents,
        )
        .slice(0, MAX_WALLS);
    },
    enabled: board !== null,
    staleTime: 10 * 60_000,
  });
}
