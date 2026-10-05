import type { QueryClient } from '@tanstack/react-query';
import type { UserBoard } from '@boardsesh/shared-schema';
import { fetchBoardByUuid } from '../graphql/hooks/fetch-board-by-uuid';

/** Publication changes visibility; never persist the private creation snapshot. */
export async function activatePublishedSprayWall(
  queryClient: QueryClient,
  wallUuid: string,
  activateBoard: (board: UserBoard) => Promise<void>,
): Promise<void> {
  const board = await fetchBoardByUuid(wallUuid);
  if (!board) throw new Error('Published wall could not be loaded');
  await queryClient.cancelQueries({ queryKey: ['board', wallUuid] });
  queryClient.setQueryData(['board', wallUuid], { board });
  void queryClient.invalidateQueries({ queryKey: ['myBoards'] });
  await activateBoard(board);
}
