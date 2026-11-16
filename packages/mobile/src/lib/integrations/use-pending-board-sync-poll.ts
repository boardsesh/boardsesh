import { useCallback, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../providers/auth-provider';
import { type AuroraCredentialsResponse } from '../aurora-credentials';
import { AURORA_CREDENTIALS_QUERY_KEY } from './board-account-query-keys';
import { hasPendingSyncRun, useAuroraCredentialsRead } from './use-board-account-reads';
import { useRestView } from '../rest-operation';

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
  const view = useRestView();
  const key = view.key(AURORA_CREDENTIALS_QUERY_KEY);
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient],
  );
  const hasPendingRun = useSyncExternalStore(
    subscribe,
    () => view.ready && view.isCurrent() && hasPendingSyncRun(queryClient.getQueryData<AuroraCredentialsResponse>(key)),
  );
  useAuroraCredentialsRead(
    {
      networkMode: 'offlineFirst',
      enabled: isAuthenticated && hasPendingRun,
    },
    view,
  );
}
