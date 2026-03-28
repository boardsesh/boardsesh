import { useState, useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { Client } from '../../graphql-queue/graphql-client';
import type { SubscriptionQueueEvent, SessionEvent, SessionSummary } from '@boardsesh/shared-schema';
import type { ClimbQueueItem as LocalClimbQueueItem } from '../../queue-control/types';
import { setPreference, removePreference } from '@/app/lib/user-preferences-db';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  END_SESSION as END_SESSION_GQL,
  type EndSessionResponse,
} from '@/app/lib/graphql/operations/sessions';
import { upsertSessionUser } from '../event-utils';
import { SessionConnection, type SessionData } from '../session-connection';
import type { Session, ActiveSessionInfo, PendingInitialQueue, SharedRefs } from '../types';
import { toClimbQueueItemInput, ACTIVE_SESSION_KEY, DEFAULT_BACKEND_URL, DEBUG } from '../types';

const VISIBILITY_RESYNC_DEBOUNCE_MS = 300;
const HIDDEN_TAB_SUSPEND_DELAY_MS = 60_000;

interface UseSessionLifecycleArgs {
  isAuthLoading: boolean;
  handleQueueEvent: (event: SubscriptionQueueEvent) => void;
  handleSessionEvent: (event: SessionEvent) => void;
  setSession: Dispatch<SetStateAction<Session | null>>;
  refs: Pick<SharedRefs,
    'wsAuthTokenRef' | 'usernameRef' | 'avatarUrlRef' | 'sessionRef' |
    'activeSessionRef' | 'queueRef' | 'currentClimbQueueItemRef' |
    'triggerResyncRef' | 'lastReceivedSequenceRef'
  >;
}

export interface SessionLifecycleState {
  activeSession: ActiveSessionInfo | null;
  client: Client | null;
  session: Session | null;
  isConnecting: boolean;
  hasConnected: boolean;
  isWebSocketConnected: boolean;
  error: Error | null;
  sessionSummary: SessionSummary | null;
}

export interface SessionLifecycleActions {
  activateSession: (info: ActiveSessionInfo) => void;
  deactivateSession: () => void;
  setInitialQueueForSession: (
    sessionId: string,
    queue: LocalClimbQueueItem[],
    currentClimb: LocalClimbQueueItem | null,
    sessionName?: string,
  ) => void;
  endSessionWithSummary: () => void;
  dismissSessionSummary: () => void;
  setSession: Dispatch<SetStateAction<Session | null>>;
}

