import { useAuroraCredentialsRead } from './use-board-account-reads';
export { PENDING_SYNC_REFRESH_MS, hasPendingSyncRun, pendingSyncRefetchInterval } from './use-board-account-reads';

export function useBoardAccountCredentials(enabled = true) {
  return useAuroraCredentialsRead({
    networkMode: 'offlineFirst',
    enabled,
    select: (response) => response.credentials,
  });
}
