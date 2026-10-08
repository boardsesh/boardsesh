import type { QueryClient } from '@tanstack/react-query';

// These projections can contain copied names, avatars, notes or prior grants.
// Cancel first, clear the snapshot, then refetch: invalidate alone leaves old
// protected content visible while a request is in flight.
const VIEWER_LOCAL_QUERY_ROOTS = new Set(['profile', 'localPendingTicks', 'localTicks', 'wsAuthToken', 'authToken']);

let privacyRevocationGeneration = 0;
let privacyCredentialGeneration = 0;
const revocationListeners = new Set<() => void>();

export const getPrivacyCredentialGeneration = (): number => privacyCredentialGeneration;

export const getPrivacyRevocationGeneration = (): number => privacyRevocationGeneration;

export function subscribeToPrivacyRevocations(listener: () => void): () => void {
  revocationListeners.add(listener);
  return () => {
    revocationListeners.delete(listener);
  };
}

let revalidatePrivacy: (() => Promise<void>) | undefined;

/** Installed by the authenticated bridge; ownership-safe across effect replacement. */
export function registerPrivacyRevalidation(handler: () => Promise<void>): () => void {
  revalidatePrivacy = handler;
  return () => {
    if (revalidatePrivacy === handler) revalidatePrivacy = undefined;
  };
}

/** Also used at credential boundaries, before asynchronous credential storage. */
export function invalidatePrivacySnapshots(reason: 'privacy' | 'credential' = 'privacy'): void {
  if (reason === 'credential') privacyCredentialGeneration += 1;
  privacyRevocationGeneration += 1;
  for (const listener of revocationListeners) listener();
}

export async function invalidatePrivacyQueries(
  queryClient: QueryClient,
  beforeRefetch?: () => Promise<void>,
): Promise<void> {
  // Retire imperative snapshots before the first await, including callbacks
  // captured before React can render the withdrawn access.
  // Begin the SQLite gate before listeners can start resolving their references.
  // A failed revalidation must still withdraw the currently displayed snapshots.
  let revalidation: Promise<void>;
  try {
    revalidation = (beforeRefetch ?? revalidatePrivacy)?.() ?? Promise.resolve();
  } catch (error) {
    revalidation = Promise.reject(error);
  }
  // Observe early failures while query cancellation is still pending.
  void revalidation.catch(() => undefined);
  invalidatePrivacySnapshots();
  const filters = {
    predicate: (query: { queryKey: readonly unknown[] }) => !VIEWER_LOCAL_QUERY_ROOTS.has(String(query.queryKey[0])),
  };
  await queryClient.cancelQueries(filters);
  for (const query of queryClient.getQueryCache().findAll(filters)) {
    // resetQueries may restore initialData, which can itself hold withdrawn
    // content. Clear explicitly before any fresh authorization response.
    query.setState({ data: undefined, dataUpdatedAt: 0, error: null, status: 'pending' });
  }
  await revalidation;
  await queryClient.invalidateQueries(filters);
}
