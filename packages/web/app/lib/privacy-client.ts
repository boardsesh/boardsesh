import type { QueryClient } from '@tanstack/react-query';

export const PRIVACY_REVOKED_EVENT = 'boardsesh:privacy-revoked';
const TRANSPORT_QUERY_KEYS = new Set(['wsAuthToken', 'sitePrivacySettings']);

/** Drop copied identity immediately; a stale in-flight response cannot restore it. */
export async function revokeWebPrivacySnapshots(queryClient: QueryClient): Promise<void> {
  const filters = {
    predicate: (query: { queryKey: readonly unknown[] }) => !TRANSPORT_QUERY_KEYS.has(String(query.queryKey[0])),
  };
  await queryClient.cancelQueries(filters);
  for (const query of queryClient.getQueryCache().findAll(filters)) {
    query.setState({ data: undefined, dataUpdatedAt: 0, error: null, status: 'pending' });
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PRIVACY_REVOKED_EVENT));
  await queryClient.invalidateQueries(filters);
}
