import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useQueueData, useQueueRestored } from '../../providers/queue-provider';
import { useDrawerHost, type BoardConfig } from '../../providers/drawer-host-provider';
import { carryLastPickOverRestore, clearLastPick } from '../../lib/last-pick-store';
import { getCredentialGeneration, subscribeToCredentialChanges } from '../../lib/privacy/privacy-cache';

/** The board a pick belongs to: the stored active board, its angle aside (an angle is not another board). */
export function lastPickBoardKey(boardConfig: BoardConfig | null): string | null {
  if (!boardConfig) return null;
  return `${boardConfig.boardName}:${boardConfig.layoutId}:${boardConfig.sizeId}:${boardConfig.setIds}`;
}

type WatchedState = {
  currentItemUuid: string | null;
  boardKey: string | null;
  generation: number;
  /** The cold-start queue restore has landed (`useQueueRestored`). */
  restored: boolean;
};

/**
 * What a change does to the climber's last pick:
 * - `ends` (owner decision A): the queue's current changed after it (a Put on
 *   board, a crewmate's put-up, the Lock Screen's or the notification's Next /
 *   Previous, the rest timer's auto-advance), the climber changed board, or the
 *   account changed (a sign-out, another sign-in);
 * - `carries`: the current changed only because the cold-start restore landed
 *   the saved queue on the empty one, which is not the climber's change, so a
 *   pick made before it (from a notification or a link) stays;
 * - `keeps`: nothing it watches changed, or the stored active board arrived
 *   (none before, one now). On a cold start the board is read from storage
 *   after launch, so a pick from a notification can come first; a climber
 *   with no board who picks their first one has not left a board either.
 */
export function lastPickChange(previous: WatchedState, next: WatchedState): 'ends' | 'carries' | 'keeps' {
  const boardArrived = previous.boardKey === null && next.boardKey !== null;
  if ((previous.boardKey !== next.boardKey && !boardArrived) || previous.generation !== next.generation) return 'ends';
  if (previous.currentItemUuid === next.currentItemUuid) return 'keeps';
  // The restore only lands on an empty queue, in the render that marks it done.
  const restoreLanded = !previous.restored && next.restored && previous.currentItemUuid === null;
  return restoreLanded ? 'carries' : 'ends';
}

/**
 * Ends the climber's last pick (`lib/last-pick-store.ts`) when it stops being
 * the newest thing the MiniPlayer could show. The bar already ignores a pick
 * made under another current climb (`resolveBarPick`); this drops it for good,
 * so a current that changes back (an Undo) never brings it back.
 *
 * The cold-start restore is the exception: its climb is not newer than a pick
 * made while it loaded, so the pick is carried over to it. A layout effect, so
 * the bar never paints a frame of the restored climb in the pick's place.
 *
 * Renders nothing. Mounted once in the root layout, inside the drawer host,
 * beside the other app-wide watchers.
 */
export function LastPickWatcher(): null {
  const { currentClimbQueueItem } = useQueueData();
  const restored = useQueueRestored();
  const { boardConfig } = useDrawerHost();
  const generation = useSyncExternalStore(
    subscribeToCredentialChanges,
    getCredentialGeneration,
    getCredentialGeneration,
  );
  const currentItemUuid = currentClimbQueueItem?.uuid ?? null;
  const boardKey = lastPickBoardKey(boardConfig);
  const previousRef = useRef<WatchedState | null>(null);
  useLayoutEffect(() => {
    const next: WatchedState = { currentItemUuid, boardKey, generation, restored };
    const previous = previousRef.current;
    previousRef.current = next;
    if (!previous) return;
    const change = lastPickChange(previous, next);
    if (change === 'ends') clearLastPick();
    else if (change === 'carries') carryLastPickOverRestore(previous.currentItemUuid, currentItemUuid);
  }, [currentItemUuid, boardKey, generation, restored]);
  return null;
}
