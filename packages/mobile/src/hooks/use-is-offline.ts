import { useSyncExternalStore } from 'react';
import { onlineManager } from '@tanstack/react-query';

/**
 * Reactive "is this app effectively offline?" flag, backed by React Query's
 * onlineManager. Re-renders on every connectivity change. The offline-browse
 * read path and the sync-issues surface both branch on this.
 *
 * Wider than the device radio: the connectivity store is what drives
 * `onlineManager` now, so this reads true when the phone has no signal, when our
 * backend is unreachable, AND when the climber has Offline mode on — all three
 * mean "nothing you ask the network for is going to land". A caller that has to
 * tell those apart, to say which side is at fault, wants
 * `useConnectivity().reason` instead.
 */
export function useIsOffline(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => onlineManager.subscribe(onStoreChange),
    () => !onlineManager.isOnline(),
    () => false,
  );
}
