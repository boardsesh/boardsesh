// Mobile-side wiring for `@boardsesh/board-react`. Reads platform-specific
// state (auth, queue session id) and forwards GraphQL operations through
// mobile's HTTP / WS clients. Mounted in `app/_layout.tsx` between
// QueueProvider and BoardProvider.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BoardAdapterProvider, type BoardAdapter } from '@boardsesh/board-react';
import { execute } from '@boardsesh/graphql-client';
import { useAuth } from './auth-provider';
import { useQueueSessionId } from './queue-provider';
import { useToast } from './toast-provider';
import { getLatestUserSessionTickAt, getNewerTickAt } from './board-adapter-rep-timer';
import { useProfile } from '../lib/graphql/hooks';
import { getHttpClient } from '../lib/graphql/client';
import { useSessionDetail } from '../lib/graphql/hooks/use-session-detail';
import { getWsClient } from '../lib/graphql/ws-client';

export function BoardAdapterWrapper({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const { sessionId } = useQueueSessionId();
  const { showToast } = useToast();
  const { t } = useTranslation('climbs');
  const { data: profile } = useProfile({ enabled: isAuthenticated && sessionId !== null });
  const sessionDetailQuery = useSessionDetail(sessionId ?? undefined, { enabled: isAuthenticated });
  const [lastSavedSessionTick, setLastSavedSessionTick] = useState<{ sessionId: string; climbedAt: string } | null>(
    null,
  );

  // sessionId lives behind a ref so `resolveActiveSessionId` always returns
  // the latest value at mutation time, without re-rendering the adapter on
  // every queue update (which would churn the context value).
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  useEffect(() => {
    setLastSavedSessionTick(null);
  }, [sessionId]);

  const localLastSavedTickAt = lastSavedSessionTick?.sessionId === sessionId ? lastSavedSessionTick.climbedAt : null;
  const hydratedLastSavedTickAt = useMemo(
    () => getLatestUserSessionTickAt(sessionDetailQuery.data?.ticks, profile?.id),
    [profile?.id, sessionDetailQuery.data?.ticks],
  );
  const lastSavedTickAt = useMemo(
    () => getNewerTickAt(localLastSavedTickAt, hydratedLastSavedTickAt),
    [hydratedLastSavedTickAt, localLastSavedTickAt],
  );

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
      onTickSaved: (_climbUuid, _angle, climbedAt, savedSessionId) => {
        if (!savedSessionId || savedSessionId !== sessionIdRef.current) return;
        setLastSavedSessionTick({ sessionId: savedSessionId, climbedAt });
      },
      lastSavedTickAt,
      showError: (reason) => showErrorRef.current?.(reason),
    }),
    [isAuthenticated, isLoading, lastSavedTickAt],
  );

  return <BoardAdapterProvider value={adapter}>{children}</BoardAdapterProvider>;
}
