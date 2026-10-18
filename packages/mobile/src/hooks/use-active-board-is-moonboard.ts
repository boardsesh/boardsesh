import { isMoonboardBoardName, toBoardName } from '@boardsesh/board-config';
import { useActiveBoard } from '../lib/graphql/use-active-board';

/**
 * True while the climber's active board is a MoonBoard: the gate for the
 * MoonBoard-only settings (the grid's letters and numbers, Active holds).
 */
export function useActiveBoardIsMoonboard(): boolean {
  const { data: activeBoard } = useActiveBoard();
  return isMoonboardBoardName(toBoardName(activeBoard?.boardType));
}
