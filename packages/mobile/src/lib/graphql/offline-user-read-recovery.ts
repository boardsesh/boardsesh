import { focusManager, hashKey, onlineManager, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { getPrivacyRevocationGeneration, subscribeToPrivacyRevocations } from '../privacy/privacy-cache';

export type OfflineUserReadFamily = 'logbook' | 'playlists' | 'favorites';

const servedLocally = new Map<OfflineUserReadFamily, Set<string>>();
const refreshEpochs: Record<OfflineUserReadFamily, number> = { logbook: 0, playlists: 0, favorites: 0 };
const listeners = new Set<() => void>();
type MembershipWrite = { pending: number; refreshRequested: boolean; credentialGeneration: number };
const membershipWrites = new WeakMap<QueryClient, Map<string, MembershipWrite>>();

/** Hold recovery reads until all optimistic writes to this climb have settled. */
export function beginPlaylistMembershipWrite(queryClient: QueryClient, queryKey: QueryKey): () => void {
  let writes = membershipWrites.get(queryClient);
  if (!writes) {
    writes = new Map();
    membershipWrites.set(queryClient, writes);
  }
  const queryHash = hashKey(queryKey);
  const credentialGeneration = getPrivacyRevocationGeneration();
  let write = writes.get(queryHash);
  if (!write || write.credentialGeneration !== credentialGeneration) {
    write = { pending: 0, refreshRequested: false, credentialGeneration };
    writes.set(queryHash, write);
  }
  write.pending += 1;
  const activeWrite = write;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeWrite.pending -= 1;
    if (activeWrite.pending > 0 || writes.get(queryHash) !== activeWrite) return;
    writes.delete(queryHash);
    if (activeWrite.refreshRequested && activeWrite.credentialGeneration === getPrivacyRevocationGeneration()) {
      void queryClient.invalidateQueries({ queryKey, exact: true });
    }
  };
}

export function isPlaylistMembershipWritePending(queryClient: QueryClient, queryKey: QueryKey): boolean {
  const write = membershipWrites.get(queryClient)?.get(hashKey(queryKey));
  return write?.credentialGeneration === getPrivacyRevocationGeneration();
}

function refreshPlaylistMemberships(queryClient: QueryClient): void {
  const writes = membershipWrites.get(queryClient);
  const credentialGeneration = getPrivacyRevocationGeneration();
  for (const write of writes?.values() ?? []) {
    if (write.credentialGeneration === credentialGeneration) write.refreshRequested = true;
  }
  // Leave pending optimistic keys fresh, including across picker remounts.
  // Their final release invalidates them; other inactive keys stay stale.
  void queryClient.invalidateQueries({
    queryKey: ['playlistsForClimb'],
    refetchType: 'none',
    predicate: (query) => !isPlaylistMembershipWritePending(queryClient, query.queryKey),
  });
  void queryClient.refetchQueries({
    queryKey: ['playlistsForClimb'],
    type: 'active',
    predicate: (query) => !isPlaylistMembershipWritePending(queryClient, query.queryKey),
  });
}

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
            : ['userPlaylists', 'playlist', 'playlistClimbs', 'playlistSetters'];
        for (const root of roots) void queryClient.invalidateQueries({ queryKey: [root] });
        if (family === 'playlists') refreshPlaylistMemberships(queryClient);
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
