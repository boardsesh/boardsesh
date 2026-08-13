'use client';

// Web-side wiring for `@boardsesh/board-react`. Reads platform-specific
// auth (NextAuth) and persistent-session state, and forwards GraphQL
// operations through web's per-call HTTP / WS clients (which is how web
// handles auth-token rotation per mutation).
//
// Mounted internally by `BoardProvider` (see `./board-provider-context`),
// not by app code directly.

import { useMemo, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from 'next-auth/react';
import { BoardAdapterProvider, type BoardAdapter } from '@boardsesh/board-react';
import { execute, createGraphQLClient } from '@/app/lib/realtime/graphql-client';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { getBackendWsUrl } from '@/app/lib/backend-url';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { usePersistentSessionState } from '@/app/components/persistent-session/persistent-session-context';
import { clearTickDraft } from '@/app/lib/tick-draft-db';

export function BoardAdapterWrapper({ children }: { children: ReactNode }) {
  const { status: sessionStatus } = useSession();
  const { token, isLoading: tokenLoading } = useWsAuthToken();
  const { activeSession } = usePersistentSessionState();
  const { showMessage } = useSnackbar();
  const { t } = useTranslation('climbs');

  // Stash mutable per-render bits behind refs so the adapter object stays
  // stable across token / session-id / snackbar churn — those change far
  // more often than auth status, and rebuilding the adapter context value
  // would re-render every BoardProvider subtree consumer.
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const activeSessionIdRef = useRef(activeSession?.sessionId);
  activeSessionIdRef.current = activeSession?.sessionId;
  const showErrorRef = useRef<BoardAdapter['showError']>(undefined);
  showErrorRef.current = () => {
    // Both reasons share the same fallback copy on web today. Switch here
    // if/when reason-specific messages are needed.
    showMessage(t('createClimbForm.alerts.saveFailedFallback'), 'error');
  };

  // Web gates `isAuthenticated` on BOTH the NextAuth session being
  // authenticated AND the async WS auth token having resolved. Reporting
  // `isAuthenticated` from the session alone would briefly enable
  // `useLogbook` / `useSaveTick` while `tokenRef.current` is still null,
  // which 401s against the backend's `requireAuthenticated` and caches
  // the failure on a queryKey that won't re-trigger when only the ref
  // mutates later. Matches the pre-refactor `sessionStatus === 'authenticated' && !!token`
  // gate the old web hooks used directly.
  const hasToken = token !== null;
  const isAuthenticated = sessionStatus === 'authenticated' && hasToken;
  const isAuthLoading = sessionStatus === 'loading' || (sessionStatus === 'authenticated' && tokenLoading);

  const adapter = useMemo<BoardAdapter>(
    () => ({
      isAuthenticated,
      isAuthLoading,
      executeHttp: (query, variables) => {
        // Fresh HTTP client per call so the latest token is used and the
        // graphql-request instance doesn't accumulate state.
        const client = createGraphQLHttpClient(tokenRef.current);
        return client.request(query, variables);
      },
      executeWs: async ({ query, variables }) => {
        // Web creates a per-call WS client and disposes immediately so a
        // stale auth token can't outlive its mutation. Mobile uses a
        // singleton (long-lived push channel).
        const url = getBackendWsUrl();
        if (!url) {
          throw new Error('Backend WS URL is not configured');
        }
        const client = createGraphQLClient({ url, authToken: tokenRef.current ?? undefined });
        try {
          return await execute(client, { query, variables });
        } finally {
          void client.dispose();
        }
      },
      resolveActiveSessionId: () => activeSessionIdRef.current,
      onTickSaved: (climbUuid, angle) => {
        // Belt-and-suspenders cleanup of the IDB tick-draft.
        void clearTickDraft(climbUuid, angle);
      },
      showError: (reason) => showErrorRef.current?.(reason),
    }),
    [isAuthenticated, isAuthLoading],
  );

  return <BoardAdapterProvider value={adapter}>{children}</BoardAdapterProvider>;
}
