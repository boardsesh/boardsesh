import { toBoardName, type ActiveBoardForCompatibility } from '@boardsesh/board-config';
import { isClimbOnReachableBoard } from '@boardsesh/queue';
import type { ReachableClimbPredicate } from '@boardsesh/play-view';

/**
 * The board identity the compatibility helpers need, or undefined when we can't
 * name the active board (an unrecognised `boardType`, or none picked yet).
 *
 * Identity only — board name + layout. A same-layout different-size climb still
 * renders on its own board, so neither the add gate nor the swipe skip should
 * act on it; hold-id and size containment stay in `canAddClimbToBoard`.
 * `undefined` fails open everywhere it is used.
 *
 * The queue provider's `nextClimb` and the queue sheet's Then from walk
 * (`useQueueWalkBoard`) both read it, so the sheet skips what the swipe skips.
 */
export function toActiveBoardCompatibilityConfig(
  activeBoard: { boardType: string; layoutId: number } | null | undefined,
): ActiveBoardForCompatibility | undefined {
  if (!activeBoard) return undefined;
  const activeBoardName = toBoardName(activeBoard.boardType);
  return activeBoardName ? { boardName: activeBoardName, layoutId: activeBoard.layoutId } : undefined;
}

/**
 * A climb on one of the other walls at the active board's gym is somewhere the
 * climber can walk to, so a forward walk keeps it as a target instead of
 * skipping past it (#5099). Undefined with no other walls: nothing is reachable
 * beyond the active board. Build it once per roster (`useMemo`), since it feeds
 * the forward-selection memos.
 */
export function reachableClimbPredicate(reachableBoardKeys: ReadonlySet<string>): ReachableClimbPredicate | undefined {
  if (reachableBoardKeys.size === 0) return undefined;
  return (climb) => isClimbOnReachableBoard(climb, reachableBoardKeys);
}