export function useSessionLifecycle({
  isAuthLoading,
  handleQueueEvent,
  handleSessionEvent,
  setSession: setSessionExternal,
  refs,
}: UseSessionLifecycleArgs): SessionLifecycleState & SessionLifecycleActions {
  const {
    wsAuthTokenRef, usernameRef, avatarUrlRef,
    sessionRef, activeSessionRef,
    queueRef, currentClimbQueueItemRef,
    triggerResyncRef, lastReceivedSequenceRef,
  } = refs;

  const [activeSession, setActiveSession] = useState<ActiveSessionInfo | null>(null);
  const [client, setClient] = useState<Client | null>(null);
  const [session, setSessionLocal] = useState<Session | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [hasConnected, setHasConnected] = useState(false);
  const [isWebSocketConnected, setIsWebSocketConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [sessionSummary, setSessionSummary] = useState<SessionSummary | null>(null);

  // Pending initial queue for new sessions
  const [pendingInitialQueue, setPendingInitialQueue] = useState<PendingInitialQueue | null>(null);
  const pendingInitialQueueRef = useRef<PendingInitialQueue | null>(null);
  useEffect(() => { pendingInitialQueueRef.current = pendingInitialQueue; }, [pendingInitialQueue]);

  // SessionConnection instance
  const connectionRef = useRef<SessionConnection | null>(null);

  // Combined setter that updates both local and external state
  const setSession = useCallback((value: SetStateAction<Session | null>) => {
    setSessionLocal(value);
    setSessionExternal(value);
  }, [setSessionExternal]);

  // Keep refs in sync
  useEffect(() => { sessionRef.current = session; }, [session, sessionRef]);
  useEffect(() => { activeSessionRef.current = activeSession; }, [activeSession, activeSessionRef]);

  // Session lifecycle functions
  const activateSession = useCallback((info: ActiveSessionInfo) => {
    setActiveSession((prev) => {
      if (prev?.sessionId === info.sessionId && prev?.boardPath === info.boardPath) {
        return prev;
      }
      if (DEBUG) console.log('[PersistentSession] Activating session:', info.sessionId);
      setPreference(ACTIVE_SESSION_KEY, info).catch((err) =>
        console.error('[PersistentSession] Failed to persist session:', err),
      );
      return info;
    });
  }, []);

  const deactivateSession = useCallback(() => {
    if (DEBUG) console.log('[PersistentSession] Deactivating session');
    setActiveSession(null);
    removePreference(ACTIVE_SESSION_KEY).catch((err) =>
      console.error('[PersistentSession] Failed to clear persisted session:', err),
    );
  }, []);

  const setInitialQueueForSession = useCallback(
    (sessionId: string, queue: LocalClimbQueueItem[], currentClimb: LocalClimbQueueItem | null, sessionName?: string) => {
      if (DEBUG) console.log(`[PersistentSession] Setting initial queue for session ${sessionId}:`, queue.length, 'items', sessionName ? `name: ${sessionName}` : '');
      setPendingInitialQueue({ sessionId, queue, currentClimb, sessionName });
    },
    []
  );

  const dismissSessionSummary = useCallback(() => {
    setSessionSummary(null);
  }, []);

  const endSessionWithSummary = useCallback(() => {
    const endingSessionId = activeSession?.sessionId;
    const token = wsAuthTokenRef.current;

    deactivateSession();

    if (endingSessionId && token) {
      const httpClient = createGraphQLHttpClient(token);
      httpClient.request<EndSessionResponse>(END_SESSION_GQL, { sessionId: endingSessionId })
        .then((response) => {
          if (response.endSession) {
            setSessionSummary(response.endSession);
          }
        })
        .catch((err) => {
          console.error('[PersistentSession] Failed to get session summary:', err);
        });
    }
  }, [activeSession, deactivateSession, wsAuthTokenRef]);

  // Connect to session via SessionConnection when activeSession changes
  useEffect(() => {
    if (!activeSession) {
      if (DEBUG) console.log('[PersistentSession] No active session, skipping connection');
      return;
    }

    if (isAuthLoading) {
      if (DEBUG) console.log('[PersistentSession] Waiting for auth to load...');
      return;
    }

    const { sessionId, boardPath, sessionName } = activeSession;
    const backendUrl = DEFAULT_BACKEND_URL;

    if (!backendUrl) {
      if (DEBUG) console.log('[PersistentSession] No backend URL configured');
      return;
    }

    const conn = new SessionConnection({
      backendUrl,
      sessionId,
      boardPath,
      sessionName,
      callbacks: {
        onConnectionFlagsChange: (flags) => {
          setIsConnecting(flags.isConnecting);
          setHasConnected(flags.hasConnected);
          setIsWebSocketConnected(flags.isWebSocketConnected);
        },
        onSessionJoined: (sessionData: SessionData) => {
          // Handle session state updates (UserJoined/Left/etc. happen via onSessionEvent)
          setSession(sessionData as unknown as Session);
        },
        onSessionCleared: () => {
          removePreference(ACTIVE_SESSION_KEY).catch(() => {});
          setActiveSession(null);
        },
        onQueueEvent: handleQueueEvent,
        onSessionEvent: (event: SessionEvent) => {
          // Handle UserJoined/UserLeft/LeaderChanged/SessionEnded in session state
          if (event.__typename !== 'SessionStatsUpdated') {
            setSession((prev) => {
              if (!prev) return prev;
              switch (event.__typename) {
                case 'UserJoined':
                  return { ...prev, users: upsertSessionUser(prev.users, event.user) };
                case 'UserLeft':
                  return { ...prev, users: prev.users.filter((u) => u.id !== event.userId) };
                case 'LeaderChanged':
                  return {
                    ...prev,
                    isLeader: event.leaderId === prev.clientId,
                    users: prev.users.map((u) => ({ ...u, isLeader: u.id === event.leaderId })),
                  };
                case 'SessionEnded':
                  if (DEBUG) console.log('[PersistentSession] Session ended:', event.reason);
                  removePreference(ACTIVE_SESSION_KEY).catch(() => {});
                  return prev;
                default:
                  return prev;
              }
            });
          }
          handleSessionEvent(event);
        },
        onError: (err) => {
          setError(err);
        },
        onClientCreated: (newClient) => {
          setClient(newClient);
        },
        getQueueState: () => ({
          queue: queueRef.current,
          currentItemUuid: currentClimbQueueItemRef.current?.uuid || null,
        }),
        getLastSequence: () => lastReceivedSequenceRef.current,
        toClimbQueueItemInput: (item: unknown) => toClimbQueueItemInput(item as LocalClimbQueueItem),
        getPendingInitialQueue: () => pendingInitialQueueRef.current,
        clearPendingInitialQueue: () => setPendingInitialQueue(null),
      },
    });

    connectionRef.current = conn;

    // Wire up triggerResync ref for use by other hooks (event processor, subscriptions)
    triggerResyncRef.current = (force?: boolean) => conn.triggerResync(force);

    // Set initial credentials and connect
    conn.updateCredentials(wsAuthTokenRef.current, usernameRef.current, avatarUrlRef.current);
    conn.connect();

    return () => {
      if (DEBUG) console.log('[PersistentSession] Cleaning up connection');
      conn.dispose();
      connectionRef.current = null;
      triggerResyncRef.current = null;

      setClient(null);
      setSession(null);
      setHasConnected(false);
      setIsConnecting(false);
      setIsWebSocketConnected(false);
      lastReceivedSequenceRef.current = null;
    };
  // Note: credentials are accessed via refs to prevent reconnection on changes
  }, [activeSession, isAuthLoading, handleQueueEvent, handleSessionEvent, setSession,
      wsAuthTokenRef, usernameRef, avatarUrlRef, sessionRef, activeSessionRef,
      queueRef, currentClimbQueueItemRef, triggerResyncRef, lastReceivedSequenceRef]);

  // Sync credentials to SessionConnection when they change
  useEffect(() => {
    connectionRef.current?.updateCredentials(wsAuthTokenRef.current, usernameRef.current, avatarUrlRef.current);
  }, [wsAuthTokenRef, usernameRef, avatarUrlRef]);

  // Background-tab handling: suspend socket after inactivity and recover on foreground
  useEffect(() => {
    if (!activeSession || !hasConnected) return;

    let resyncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let hiddenSuspendTimer: ReturnType<typeof setTimeout> | null = null;
    let suspendedForHiddenTab = false;

    const clearTimers = () => {
      if (resyncDebounceTimer) {
        clearTimeout(resyncDebounceTimer);
        resyncDebounceTimer = null;
      }
      if (hiddenSuspendTimer) {
        clearTimeout(hiddenSuspendTimer);
        hiddenSuspendTimer = null;
      }
    };

    const scheduleResync = () => {
      if (resyncDebounceTimer) clearTimeout(resyncDebounceTimer);
      resyncDebounceTimer = setTimeout(() => {
        connectionRef.current?.triggerResync();
      }, VISIBILITY_RESYNC_DEBOUNCE_MS);
    };

    const resumeIfNeeded = () => {
      if (hiddenSuspendTimer) {
        clearTimeout(hiddenSuspendTimer);
        hiddenSuspendTimer = null;
      }
      if (suspendedForHiddenTab) {
        if (DEBUG) console.log('[PersistentSession] Foreground return, resuming suspended connection');
        connectionRef.current?.resume();
        suspendedForHiddenTab = false;
        return;
      }
      scheduleResync();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (hiddenSuspendTimer) clearTimeout(hiddenSuspendTimer);
        hiddenSuspendTimer = setTimeout(() => {
          if (document.visibilityState !== 'hidden') return;
          if (DEBUG) {
            console.log('[PersistentSession] Tab hidden beyond threshold, suspending connection');
          }
          connectionRef.current?.suspend();
          suspendedForHiddenTab = true;
        }, HIDDEN_TAB_SUSPEND_DELAY_MS);
        return;
      }

      if (document.visibilityState === 'visible') {
        if (DEBUG) console.log('[PersistentSession] Page became visible, triggering connection health check');
        resumeIfNeeded();
      }
    };

    const handleFocus = () => {
      if (document.visibilityState !== 'visible') return;
      resumeIfNeeded();
    };

    const handleOnline = () => {
      if (DEBUG) console.log('[PersistentSession] Network online, validating session connection');
      resumeIfNeeded();
    };

    const handleOffline = () => {
      if (DEBUG) console.log('[PersistentSession] Network offline');
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearTimers();
    };
  }, [activeSession, hasConnected]);

  return {
    activeSession,
    client,
    session,
    isConnecting,
    hasConnected,
    isWebSocketConnected,
    error,
    sessionSummary,
    activateSession,
    deactivateSession,
    setInitialQueueForSession,
    endSessionWithSummary,
    dismissSessionSummary,
    setSession,
  };
}
