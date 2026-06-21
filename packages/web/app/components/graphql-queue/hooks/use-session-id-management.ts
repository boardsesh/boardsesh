import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useSearchParams, usePathname } from 'next/navigation';
import { v4 as uuidv4 } from 'uuid';
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';
import { getBaseBoardPath } from '@/app/lib/url-utils';
import { saveSessionToHistory } from '@/app/lib/session-history-db';
import { getClimbSessionCookie, setClimbSessionCookie, clearClimbSessionCookie } from '@/app/lib/climb-session-cookie';
import { usePersistentSession } from '../../persistent-session';
import { useConnectionSettings } from '../../connection-manager/connection-settings-context';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { END_SESSION as END_SESSION_GQL, type EndSessionResponse } from '@boardsesh/graphql/operations/sessions';
import { emitSessionEnded } from '@/app/lib/session-lifecycle-tracking';
import type { SessionSummary } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '../../queue-control/types';
import { getBrowserTimezone } from '@/app/lib/browser-timezone';

type UseSessionIdManagementParams = {
  isOffBoardMode: boolean;
  propsBaseBoardPath?: string;
  currentQueue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
};

export function useSessionIdManagement({
  isOffBoardMode,
  propsBaseBoardPath,
  currentQueue,
  currentClimbQueueItem,
}: UseSessionIdManagementParams) {
  const searchParams = useSearchParams();
  const router = useLocaleRouter();
  const pathname = usePathname();
  const { backendUrl } = useConnectionSettings();
  const { token: wsAuthToken } = useWsAuthToken();
  const persistentSession = usePersistentSession();

  // Session ID source differs by mode:
  // - Board mode: read from cookie (previously URL ?session= param)
  // - Off-board mode: read from persistent IndexedDB storage
  const sessionIdFromCookie = getClimbSessionCookie();
  const persistentSessionId = persistentSession.activeSession?.sessionId ?? null;
  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    isOffBoardMode ? persistentSessionId : sessionIdFromCookie,
  );

  // Compute base board path up front — the board-path gate on the
  // persistent-session sync effect below reads it. This used to live further
  // down (after the sync effect), so moving it up keeps the lexical order in
  // sync with the React hook order it always ran in.
  const baseBoardPath = useMemo(() => propsBaseBoardPath ?? getBaseBoardPath(pathname), [propsBaseBoardPath, pathname]);

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

  // Sync activeSessionId from persistent session when a new session is
  // activated. Covers both modes:
  //   - Off-board: persistentSessionId is the only source of truth.
  //   - Board: the cookie set by start-sesh-drawer is the initial value, but
  //     when the user creates a session from THIS provider's route (no
  //     navigation, same baseBoardPath as the page they're on), nothing
  //     else picks up the new id. Without this sync, isPersistentSessionActive
  //     stays false and the drawer lightbulb keeps reading as "lit BLE"
  //     (solo) instead of the session-scoped wall-confirmed indicator.
  //
  // Guarded on persistentSessionId being non-null so the cookie value isn't
  // wiped during the initial IndexedDB-load window (where activeSession is
  // briefly null before restoration completes). The active→null deactivation
  // case is handled by the prevPersistentSessionIdRef effect below.
  //
  // In board mode we further gate the sync on the active session's board path
  // matching the current route. Multi-session restore can leave session C
  // (board X) in IndexedDB while the user is browsing board Y — without this
  // gate we'd write C's id into board Y's cookie/state and have isPersistentSessionActive
  // briefly flicker true on the wrong board until the boardPath check on
  // L101-L104 settled. Off-board mode skips the gate (there's no route board
  // to compare against; persistentSessionId is the authority).
  const activeSessionBoardPath = persistentSession.activeSession?.boardPath
    ? getBaseBoardPath(persistentSession.activeSession.boardPath)
    : null;
  useEffect(() => {
    if (!persistentSessionId) return;
    if (!isOffBoardMode && activeSessionBoardPath && activeSessionBoardPath !== baseBoardPath) {
      return;
    }
    setActiveSessionId(persistentSessionId);
  }, [persistentSessionId, isOffBoardMode, activeSessionBoardPath, baseBoardPath]);

  // Sync when persistent session is deactivated externally (e.g. sesh-settings-drawer
  // calling deactivateSession() directly). We track the previous persistentSessionId
  // so we only clear on an active→inactive transition, not on initial mount where
  // persistentSessionId starts null before IndexedDB loads.
  const prevPersistentSessionIdRef = useRef(persistentSessionId);
  useEffect(() => {
    const prev = prevPersistentSessionIdRef.current;
    prevPersistentSessionIdRef.current = persistentSessionId;

    if (prev && !persistentSessionId) {
      clearClimbSessionCookie();
      setActiveSessionId(null);
    }
  }, [persistentSessionId]);

  const sessionId = activeSessionId;

  // Check if persistent session is active for this board
  const isPersistentSessionActive =
    persistentSession.activeSession?.sessionId === sessionId &&
    (persistentSession.activeSession?.boardPath ? getBaseBoardPath(persistentSession.activeSession.boardPath) : '') ===
      baseBoardPath;

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
        persistentSession.setInitialQueueForSession(newSessionId, currentQueue, currentClimbQueueItem, options?.name);
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
    if (endingSessionId) emitSessionEnded(endingSessionId, 'user_left');
    persistentSession.deactivateSession({ notifyServer: false });
    clearClimbSessionCookie();
    setActiveSessionId(null);

    if (endingSessionId && wsAuthToken) {
      const client = createGraphQLHttpClient(wsAuthToken);
      client
        .request<EndSessionResponse>(END_SESSION_GQL, { sessionId: endingSessionId, timezone: getBrowserTimezone() })
        .then((response: EndSessionResponse) => {
          if (response.endSession) setSessionSummary(response.endSession);
        })
        .catch((err: unknown) => console.error('[QueueContext] Failed to get session summary:', err));
    }
  }, [persistentSession, activeSessionId, wsAuthToken]);

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
