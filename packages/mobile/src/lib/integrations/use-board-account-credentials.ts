import { useQuery, type Query } from '@tanstack/react-query';
import { getAuroraCredentials, type AuroraCredentialsResponse } from '../aurora-credentials';

// The prompt and Connected apps share one cached response and invalidation key.
export const AURORA_CREDENTIALS_QUERY_KEY = ['auroraCredentials'] as const;
export const AURORA_UNSYNCED_QUERY_KEY = ['auroraCredentials', 'unsynced'] as const;

/** While a board sync is waiting, re-read the credentials this often so "Syncing" clears on its own. */
export const PENDING_SYNC_REFRESH_MS = 20_000;

/** `refetchInterval` for the credentials query: poll only while some account has a queued sync. */
export function pendingSyncRefetchInterval(query: Pick<Query<AuroraCredentialsResponse>, 'state'>): number | false {
  return query.state.data?.credentials.some((credential) => credential.pendingRunId) ? PENDING_SYNC_REFRESH_MS : false;
}

export function useBoardAccountCredentials(enabled = true) {
  return useQuery({
    queryKey: AURORA_CREDENTIALS_QUERY_KEY,
    queryFn: getAuroraCredentials,
    networkMode: 'offlineFirst',
    enabled,
    refetchInterval: pendingSyncRefetchInterval,
    select: (response) => response.credentials,
  });
}
