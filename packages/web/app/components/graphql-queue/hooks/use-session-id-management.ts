import { useState, useEffect, useMemo, useCallback } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { v4 as uuidv4 } from 'uuid';
import { getBaseBoardPath } from '@/app/lib/url-utils';
import { saveSessionToHistory } from '@/app/lib/session-history-db';
import { getClimbSessionCookie, setClimbSessionCookie, clearClimbSessionCookie } from '@/app/lib/climb-session-cookie';
import { usePersistentSession } from '../../persistent-session';
import { useConnectionSettings } from '../../connection-manager/connection-settings-context';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  END_SESSION as END_SESSION_GQL,
  type EndSessionResponse,
} from '@/app/lib/graphql/operations/sessions';
import type { SessionSummary } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '../../queue-control/types';

interface UseSessionIdManagementParams {
  isOffBoardMode: boolean;
  propsBaseBoardPath?: string;
  currentQueue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
}

export function useSessionIdManagement({
  isOffBoardMode,
  propsBaseBoardPath,
  currentQueue,
  currentClimbQueueItem,
}: UseSessionIdManagementParams) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { backendUrl } = useConnectionSettings();
  const { token: wsAuthToken } = useWsAuthToken();
  const persistentSession = usePersistentSession();

  // Session ID always comes from the cookie (global, path=/)
  const sessionIdFromCookie = getClimbSessionCookie();
  const [activeSessionId, setActiveSessionId] = useState<string | null>(sessionIdFromCookie);

  // Backward compat: migrate ?session= URL param to cookie and strip from URL
  useEffect(() => {
    if (isOffBoardMode) return;
    const sessionFromUrl = searchParams.get('session');
    if (sessionFromUrl) {
      setClimbSessionCookie(sessionFromUrl);
      setActiveSessionId(sessionFromUrl);
      const params = new URLSearchParams(searchParams.toString());
      params.delete('session');
      const queryString = params.toString();
      router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
    }
  }, [searchParams, isOffBoardMode, pathname, router]);

  const sessionId = activeSessionId;

  // Compute base board path
  const baseBoardPath = useMemo(
    () => propsBaseBoardPath ?? getBaseBoardPath(pathname),
    [propsBaseBoardPath, pathname],
  );

  // Check if persistent session is active for this board
  const isPersistentSessionActive = persistentSession.activeSession?.sessionId === sessionId &&
    (persistentSession.activeSession?.boardPath
      ? getBaseBoardPath(persistentSession.activeSession.boardPath)
      : '') === baseBoardPath;

  // Session summary state
  const [sessionSummary, setSessionSummary] = useState<SessionSummary | null>(null);
  const dismissSessionSummary = useCallback(() => setSessionSummary(null), []);

  // Session management functions
  const startSession = useCallback(
    async (options?: { discoverable?: boolean; name?: string; sessionId?: string }) => {
      if (isOffBoardMode) throw new Error('Cannot start a session outside of a board route');
      if (!backendUrl) throw new Error('Backend URL not configured');

      const newSessionId = options?.sessionId || uuidv4();

      if (currentQueue.length > 0 || currentClimbQueueItem) {
        persistentSession.setInitialQueueForSession(
          newSessionId, currentQueue, currentClimbQueueItem, options?.name,
        );
      }

      setClimbSessionCookie(newSessionId);
      setActiveSessionId(newSessionId);

      await saveSessionToHistory({
        id: newSessionId,
        name: options?.name || null,
        boardPath: pathname,
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
      });

      return newSessionId;
    },
    [backendUrl, pathname, currentQueue, currentClimbQueueItem, persistentSession, isOffBoardMode],
  );

  const joinSession = useCallback(
    async (sessionIdToJoin: string) => {
      if (isOffBoardMode) throw new Error('Cannot join a session outside of a board route');
      if (!backendUrl) throw new Error('Backend URL not configured');

      setClimbSessionCookie(sessionIdToJoin);
      setActiveSessionId(sessionIdToJoin);

      await saveSessionToHistory({
        id: sessionIdToJoin,
        name: null,
        boardPath: pathname,
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
      });
    },
    [backendUrl, pathname, isOffBoardMode],
  );

  const endSession = useCallback(() => {
    const endingSessionId = activeSessionId;
    persistentSession.deactivateSession();
    clearClimbSessionCookie();
    setActiveSessionId(null);

    if (endingSessionId && wsAuthToken) {
      const client = createGraphQLHttpClient(wsAuthToken);
      client.request<EndSessionResponse>(END_SESSION_GQL, { sessionId: endingSessionId })
        .then((response: EndSessionResponse) => {
          if (response.endSession) setSessionSummary(response.endSession);
        })
        .catch((err: unknown) => console.error('[QueueContext] Failed to get session summary:', err));
    }
  }, [persistentSession, isOffBoardMode, activeSessionId, wsAuthToken]);

  return {
    sessionId,
    activeSessionId,
    baseBoardPath,
    isPersistentSessionActive,
    persistentSession,
    backendUrl,
    searchParams,
    router,
    pathname,
    isOffBoardMode,
    startSession,
    joinSession,
    endSession,
    sessionSummary,
    dismissSessionSummary,
  };
}
