import { useCallback, useSyncExternalStore } from 'react';
import type { BoardName } from '@boardsesh/shared-schema';
import { useClimbProgressStore } from '../lib/climb-progress-context';
import { climbProgressKey, NO_CLIMB_PROGRESS_ENTRIES } from '../lib/climb-progress-store';

const noSubscription = () => () => {};

/** An empty scoped bucket is authoritative; undefined means no list scope. */
export function useClimbProgressEntries(boardName: BoardName | undefined, climbUuid: string, angle: number) {
  const store = useClimbProgressStore();
  const key = boardName ? climbProgressKey(boardName, climbUuid, angle) : null;
  const subscribe = useCallback(
    (listener: () => void) => (store && key ? store.subscribe(key, listener) : noSubscription()),
    [store, key],
  );
  const snapshot = useCallback(() => (store && key ? store.getSnapshot(key) : NO_CLIMB_PROGRESS_ENTRIES), [store, key]);
  const entries = useSyncExternalStore(subscribe, snapshot, snapshot);
  return store && key ? entries : undefined;
}
