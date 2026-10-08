import type { QueryClient } from '@tanstack/react-query';

// These projections can contain copied names, avatars, notes or prior grants.
// Cancel first, clear the snapshot, then refetch: invalidate alone leaves old
// protected content visible while a request is in flight.
const VIEWER_LOCAL_QUERY_ROOTS = new Set(['profile', 'localPendingTicks', 'localTicks', 'wsAuthToken', 'authToken']);

export async function invalidatePrivacyQueries(
  queryClient: QueryClient,
  beforeRefetch?: () => Promise<void>,
): Promise<void> {
  const filters = {
    predicate: (query: { queryKey: readonly unknown[] }) => !VIEWER_LOCAL_QUERY_ROOTS.has(String(query.queryKey[0])),
  };
  await queryClient.cancelQueries(filters);
  for (const query of queryClient.getQueryCache().findAll(filters)) {
    // resetQueries may restore initialData, which can itself hold withdrawn
    // content. Clear explicitly before any fresh authorization response.
    query.setState({ data: undefined, dataUpdatedAt: 0, error: null, status: 'pending' });
  }
  await beforeRefetch?.();
  await queryClient.invalidateQueries(filters);
}
