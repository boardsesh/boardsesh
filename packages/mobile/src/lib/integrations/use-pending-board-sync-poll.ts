import { useCallback, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../providers/auth-provider';
import { getAuroraCredentials, type AuroraCredentialsResponse } from '../aurora-credentials';
import { AURORA_CREDENTIALS_QUERY_KEY } from './board-account-query-keys';
import { hasPendingSyncRun, pendingSyncRefetchInterval } from './use-board-account-credentials';

/**
 * Keeps re-reading the board credentials while a linked account is waiting on
 * its import, from anywhere in the signed-in app. Without one always-mounted
 * owner the poll only ran on Integrations or an empty You page, so a climber
 * with sends who linked a second board never saw it finish. It starts no
 * request of its own: it only polls once some read has cached a pending run.
 */
export function usePendingBoardSyncPoll(): void {
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient],
  );
  const hasPendingRun = useSyncExternalStore(subscribe, () =>
    hasPendingSyncRun(queryClient.getQueryData<AuroraCredentialsResponse>(AURORA_CREDENTIALS_QUERY_KEY)),
  );
  useQuery<AuroraCredentialsResponse>({
    queryKey: AURORA_CREDENTIALS_QUERY_KEY,
    queryFn: getAuroraCredentials,
    networkMode: 'offlineFirst',
    enabled: isAuthenticated && hasPendingRun,
    refetchInterval: pendingSyncRefetchInterval,
  });
}
