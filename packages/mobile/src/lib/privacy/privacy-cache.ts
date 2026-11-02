import type { QueryClient } from '@tanstack/react-query';

// The app does not listen to the backend's `privacyChanged` event (#6406 tracks
// retiring it server-side). Every read is authorized by the server when it is
// made and live streams recheck access per event, so nothing here withdraws
// cached projections because someone else changed their privacy.

// Left alone after the viewer's own privacy write: their identity, credentials
// and unsynced work, device-local state, dev tooling and static reference data.
// Nothing in them changes when the viewer edits an audience or a follower.
const OWN_CHANGE_UNAFFECTED_QUERY_ROOTS = new Set([
  // The viewer's own identity, credentials and unsynced work.
  'profile',
  'localPendingTicks',
  'localTicks',
  'wsAuthToken',
  'authToken',
  // Board-type reference data: grade scales, angles and the popular-config rail.
  'grades',
  'angles',
  'popularBoardConfigs',
  // Offline download bookkeeping read from this device.
  'snapshotManifest',
  'downloadedScopeKeys',
  'bootstrapMetadataByScope',
  'offlineStorage',
  'offlineReclaimableBytes',
  'deadLetters',
  // Developer and QA tooling.
  'dev',
  'dev-bundlers',
  'saved-metro-targets',
  'qaBranches',
  'qaPreviews',
]);

/**
 * Refresh the screens a privacy write by this viewer can change: the account
 * switch, an audience, a follower, a follow request or an access grant. The
 * write never narrows what this viewer can read, so nothing is blanked: queries
 * on screen refetch and the rest refetch when they are next shown.
 */
export function refreshAfterOwnPrivacyChange(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) => !OWN_CHANGE_UNAFFECTED_QUERY_ROOTS.has(String(query.queryKey[0])),
  });
}

let credentialGeneration = 0;
const credentialListeners = new Set<() => void>();

export const getCredentialGeneration = (): number => credentialGeneration;

export function subscribeToCredentialChanges(listener: () => void): () => void {
  credentialListeners.add(listener);
  return () => {
    credentialListeners.delete(listener);
  };
}

/**
 * Retire copied content and older asynchronous work. The app calls this at
 * credential boundaries (sign-in, sign-out, a browser session changing
 * identity), before asynchronous credential storage.
 */
export function invalidateCredentialSnapshots(): void {
  credentialGeneration += 1;
  for (const listener of credentialListeners) listener();
}
