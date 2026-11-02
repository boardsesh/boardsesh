import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useQueueData } from '../../providers/queue-provider';
import { useDrawerHost, type BoardConfig } from '../../providers/drawer-host-provider';
import { clearLastPick } from '../../lib/last-pick-store';
import { getCredentialGeneration, subscribeToCredentialChanges } from '../../lib/privacy/privacy-cache';

/** The board a pick belongs to: the stored active board, its angle aside (an angle is not another board). */
export function lastPickBoardKey(boardConfig: BoardConfig | null): string | null {
  if (!boardConfig) return null;
  return `${boardConfig.boardName}:${boardConfig.layoutId}:${boardConfig.sizeId}:${boardConfig.setIds}`;
}

type WatchedState = { currentItemUuid: string | null; boardKey: string | null; generation: number };

/**
 * Whether the climber's last pick is over (owner decision A): the queue's
 * current changed after it (a Put on board, a crewmate's put-up, the Lock
 * Screen's or the notification's Next / Previous, the rest timer's
 * auto-advance), the climber changed board, or the account changed (a
 * sign-out, another sign-in).
 */
export function lastPickEnds(previous: WatchedState, next: WatchedState): boolean {
  return (
    previous.currentItemUuid !== next.currentItemUuid ||
    previous.boardKey !== next.boardKey ||
    previous.generation !== next.generation
  );
}

/**
 * Ends the climber's last pick (`lib/last-pick-store.ts`) when it stops being
 * the newest thing the MiniPlayer could show. The bar already ignores a pick
 * made under another current climb (`resolveBarPick`); this drops it for good,
 * so a current that changes back (an Undo) never brings it back.
 *
 * Renders nothing. Mounted once in the root layout, inside the drawer host,
 * beside the other app-wide watchers.
 */
export function LastPickWatcher(): null {
  const { currentClimbQueueItem } = useQueueData();
  const { boardConfig } = useDrawerHost();
  const generation = useSyncExternalStore(
    subscribeToCredentialChanges,
    getCredentialGeneration,
    getCredentialGeneration,
  );
  const currentItemUuid = currentClimbQueueItem?.uuid ?? null;
  const boardKey = lastPickBoardKey(boardConfig);
  const previousRef = useRef<WatchedState | null>(null);
  useEffect(() => {
    const next: WatchedState = { currentItemUuid, boardKey, generation };
    const previous = previousRef.current;
    previousRef.current = next;
    if (previous && lastPickEnds(previous, next)) clearLastPick();
  }, [currentItemUuid, boardKey, generation]);
  return null;
}
