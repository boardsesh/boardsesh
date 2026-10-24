import { useCallback, useSyncExternalStore } from 'react';
import {
  getUserReadRefreshEpoch,
  subscribeUserReadRefresh,
  type OfflineUserReadFamily,
} from '../lib/graphql/offline-user-read-recovery';

/** Re-run state-based readers whose last response came from SQLite. */
export function useUserReadRefresh(family: OfflineUserReadFamily): number {
  const getSnapshot = useCallback(() => getUserReadRefreshEpoch(family), [family]);
  return useSyncExternalStore(subscribeUserReadRefresh, getSnapshot, getSnapshot);
}
