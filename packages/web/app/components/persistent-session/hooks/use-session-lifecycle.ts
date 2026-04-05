import { useState, useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { createGraphQLClient, execute, subscribe, Client } from '../../graphql-queue/graphql-client';
import { createNativeWSClient, isNativeWebSocketAvailable, NativeWSClient } from '../../graphql-queue/native-ws-client';
import { getNativeWebSocketPlugin } from '@/app/lib/native-ws/native-ws-plugin';
import { getBackendWsUrl } from '@/app/lib/backend-url';
import {
  INITIAL_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  BACKOFF_MULTIPLIER,
  MAX_TRANSIENT_RETRIES,
} from '../../graphql-queue/retry-constants';
import {
  JOIN_SESSION,
  LEAVE_SESSION,
  QUEUE_UPDATES,
  SESSION_UPDATES,
  EVENTS_REPLAY,
  type SubscriptionQueueEvent,
  type SessionEvent,
  type QueueEvent,
  type EventsReplayResponse,
} from '@boardsesh/shared-schema';
import type { ClimbQueueItem as LocalClimbQueueItem } from '../../queue-control/types';
import { computeQueueStateHash } from '@/app/utils/hash';
import { setPreference, removePreference } from '@/app/lib/user-preferences-db';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  END_SESSION as END_SESSION_GQL,
  type EndSessionResponse,
} from '@/app/lib/graphql/operations/sessions';
import type { SessionSummary } from '@boardsesh/shared-schema';
import { upsertSessionUser } from '../event-utils';
import { TransientJoinError } from '../errors';
import type { Session, ActiveSessionInfo, PendingInitialQueue, SharedRefs } from '../types';
import { toClimbQueueItemInput, ACTIVE_SESSION_KEY, DEFAULT_BACKEND_URL, DEBUG } from '../types';

/**
 * Transform QueueEvent (from eventsReplay) to SubscriptionQueueEvent format.
 */
function transformToSubscriptionEvent(event: QueueEvent): SubscriptionQueueEvent {
  switch (event.__typename) {
    case 'QueueItemAdded':
      return {
        __typename: 'QueueItemAdded',
        sequence: event.sequence,
        addedItem: event.item,
        position: event.position,
      };
    case 'CurrentClimbChanged':
      return {
        __typename: 'CurrentClimbChanged',
        sequence: event.sequence,
        currentItem: event.item,
        clientId: event.clientId,
        correlationId: event.correlationId,
      };
    default:
      return event as SubscriptionQueueEvent;
  }
}

interface UseSessionLifecycleArgs {
  isAuthLoading: boolean;
  handleQueueEvent: (event: SubscriptionQueueEvent) => void;
  handleSessionEvent: (event: SessionEvent) => void;
  setSession: Dispatch<SetStateAction<Session | null>>;
  refs: Pick<SharedRefs,
    'wsAuthTokenRef' | 'usernameRef' | 'avatarUrlRef' | 'sessionRef' |
    'activeSessionRef' | 'queueRef' | 'currentClimbQueueItemRef' |
    'mountedRef' | 'isConnectingRef' | 'isReconnectingRef' |
    'connectionGenerationRef' | 'triggerResyncRef' | 'lastReceivedSequenceRef' |
    'queueUnsubscribeRef' | 'sessionUnsubscribeRef'
  >;
}

/** A transport client that can be either a graphql-ws Client or a NativeWSClient. */
export type TransportClient = Client | NativeWSClient;

