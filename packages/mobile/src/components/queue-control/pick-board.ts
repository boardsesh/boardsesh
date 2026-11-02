import type { BoardConfig } from '../play-drawer/play-drawer-types';
import type { LastPick } from '../../lib/last-pick-store';
import { boardLooselyMatches } from '../../lib/boards/board-matches';
import { resolveClimbRenderBoard } from '../../lib/boards/climb-render-board';

export type PickBoard = {
  /** The board the player draws the pick on: its own climb's board, resolved as the player resolves it. */
  renderBoard: BoardConfig | null;
  /**
   * The pick was opened on another board model than the active one (a logbook
   * row's own board): the player raises its switch-board scrim, as for an
   * explicit board override.
   */
  boardMismatch: boolean;
  /** The pick's climb belongs to another board model than the one it is drawn against. */
  climbBoardMismatch: boolean;
};

/**
 * Where the climber's last pick is drawn, and whether that is another board,
 * decided the way the player decides it when it reopens the pick: against the
 * board it was opened on (`LastPick.boardConfig`) or else the active board.
 */
export function resolvePickBoard(pick: LastPick, activeBoardConfig: BoardConfig | null): PickBoard {
  const drawnOn = pick.boardConfig ?? activeBoardConfig;
  const resolution = resolveClimbRenderBoard(pick.item.climb, drawnOn);
  return {
    renderBoard: resolution?.boardConfig ?? null,
    boardMismatch:
      pick.boardConfig != null &&
      activeBoardConfig != null &&
      !boardLooselyMatches(pick.boardConfig, activeBoardConfig),
    climbBoardMismatch: resolution?.fit === 'incompatible',
  };
}
