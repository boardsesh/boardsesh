import { useSyncExternalStore } from 'react';
import { onlineManager } from '@tanstack/react-query';

/**
 * Reactive "is the device offline?" flag, backed by React Query's onlineManager
 * (wired to NetInfo in query-provider). Re-renders on every connectivity change.
 * The offline-browse read path and the sync-issues surface both branch on this.
 */
export function useIsOffline(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => onlineManager.subscribe(onStoreChange),
    () => !onlineManager.isOnline(),
    () => false,
  );
}