export interface SessionLifecycleState {
  activeSession: ActiveSessionInfo | null;
  client: TransportClient | null;
  session: Session | null;
  isConnecting: boolean;
  hasConnected: boolean;
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
    mountedRef, isConnectingRef, isReconnectingRef,
    connectionGenerationRef, triggerResyncRef, lastReceivedSequenceRef,
    queueUnsubscribeRef, sessionUnsubscribeRef,
  } = refs;

  const [activeSession, setActiveSession] = useState<ActiveSessionInfo | null>(null);
  const [client, setClient] = useState<TransportClient | null>(null);
  const [session, setSessionLocal] = useState<Session | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [hasConnected, setHasConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [sessionSummary, setSessionSummary] = useState<SessionSummary | null>(null);

  // Pending initial queue for new sessions
  const [pendingInitialQueue, setPendingInitialQueue] = useState<PendingInitialQueue | null>(null);

  // Combined setter that updates both local and external state
  const setSession = useCallback((value: SetStateAction<Session | null>) => {
    setSessionLocal(value);
    setSessionExternal(value);
  }, [setSessionExternal]);

  // Keep refs in sync
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { activeSessionRef.current = activeSession; }, [activeSession]);

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
    const endingSessionId = activeSessionRef.current?.sessionId;
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
  }, [deactivateSession]);

  // Connect to session when activeSession changes
  useEffect(() => {
    if (!activeSession) {
      if (DEBUG) console.log('[PersistentSession] No active session, skipping connection');
      return;
    }

    if (isAuthLoading) {
      if (DEBUG) console.log('[PersistentSession] Waiting for auth to load...');
      return;
    }

    const { sessionId, boardPath } = activeSession;
    const backendUrl = DEFAULT_BACKEND_URL;

    if (!backendUrl) {
      if (DEBUG) console.log('[PersistentSession] No backend URL configured');
      return;
    }

    mountedRef.current = true;
    const connectionGeneration = ++connectionGenerationRef.current;
    let graphqlClient: TransportClient | null = null;
    let retryConnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let transientRetryCount = 0;
    const useNativeWs = isNativeWebSocketAvailable();

    // Helper to execute operations on either client type
    function executeOnClient<T>(clientToUse: TransportClient, operation: { query: string; variables?: Record<string, unknown> }): Promise<T> {
      if (clientToUse instanceof NativeWSClient) {
        return clientToUse.execute<T>(operation);
      }
      return execute<T>(clientToUse, operation);
    }

    // Helper to subscribe on either client type
    function subscribeOnClient<T>(
      clientToUse: TransportClient,
      operation: { query: string; variables?: Record<string, unknown> },
      sink: { next: (value: T) => void; error: (error: unknown) => void; complete: () => void },
    ): () => void {
      if (clientToUse instanceof NativeWSClient) {
        return clientToUse.subscribe<T>(operation, sink);
      }
      return subscribe<T>(clientToUse, operation, sink);
    }

    async function joinSession(clientToUse: TransportClient): Promise<Session | null> {
      if (DEBUG) console.log('[PersistentSession] Calling joinSession mutation...');
      try {
        const initialQueueData =
          pendingInitialQueue?.sessionId === sessionId
            ? pendingInitialQueue
            : null;

        if (DEBUG && initialQueueData) {
          console.log('[PersistentSession] Sending initial queue with', initialQueueData.queue.length, 'items');
        }

        const sessionName = activeSession?.sessionName || initialQueueData?.sessionName;
        const variables = {
          sessionId,
          boardPath,
          username: usernameRef.current,
          avatarUrl: avatarUrlRef.current,
          ...(initialQueueData && {
            initialQueue: initialQueueData.queue.map(toClimbQueueItemInput),
            initialCurrentClimb: initialQueueData.currentClimb ? toClimbQueueItemInput(initialQueueData.currentClimb) : null,
          }),
          ...(sessionName && { sessionName }),
        };

        const response = await executeOnClient<{ joinSession: Session }>(clientToUse, {
          query: JOIN_SESSION,
          variables,
        });

        const joinedSession = response?.joinSession;
        if (!joinedSession) {
          console.error('[PersistentSession] JoinSession returned no session payload');
          return null;
        }

        if (initialQueueData) {
          setPendingInitialQueue(null);
        }

        return joinedSession;
      } catch (err) {
        console.error('[PersistentSession] JoinSession failed:', err);
        return null;
      }
    }

    async function handleReconnect() {
      if (!mountedRef.current || !graphqlClient) return;
      if (connectionGenerationRef.current !== connectionGeneration) return;
      if (isReconnectingRef.current) {
        if (DEBUG) console.log('[PersistentSession] Reconnection already in progress');
        return;
      }

      isReconnectingRef.current = true;
      try {
        if (DEBUG) console.log('[PersistentSession] Reconnecting...');

        const lastSeq = lastReceivedSequenceRef.current;
        const sessionData = await joinSession(graphqlClient);
        if (!sessionData || !mountedRef.current) return;

        const currentSeq = sessionData.queueState.sequence;
        const gap = lastSeq !== null ? currentSeq - lastSeq : 0;

        if (DEBUG) console.log(`[PersistentSession] Reconnected. Last seq: ${lastSeq}, Current seq: ${currentSeq}, Gap: ${gap}`);

        if (gap > 0 && gap <= 100 && lastSeq !== null && sessionId) {
          try {
            if (DEBUG) console.log(`[PersistentSession] Attempting delta sync for ${gap} missed events...`);

            const response = await executeOnClient<{ eventsReplay: EventsReplayResponse }>(graphqlClient, {
              query: EVENTS_REPLAY,
              variables: { sessionId, sinceSequence: lastSeq },
            });

            const replay = response?.eventsReplay;
            if (!replay) {
              throw new Error('eventsReplay payload missing');
            }

            if (replay.events.length > 0) {
              if (DEBUG) console.log(`[PersistentSession] Replaying ${replay.events.length} events`);
              replay.events.forEach(event => {
                handleQueueEvent(transformToSubscriptionEvent(event));
              });
              if (DEBUG) console.log('[PersistentSession] Delta sync completed successfully');
            } else {
              if (DEBUG) console.log('[PersistentSession] No events to replay');
            }
          } catch (err) {
            console.warn('[PersistentSession] Delta sync failed, falling back to full sync:', err);
            applyFullSync(sessionData);
          }
        } else if (gap > 100) {
          if (DEBUG) console.log(`[PersistentSession] Gap too large (${gap}), using full sync`);
          applyFullSync(sessionData);
        } else if (lastSeq === null) {
          if (DEBUG) console.log('[PersistentSession] First connection, applying initial state');
          applyFullSync(sessionData);
        } else if (gap === 0) {
          const localHash = computeQueueStateHash(queueRef.current, currentClimbQueueItemRef.current?.uuid || null);
          if (localHash !== sessionData.queueState.stateHash) {
            if (DEBUG) console.log('[PersistentSession] Hash mismatch on reconnect despite gap=0, applying full sync');
            applyFullSync(sessionData);
          } else {
            if (DEBUG) console.log('[PersistentSession] No missed events, already in sync');
          }
        }

        setSession(sessionData);
        if (DEBUG) console.log('[PersistentSession] Reconnection complete, clientId:', sessionData.clientId);
      } finally {
        isReconnectingRef.current = false;
      }
    }

    triggerResyncRef.current = handleReconnect;

    function applyFullSync(sessionData: Session) {
      if (sessionData.queueState) {
        handleQueueEvent({
          __typename: 'FullSync',
          sequence: sessionData.queueState.sequence,
          state: sessionData.queueState,
        });
      }
    }

    async function connect() {
      if (connectionGenerationRef.current !== connectionGeneration) return;
      if (isConnectingRef.current) {
        if (DEBUG) console.log('[PersistentSession] Connection already in progress, skipping');
        return;
      }
      isConnectingRef.current = true;

      if (DEBUG) console.log('[PersistentSession] Connecting to session:', sessionId);
      setIsConnecting(true);
      setError(null);

      try {
        if (useNativeWs) {
          // Native iOS WebSocket path: connect via Capacitor plugin
          const nativePlugin = getNativeWebSocketPlugin();
          if (!nativePlugin) throw new Error('Native WebSocket plugin not available');

          graphqlClient = createNativeWSClient({ onReconnect: handleReconnect });

          await nativePlugin.connect({
            serverUrl: typeof window !== 'undefined' ? window.location.origin : '',
            sessionId,
            authToken: wsAuthTokenRef.current,
            wsUrl: getBackendWsUrl() ?? undefined,
          });

          // Notify native side that webview is active
          nativePlugin.setWebviewActive({ active: true }).catch(() => {});
        } else {
          // Standard graphql-ws path for web browsers
          graphqlClient = createGraphQLClient({
            url: backendUrl!,
            authToken: wsAuthTokenRef.current,
            onReconnect: handleReconnect,
            connectionName: 'session',
          });
        }

        if (!mountedRef.current) {
          graphqlClient.dispose();
          isConnectingRef.current = false;
          return;
        }

        setClient(graphqlClient);

        const sessionData = await joinSession(graphqlClient);

        if (connectionGenerationRef.current !== connectionGeneration) {
          return;
        }

        if (!mountedRef.current) {
          graphqlClient.dispose();
          return;
        }

        if (!sessionData) {
          throw new TransientJoinError('JoinSession returned no payload');
        }

        if (DEBUG) console.log('[PersistentSession] Joined session, clientId:', sessionData.clientId);

        transientRetryCount = 0;
        setSession(sessionData);
        setHasConnected(true);
        setIsConnecting(false);

        if (sessionData.queueState) {
          handleQueueEvent({
            __typename: 'FullSync',
            sequence: sessionData.queueState.sequence,
            state: sessionData.queueState,
          });
        }

        // Subscribe to queue updates
        queueUnsubscribeRef.current = subscribeOnClient<{ queueUpdates: SubscriptionQueueEvent }>(
          graphqlClient,
          { query: QUEUE_UPDATES, variables: { sessionId } },
          {
            next: (data) => {
              if (data.queueUpdates) {
                handleQueueEvent(data.queueUpdates);
              }
            },
            error: (err) => {
              console.error('[PersistentSession] Queue subscription error:', err);
              queueUnsubscribeRef.current = null;
              if (mountedRef.current) {
                setError(err instanceof Error ? err : new Error(String(err)));
              }
            },
            complete: () => {
              if (DEBUG) console.log('[PersistentSession] Queue subscription completed');
              queueUnsubscribeRef.current = null;
            },
          },
        );

        // Subscribe to session updates
        sessionUnsubscribeRef.current = subscribeOnClient<{ sessionUpdates: SessionEvent }>(
          graphqlClient,
          { query: SESSION_UPDATES, variables: { sessionId } },
          {
            next: (data) => {
              if (data.sessionUpdates) {
                // Handle UserJoined/UserLeft/LeaderChanged/SessionEnded in session state
                const event = data.sessionUpdates;
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
              }
            },
            error: (err) => {
              console.error('[PersistentSession] Session subscription error:', err);
              sessionUnsubscribeRef.current = null;
            },
            complete: () => {
              if (DEBUG) console.log('[PersistentSession] Session subscription completed');
              sessionUnsubscribeRef.current = null;
            },
          },
        );

        isConnectingRef.current = false;
      } catch (err) {
        console.error('[PersistentSession] Connection failed:', err);
        isConnectingRef.current = false;
        const isTransientJoinFailure = err instanceof TransientJoinError;

        if (mountedRef.current) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsConnecting(false);
          if (isTransientJoinFailure) {
            transientRetryCount++;
            if (transientRetryCount > MAX_TRANSIENT_RETRIES) {
              console.warn(
                `[PersistentSession] Exhausted ${MAX_TRANSIENT_RETRIES} transient retries, clearing session`,
              );
              transientRetryCount = 0;
              removePreference(ACTIVE_SESSION_KEY).catch(() => {});
              setActiveSession(null);
            } else {
              const delay = Math.min(
                INITIAL_RETRY_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, transientRetryCount - 1),
                MAX_RETRY_DELAY_MS,
              );
              if (DEBUG) console.log(`[PersistentSession] Transient retry ${transientRetryCount}/${MAX_TRANSIENT_RETRIES} in ${delay}ms`);
              retryConnectTimeout = setTimeout(() => {
                if (
                  connectionGenerationRef.current === connectionGeneration &&
                  mountedRef.current &&
                  activeSessionRef.current?.sessionId === sessionId &&
                  !isConnectingRef.current
                ) {
                  connect();
                }
              }, delay);
            }
          } else {
            removePreference(ACTIVE_SESSION_KEY).catch(() => {});
            setActiveSession(null);
          }
        }
        if (graphqlClient) {
          graphqlClient.dispose();
        }
      }
    }

    connect();

    return () => {
      if (DEBUG) console.log('[PersistentSession] Cleaning up connection');
      mountedRef.current = false;
      isConnectingRef.current = false;

      const clientToCleanup = graphqlClient;
      graphqlClient = null;

      queueUnsubscribeRef.current?.();
      queueUnsubscribeRef.current = null;
      sessionUnsubscribeRef.current?.();
      sessionUnsubscribeRef.current = null;

      if (clientToCleanup) {
        Promise.resolve().then(async () => {
          if (sessionRef.current) {
            await executeOnClient(clientToCleanup, { query: LEAVE_SESSION }).catch(() => {});
          }
          clientToCleanup.dispose();
        }).catch((err) => {
          // Swallow errors during cleanup — the WebSocket is being torn down
          if (DEBUG) console.log('[PersistentSession] Cleanup error suppressed:', err);
        });
      }

      setClient(null);
      setSession(null);
      setHasConnected(false);
      setIsConnecting(false);
      if (retryConnectTimeout) {
        clearTimeout(retryConnectTimeout);
      }
    };
  }, [activeSession, isAuthLoading, handleQueueEvent, handleSessionEvent, setSession, pendingInitialQueue]);

  return {
    activeSession,
    client,
    session,
    isConnecting,
    hasConnected,
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
