import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import {
  captureAuthCredentialGeneration,
  getAuthToken,
  hasConfirmedAnonymousWebSession,
  isAuthCredentialGenerationCurrent,
  isRequiredBrowserDispatch,
  subscribeAuthTokenChanges,
  synchronizeWebSession,
} from '../auth-store.web';
import { expoBrowserBackendClient } from '../browser-backend-client.web';
import { browserHttpClients } from './client.web';

export const AUTH_TOKEN_QUERY_KEY = ['authToken'] as const;

function subscribe(listener: () => void): () => void {
  const releaseStore = subscribeAuthTokenChanges(listener);
  const releaseManager = expoBrowserBackendClient.subscribe(listener);
  const releaseClients = browserHttpClients.subscribe(listener);
  return () => {
    releaseStore();
    releaseManager();
    releaseClients();
  };
}
function snapshot(): string {
  const current = expoBrowserBackendClient.getSnapshot();
  return JSON.stringify([
    captureAuthCredentialGeneration(),
    current.revision,
    current.closed,
    current.selected,
    current.anonymous,
    browserHttpClients.getRevision(),
    isRequiredBrowserDispatch(),
  ]);
}

/** Browser query keys contain only a process-local, noncredential view label.
 * Raw JWEs and delegated leases remain outside React Query and persistence. */
export function useAuthToken() {
  const revision = useSyncExternalStore(subscribe, snapshot, () => 'server-unavailable');
  const result = useQuery({
    queryKey: [...AUTH_TOKEN_QUERY_KEY, 'browser-view', revision],
    queryFn: async ({ signal }): Promise<string | null> => {
      const generation = captureAuthCredentialGeneration();
      const assertCurrent = () => {
        if (signal.aborted) throw signal.reason;
        if (!isAuthCredentialGenerationCurrent(generation)) throw new BrowserBackendConsumerError('superseded');
      };
      let token = await getAuthToken();
      assertCurrent();
      if (token === null && !hasConfirmedAnonymousWebSession()) {
        const admission = await synchronizeWebSession();
        assertCurrent();
        if (admission.status !== 'authenticated' && admission.status !== 'anonymous')
          throw new BrowserBackendConsumerError('unavailable');
        token = await getAuthToken();
        assertCurrent();
      }
      if (token === null) {
        if (!hasConfirmedAnonymousWebSession()) throw new BrowserBackendConsumerError('unavailable');
        return null;
      }
      const label = browserHttpClients.captureHandle();
      assertCurrent();
      if (!browserHttpClients.isCurrentView(label)) throw new BrowserBackendConsumerError('superseded');
      return label;
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const data =
    typeof result.data === 'string'
      ? browserHttpClients.isCurrentView(result.data)
        ? result.data
        : undefined
      : result.data === null && hasConfirmedAnonymousWebSession()
        ? null
        : undefined;
  return { ...result, data };
}
