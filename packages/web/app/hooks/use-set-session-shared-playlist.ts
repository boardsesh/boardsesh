'use client';

import { useCallback, useState } from 'react';
import { useWsAuthToken } from './use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  SET_SHARED_PLAYLIST_ENABLED_MUTATION,
  type SetSharedPlaylistEnabledResponse,
  type SetSharedPlaylistEnabledVariables,
} from '@/app/components/board-history/board-history-operations';
import { usePersistentSession } from '@/app/components/persistent-session';

type UseSetSessionSharedPlaylistResult = {
  setEnabled: (enabled: boolean) => Promise<void>;
  isLoading: boolean;
  error: Error | null;
};

/**
 * Toggle the shared-playlist queue flag on the active session.
 *
 * Optimistic-UI: locally patches `activeSession.sharedPlaylistEnabled` (which
 * the queue-bridge reads to pick between WS-backed and local-IDB adapters)
 * before the mutation lands, and rolls back to the previous value on failure.
 *
 * No-ops when there is no active session. Server enforces leader-only access
 * — non-leader callers will surface the GraphQLError through `error` and the
 * optimistic patch will roll back.
 */
export function useSetSessionSharedPlaylist(): UseSetSessionSharedPlaylistResult {
  const { token } = useWsAuthToken();
  const { activeSession, setActiveSessionSharedPlaylistEnabled } = usePersistentSession();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const setEnabled = useCallback(
    async (enabled: boolean): Promise<void> => {
      if (!activeSession) return;
      if (!token) {
        setError(new Error('Auth token not available'));
        return;
      }

      const sessionId = activeSession.sessionId;
      // Capture previous value for rollback. Fall back to `true` for legacy
      // rows where the field hasn't been populated yet — that's the queue
      // bridge's default-on behaviour, so rollback should mirror it.
      const previousValue = activeSession.sharedPlaylistEnabled ?? true;
      if (previousValue === enabled) return;

      // Optimistic patch
      setActiveSessionSharedPlaylistEnabled(sessionId, enabled);
      setIsLoading(true);
      setError(null);

      try {
        const client = createGraphQLHttpClient(token);
        const response = await client.request<SetSharedPlaylistEnabledResponse, SetSharedPlaylistEnabledVariables>(
          SET_SHARED_PLAYLIST_ENABLED_MUTATION,
          { sessionId, enabled },
        );
        // Reconcile with the server's authoritative value — almost always
        // matches the optimistic patch, but a concurrent leader change could
        // surface here.
        const serverValue = response.setSharedPlaylistEnabled.sharedPlaylistEnabled;
        if (serverValue !== enabled) {
          setActiveSessionSharedPlaylistEnabled(sessionId, serverValue);
        }
      } catch (err) {
        // Rollback the optimistic patch.
        setActiveSessionSharedPlaylistEnabled(sessionId, previousValue);
        const wrapped = err instanceof Error ? err : new Error(String(err));
        setError(wrapped);
        throw wrapped;
      } finally {
        setIsLoading(false);
      }
    },
    [activeSession, token, setActiveSessionSharedPlaylistEnabled],
  );

  return { setEnabled, isLoading, error };
}
