import { focusManager, onlineManager, type QueryClient } from '@tanstack/react-query';
import { getPrivacyRevocationGeneration, subscribeToPrivacyRevocations } from '../privacy/privacy-cache';

export type OfflineUserReadFamily = 'logbook' | 'playlists' | 'favorites';

const servedLocally = new Map<OfflineUserReadFamily, Set<string>>();
const refreshEpochs: Record<OfflineUserReadFamily, number> = { logbook: 0, playlists: 0, favorites: 0 };
const listeners = new Set<() => void>();

/** Only successful, still-authorized local responses need network refresh later. */
export function recordLocalUserRead(family: OfflineUserReadFamily, boardName: string): void {
  let boards = servedLocally.get(family);
  if (!boards) {
    boards = new Set();
    servedLocally.set(family, boards);
  }
  boards.add(boardName);
}

export function subscribeUserReadRefresh(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getUserReadRefreshEpoch(family: OfflineUserReadFamily): number {
  return refreshEpochs[family];
}

/** QueryClient cache invalidation cannot wake the list readers' fetched refs. */
export function bindOfflineUserReadRecovery(queryClient: QueryClient): () => void {
  let wasOnline = onlineManager.isOnline();
  let credentialGeneration = getPrivacyRevocationGeneration();
  const unsubscribeCredentials = subscribeToPrivacyRevocations(() => {
    if (getPrivacyRevocationGeneration() === credentialGeneration) return;
    credentialGeneration = getPrivacyRevocationGeneration();
    servedLocally.clear();
  });
  const refresh = () => {
    if (!onlineManager.isOnline() || servedLocally.size === 0) return;
    const pending = new Map(servedLocally);
    servedLocally.clear();
    for (const [family, boards] of pending) {
      if (family === 'logbook') {
        // Removal resets both useLogbook's fetched refs and its Infinity batches.
        for (const boardName of boards) queryClient.removeQueries({ queryKey: ['logbook', boardName] });
      } else {
        const roots =
          family === 'favorites'
            ? ['favoriteStatus']
            : ['userPlaylists', 'playlist', 'playlistClimbs', 'playlistSetters', 'playlistsForClimb'];
        for (const root of roots) void queryClient.invalidateQueries({ queryKey: [root] });
      }
      refreshEpochs[family] += 1;
    }
    for (const listener of listeners) listener();
  };
  const unsubscribeOnline = onlineManager.subscribe((isOnline) => {
    const reconnected = !wasOnline && isOnline;
    wasOnline = isOnline;
    if (reconnected) refresh();
  });
  // A cold-start/captive-portal rescue may happen before connectivity has
  // declared an outage. The next online focus is another bounded refresh.
  const unsubscribeFocus = focusManager.subscribe((focused) => {
    if (focused) refresh();
  });
  return () => {
    unsubscribeOnline();
    unsubscribeCredentials();
    unsubscribeFocus();
  };
}
