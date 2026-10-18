import { isMoonboardBoardName, toBoardName } from '@boardsesh/board-config';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useActiveBoard } from '../lib/graphql/use-active-board';

/** True when this active board is a MoonBoard. */
export function activeBoardIsMoonboard(activeBoard: Pick<UserBoard, 'boardType'> | null | undefined): boolean {
  return isMoonboardBoardName(toBoardName(activeBoard?.boardType));
}

/**
 * True while the climber's active board is a MoonBoard: the gate for the
 * MoonBoard-only settings (the grid's letters and numbers, Active holds).
 */
export function useActiveBoardIsMoonboard(): boolean {
  const { data: activeBoard } = useActiveBoard();
  return activeBoardIsMoonboard(activeBoard);
}
