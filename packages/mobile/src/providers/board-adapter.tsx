// Mobile-side wiring for `@boardsesh/board-react`. Reads platform-specific
// state (auth, queue session id) and forwards GraphQL operations through
// mobile's HTTP / WS clients. Mounted in `app/_layout.tsx` between
// QueueProvider and BoardProvider.

import { useMemo, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { randomUUID } from 'expo-crypto';
import { BoardAdapterProvider, type BoardAdapter } from '@boardsesh/board-react';
import { execute } from '@boardsesh/graphql-client';
import { useAuth } from './auth-provider';
import { useQueueSessionId } from './queue-provider';
import { useToast } from './toast-provider';
import { getDatabaseHandle } from '../db';
import { getHttpClient } from '../lib/graphql/client';
import { getWsClient } from '../lib/graphql/ws-client';
import { drainMutationQueue } from '../mutation-queue';
import { writeTickLocal } from '../hooks/use-offline-mutations';

export function BoardAdapterWrapper({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const { sessionId } = useQueueSessionId();
  const { showToast } = useToast();
  const { t } = useTranslation('climbs');

  // sessionId lives behind a ref so `resolveActiveSessionId` always returns
  // the latest value at mutation time, without re-rendering the adapter on
  // every queue update (which would churn the context value).
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // showToast and t change identity whenever the toast provider or i18n
  // locale re-renders. Reading them at call time via a ref keeps the
  // adapter's context value stable (so subtree consumers don't re-render
  // on every locale flip) while still picking up the latest references.
  const showErrorRef = useRef<BoardAdapter['showError']>(undefined);
  showErrorRef.current = () => {
    // Both reasons share the same fallback copy on mobile today. Switch
    // here if/when reason-specific messages are needed.
    showToast(t('createClimbForm.alerts.saveFailedFallback'), 'error');
  };

  const adapter = useMemo<BoardAdapter>(
    () => ({
      isAuthenticated,
      isAuthLoading: isLoading,
      executeHttp: (query, variables) => getHttpClient().request(query, variables),
      executeWs: ({ query, variables }) => execute(getWsClient(), { query, variables }),
      resolveActiveSessionId: () => sessionIdRef.current,
      saveTickOffline: async (variables, { queryClient, executeHttp }) => {
        const db = getDatabaseHandle();
        if (!db) return null;

        const tickUuid = randomUUID();
        await writeTickLocal(db, variables.input, tickUuid);
        void drainMutationQueue(db, queryClient, executeHttp).catch((error: unknown) => {
          if (__DEV__) {
            console.warn('[BoardAdapter] tick queue drain failed:', error);
          }
        });

        return {
          uuid: tickUuid,
          climbUuid: variables.input.climbUuid,
          angle: variables.input.angle,
          isMirror: variables.input.isMirror,
          status: variables.input.status,
          attemptCount: variables.input.attemptCount,
          quality: variables.input.quality ?? null,
          difficulty: variables.input.difficulty ?? null,
          comment: variables.input.comment,
          climbedAt: variables.input.climbedAt,
        };
      },
      // Mobile has no IndexedDB tick-draft store, so onTickSaved is omitted.
      showError: (reason) => showErrorRef.current?.(reason),
    }),
    [isAuthenticated, isLoading],
  );

  return <BoardAdapterProvider value={adapter}>{children}</BoardAdapterProvider>;
}
