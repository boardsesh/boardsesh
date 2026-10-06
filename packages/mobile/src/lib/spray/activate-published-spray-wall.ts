import type { QueryClient } from '@tanstack/react-query';
import type { UserBoard } from '@boardsesh/shared-schema';
import { fetchBoardByUuid } from '../graphql/hooks/fetch-board-by-uuid';
import type { ActivationStage } from './post-publish-bind';

export type ActivatePublishedSprayWallOptions = {
  /** Told as each stage starts, so a bind that never finishes says where it sat. */
  onStage?: (stage: ActivationStage) => void;
  /**
   * Asked right before binding. False means the run that asked for this bind
   * has timed out or been abandoned, and a late bind would flip the active
   * board under whatever the climber is doing now.
   */
  isLive?: () => boolean;
};

/** Publication changes visibility; never persist the private creation snapshot. */
export async function activatePublishedSprayWall(
  queryClient: QueryClient,
  wallUuid: string,
  activateBoard: (board: UserBoard) => Promise<void>,
  { onStage, isLive }: ActivatePublishedSprayWallOptions = {},
): Promise<void> {
  onStage?.('fetch_board');
  const board = await fetchBoardByUuid(wallUuid);
  if (!board) throw new Error('Published wall could not be loaded');
  onStage?.('bind');
  await queryClient.cancelQueries({ queryKey: ['board', wallUuid] });
  // The cache refresh is kept even for a dead run: it is the published row
  // either way, and the next surface to read it should not get the private one.
  queryClient.setQueryData(['board', wallUuid], { board });
  void queryClient.invalidateQueries({ queryKey: ['myBoards'] });
  if (isLive && !isLive()) return;
  await activateBoard(board);
}
