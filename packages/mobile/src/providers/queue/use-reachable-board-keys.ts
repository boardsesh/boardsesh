// Which board models the climber can reach on foot right now.
//
// "Reachable" is the distinction the queue has been missing. Skipping a queued
// climb the active board can't draw (#5099) is right when that board is in
// another city — it renders nothing and lights nothing. It is wrong when the
// board is the other wall in the same room, because at a multi-wall gym mixing
// the two is the deliberate act, and skipping silently deletes half the session.
//
// Expressed as a SET of board-model keys rather than a "is this the sibling
// wall" boolean on purpose: that shape is also what a gym-wide mode wants
// (#5349). Today the set is the gym's roster; later it is whatever walls the
// climber has selected. Neither the navigation selectors nor the add gate ever
// learn what a gym is.

import { useMemo } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import { configKey } from '@boardsesh/queue';
import { useGymBoards } from '../../lib/graphql/hooks/use-gym-boards';

/**
 * Board-model keys for the other walls at the active board's gym.
 *
 * The active board is excluded — it is reachable by definition, and leaving it
 * in would mark its own climbs as "on another wall". A board with no gym (a home
 * wall) has no siblings, so the set is empty and every consumer falls back to
 * today's behaviour.
 *
 * The set identity is stable while the roster is, because it feeds the memo that
 * decides the next swipe target.
 */
export function useReachableBoardKeys(activeBoard: UserBoard | null | undefined): ReadonlySet<string> {
  const { data: gymBoards } = useGymBoards(activeBoard?.gymUuid ?? null);

  return useMemo(() => {
    const reachableKeys = new Set<string>();
    if (!gymBoards || !activeBoard) return reachableKeys;

    for (const board of gymBoards) {
      if (board.uuid === activeBoard.uuid) continue;
      // Two walls of the same model are one key. That is the right grain here:
      // the question is "can the climber walk to something that draws this
      // climb", and either wall answers it.
      reachableKeys.add(configKey({ boardName: board.boardType, layoutId: board.layoutId }));
    }
    // A sibling sharing the active board's model would make every climb look
    // foreign-but-reachable, which reads as "move to the other wall" for climbs
    // already drawable here.
    reachableKeys.delete(configKey({ boardName: activeBoard.boardType, layoutId: activeBoard.layoutId }));
    return reachableKeys;
  }, [gymBoards, activeBoard]);
}
