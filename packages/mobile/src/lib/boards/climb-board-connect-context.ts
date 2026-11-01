// Connect follows the climb (#7001).
//
// At a gym with several boards, the current climb can be on a board other than
// the active one: a MoonBoard climb in the queue while the Kilter is selected.
// Connect used to scan for the active board's family, so the picker offered the
// Kilter and the Tension and never the MoonBoard the climb needs. Now a connect
// first moves to the gym board that draws the current climb, then connects
// there.
//
// The drawer host provides this, because it already owns the board switch that
// tells a crew session about the move. Outside it (no host mounted) the value is
// null and a connect goes to the active board, as before.

import { createContext, useContext } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { ClimbBoardModel } from './gym-board-for-climb';

export type ClimbBoardMove =
  /** The active board draws the climb, or no board at this gym does. */
  | { kind: 'none' }
  /** The active board is now `board`. The caller connects to it. */
  | { kind: 'switched'; board: UserBoard }
  /** The switch was tried and did not happen. The switch has already said why. */
  | { kind: 'failed' };

export type ClimbBoardConnectValue = {
  /**
   * Switch to the gym board that draws `climb`, or the current climb when none
   * is named. Pass the climb when the caller has just made it current: the
   * queue may not have caught up yet.
   */
  moveToClimbBoard: (climb?: ClimbBoardModel | null) => Promise<ClimbBoardMove>;
};

export const ClimbBoardConnectContext = createContext<ClimbBoardConnectValue | null>(null);

export function useClimbBoardConnect(): ClimbBoardConnectValue | null {
  return useContext(ClimbBoardConnectContext);
}
