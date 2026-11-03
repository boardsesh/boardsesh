import { useMemo } from 'react';
import type { QueueWalkBoard } from '@boardsesh/play-view';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useReachableBoardKeys } from './use-reachable-board-keys';
import { reachableClimbPredicate, toActiveBoardCompatibilityConfig } from './active-board-compatibility';

const BOARD_BLIND: QueueWalkBoard = {};

/**
 * The board a swipe walk is filtered against, built by the same helpers the
 * queue provider's `nextClimb` uses: the active board's identity (a queued
 * climb it can't draw is walked past, #5099) and the other walls at its gym (a
 * climb on one of them stays a target). For surfaces that describe the walk
 * without taking it, such as the queue sheet's "Then from" rows, so they agree
 * with the swipe.
 *
 * One object per active board and gym roster, so it is safe in memo deps.
 */
export function useQueueWalkBoard(): QueueWalkBoard {
  const { data: activeBoard } = useActiveBoard();
  const reachableBoardKeys = useReachableBoardKeys(activeBoard);
  return useMemo(() => {
    const activeConfig = toActiveBoardCompatibilityConfig(activeBoard);
    const isReachable = reachableClimbPredicate(reachableBoardKeys);
    return activeConfig || isReachable ? { activeConfig, isReachable } : BOARD_BLIND;
  }, [activeBoard, reachableBoardKeys]);
}
