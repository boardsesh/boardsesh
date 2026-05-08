import { useState, useCallback, useEffect, type Dispatch, type SetStateAction } from 'react';
import { type Client, createGraphQLClient, execute, subscribe } from '../../graphql-queue/graphql-client';
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
  BOARD_SENDS,
  type SubscriptionQueueEvent,
  type SessionEvent,
  type QueueEvent,
  type EventsReplayResponse,
  type SessionSummary,
} from '@boardsesh/shared-schema';
import type { BoardSend, ClimbQueueItem as LocalClimbQueueItem } from '../../queue-control/types';
import { computeQueueStateHash } from '@/app/utils/hash';
import { setPreference, removePreference } from '@/app/lib/user-preferences-db';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { END_SESSION as END_SESSION_GQL, type EndSessionResponse } from '@/app/lib/graphql/operations/sessions';
import { upsertSessionUser } from '../event-utils';
import { TransientJoinError } from '../errors';
import {
  type Session,
  type ActiveSessionInfo,
  type PendingInitialQueue,
  type SharedRefs,
  toClimbQueueItemInput,
  ACTIVE_SESSION_KEY,
  DEFAULT_BACKEND_URL,
  DEBUG,
} from '../types';

function isTransientTransportError(err: unknown): boolean {
  return (
    !!err && typeof err === 'object' && (err as { transientTransportError?: boolean }).transientTransportError === true
  );
}

/**
 * Transform QueueEvent (from eventsReplay) to SubscriptionQueueEvent format.
 */
function transformToSubscriptionEvent(event: QueueEvent | SubscriptionQueueEvent): SubscriptionQueueEvent {
  switch (event.__typename) {
    case 'QueueItemAdded':
      if ('addedItem' in event) return event;
      return {
        __typename: 'QueueItemAdded',
        sequence: event.sequence,
        addedItem: event.item,
        position: event.position,
      };
    case 'CurrentClimbChanged':
      if ('currentItem' in event) return event;
      return {
        __typename: 'CurrentClimbChanged',
        sequence: event.sequence,
        currentItem: event.item,
        clientId: event.clientId,
        correlationId: event.correlationId,
      };
    case 'ActiveClimberChanged':
      if ('activeClimberUserId' in event) return event;
      return {
        __typename: 'ActiveClimberChanged',
        sequence: event.sequence,
        activeClimberUserId: event.userId,
        correlationId: event.correlationId,
      };
    default:
      return event as SubscriptionQueueEvent;
  }
}

type UseSessionLifecycleArgs = {
  isAuthLoading: boolean;
  handleQueueEvent: (event: SubscriptionQueueEvent) => void;
  handleSessionEvent: (event: SessionEvent) => void;
  setBoardSends: Dispatch<SetStateAction<BoardSend[]>>;
  setSession: Dispatch<SetStateAction<Session | null>>;
  refs: Pick<
    SharedRefs,
    | 'wsAuthTokenRef'
    | 'usernameRef'
    | 'avatarUrlRef'
    | 'sessionRef'
    | 'activeSessionRef'
    | 'queueRef'
    | 'currentClimbQueueItemRef'
    | 'picksRef'
    | 'activeClimberUserIdRef'
    | 'mountedRef'
    | 'isConnectingRef'
    | 'isReconnectingRef'
    | 'connectionGenerationRef'
    | 'triggerResyncRef'
    | 'lastReceivedSequenceRef'
    | 'queueUnsubscribeRef'
    | 'sessionUnsubscribeRef'
  >;
};

export type SessionLifecycleState = {
  activeSession: ActiveSessionInfo | null;
  client: Client | null;
  session: Session | null;
  isConnecting: boolean;
  hasConnected: boolean;
  error: Error | null;
  sessionSummary: SessionSummary | null;
  sessionSummaryBoardType: string | null;
  sessionSummaryHealthKitWorkoutId: string | null;
};

export type SessionLifecycleActions = {
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
};

export function useSessionLifecycle({
  isAuthLoading,
  handleQueueEvent,
  handleSessionEvent,
  setBoardSends,
  setSession: setSessionExternal,
  refs,
}: UseSessionLifecycleArgs): SessionLifecycleState & SessionLifecycleActions {
  const {
    wsAuthTokenRef,
    usernameRef,
    avatarUrlRef,
    sessionRef,
    activeSessionRef,
    queueRef,
    currentClimbQueueItemRef,
    mountedRef,
    isConnectingRef,
    isReconnectingRef,
    connectionGenerationRef,
    triggerResyncRef,
    lastReceivedSequenceRef,
    queueUnsubscribeRef,
    sessionUnsubscribeRef,
  } = refs;

  const [activeSession, setActiveSession] = useState<ActiveSessionInfo | null>(null);
  const [client, setClient] = useState<Client | null>(null);
  const [session, setSessionLocal] = useState<Session | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [hasConnected, setHasConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [sessionSummary, setSessionSummary] = useState<SessionSummary | null>(null);
  const [sessionSummaryBoardType, setSessionSummaryBoardType] = useState<string | null>(null);
  const [sessionSummaryHealthKitWorkoutId, setSessionSummaryHealthKitWorkoutId] = useState<string | null>(null);

  // Pending initial queue for new sessions
  const [pendingInitialQueue, setPendingInitialQueue] = useState<PendingInitialQueue | null>(null);

  // Combined setter that updates both local and external state
  const setSession = useCallback(
    (value: SetStateAction<Session | null>) => {
      setSessionLocal(value);
      setSessionExternal(value);
    },
    [setSessionExternal],
  );

  // Keep refs in sync
  useEffect(() => {
    sessionRef.current = session;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionRef is a stable ref
  }, [session]);
  useEffect(() => {
    activeSessionRef.current = activeSession;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeSessionRef is a stable ref
  }, [activeSession]);

  // Session lifecycle functions
  const activateSession = useCallback((info: ActiveSessionInfo) => {
    setActiveSession((prev) => {
      if (prev?.sessionId === info.sessionId && prev?.boardPath === info.boardPath) {
        return prev;
      }
      if (DEBUG) console.info('[PersistentSession] Activating session:', info.sessionId);
      setPreference(ACTIVE_SESSION_KEY, info).catch((err) =>
        console.error('[PersistentSession] Failed to persist session:', err),
      );
      return info;
    });
  }, []);

  const deactivateSession = useCallback(() => {
    if (DEBUG) console.info('[PersistentSession] Deactivating session');
    setActiveSession(null);
    removePreference(ACTIVE_SESSION_KEY).catch((err) =>
      console.error('[PersistentSession] Failed to clear persisted session:', err),
    );
  }, []);

  const setInitialQueueForSession = useCallback(
    (
      sessionId: string,
      queue: LocalClimbQueueItem[],
      currentClimb: LocalClimbQueueItem | null,
      sessionName?: string,
    ) => {
      if (DEBUG)
        console.info(
          `[PersistentSession] Setting initial queue for session ${sessionId}:`,
          queue.length,
          'items',
          sessionName ? `name: ${sessionName}` : '',
        );
      setPendingInitialQueue({ sessionId, queue, currentClimb, sessionName });
    },
    [],
  );

  const dismissSessionSummary = useCallback(() => {
    setSessionSummary(null);
    setSessionSummaryBoardType(null);
    setSessionSummaryHealthKitWorkoutId(null);
  }, []);

  const endSessionWithSummary = useCallback(() => {
    const endingSessionId = activeSessionRef.current?.sessionId;
    const boardType = activeSessionRef.current?.parsedParams.board_name ?? null;
    const token = wsAuthTokenRef.current;

    deactivateSession();

    if (endingSessionId && token) {
      const httpClient = createGraphQLHttpClient(token);
      httpClient
        .request<EndSessionResponse>(END_SESSION_GQL, { sessionId: endingSessionId })
        .then((response) => {
          if (response.endSession) {
            setSessionSummary(response.endSession);
            setSessionSummaryBoardType(boardType);
            setSessionSummaryHealthKitWorkoutId(null);
          }
        })
        .catch((err) => {
          console.error('[PersistentSession] Failed to get session summary:', err);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable, only .current changes
  }, [deactivateSession]);

  // Connect to session when activeSession changes
  useEffect(() => {
    if (!activeSession) {
      if (DEBUG) console.info('[PersistentSession] No active session, skipping connection');
      return;
    }

    if (isAuthLoading) {
      if (DEBUG) console.info('[PersistentSession] Waiting for auth to load...');
      return;
    }

    const { sessionId, boardPath } = activeSession;
    const backendUrl = DEFAULT_BACKEND_URL;

    if (!backendUrl) {
      if (DEBUG) console.info('[PersistentSession] No backend URL configured');
      return;
    }

    mountedRef.current = true;
    const connectionGeneration = ++connectionGenerationRef.current;
    let graphqlClient: Client | null = null;
    let retryConnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let transientRetryCount = 0;

    async function joinSession(clientToUse: Client): Promise<Session | null> {
      if (DEBUG) console.info('[PersistentSession] Calling joinSession mutation...');
      try {
        const initialQueueData = pendingInitialQueue?.sessionId === sessionId ? pendingInitialQueue : null;

        if (DEBUG && initialQueueData) {
          console.info('[PersistentSession] Sending initial queue with', initialQueueData.queue.length, 'items');
        }

        const sessionName = activeSession?.sessionName || initialQueueData?.sessionName;
        const variables = {
          sessionId,
          boardPath,
          username: usernameRef.current,
          avatarUrl: avatarUrlRef.current,
          ...(initialQueueData && {
            initialQueue: initialQueueData.queue.map(toClimbQueueItemInput),
            initialCurrentClimb: initialQueueData.currentClimb
              ? toClimbQueueItemInput(initialQueueData.currentClimb)
              : null,
          }),
          ...(sessionName && { sessionName }),
        };

        const response = await execute<{ joinSession: Session }>(clientToUse, {
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

    async function loadBoardSends(clientToUse: Client) {
      try {
        const response = await execute<{ boardSends: BoardSend[] }>(clientToUse, {
          query: BOARD_SENDS,
          variables: { sessionId, deduplicate: true },
        });
        if (!mountedRef.current || connectionGenerationRef.current !== connectionGeneration) return;
        setBoardSends(response?.boardSends ?? []);
      } catch (err) {
        console.warn('[PersistentSession] Failed to load board sends:', err);
      }
    }

    async function handleReconnect() {
      if (!mountedRef.current || !graphqlClient) return;
      if (connectionGenerationRef.current !== connectionGeneration) return;
      if (isReconnectingRef.current) {
        if (DEBUG) console.info('[PersistentSession] Reconnection already in progress');
        return;
      }

      isReconnectingRef.current = true;
      try {
        if (DEBUG) console.info('[PersistentSession] Reconnecting...');

        const lastSeq = lastReceivedSequenceRef.current;
        const sessionData = await joinSession(graphqlClient);
        if (!sessionData || !mountedRef.current) return;

        const currentSeq = sessionData.queueState.sequence;
        const gap = lastSeq !== null ? currentSeq - lastSeq : 0;

        if (DEBUG)
          console.info(
            `[PersistentSession] Reconnected. Last seq: ${lastSeq}, Current seq: ${currentSeq}, Gap: ${gap}`,
          );

        if (gap > 0 && gap <= 100 && lastSeq !== null && sessionId) {
          try {
            if (DEBUG) console.info(`[PersistentSession] Attempting delta sync for ${gap} missed events...`);

            const response = await execute<{ eventsReplay: EventsReplayResponse }>(graphqlClient, {
              query: EVENTS_REPLAY,
              variables: { sessionId, sinceSequence: lastSeq },
            });

            const replay = response?.eventsReplay;
            if (!replay) {
              throw new Error('eventsReplay payload missing');
            }

            if (replay.events.length > 0) {
              if (DEBUG) console.info(`[PersistentSession] Replaying ${replay.events.length} events`);
              replay.events.forEach((event) => {
                handleQueueEvent(transformToSubscriptionEvent(event));
              });
              if (DEBUG) console.info('[PersistentSession] Delta sync completed successfully');
            } else {
              if (DEBUG) console.info('[PersistentSession] No events to replay');
            }
          } catch (err) {
            console.warn('[PersistentSession] Delta sync failed, falling back to full sync:', err);
            applyFullSync(sessionData);
          }
        } else if (gap > 100) {
          if (DEBUG) console.info(`[PersistentSession] Gap too large (${gap}), using full sync`);
          applyFullSync(sessionData);
        } else if (lastSeq === null) {
          if (DEBUG) console.info('[PersistentSession] First connection, applying initial state');
          applyFullSync(sessionData);
        } else if (gap === 0) {
          const localHash = computeQueueStateHash(
            queueRef.current,
            currentClimbQueueItemRef.current?.uuid || null,
            refs.picksRef.current,
            refs.activeClimberUserIdRef.current,
          );
          if (localHash !== sessionData.queueState.stateHash) {
            if (DEBUG) console.info('[PersistentSession] Hash mismatch on reconnect despite gap=0, applying full sync');
            applyFullSync(sessionData);
          } else {
            if (DEBUG) console.info('[PersistentSession] No missed events, already in sync');
          }
        }

        setSession(sessionData);
        await loadBoardSends(graphqlClient);
        if (DEBUG) console.info('[PersistentSession] Reconnection complete, clientId:', sessionData.clientId);
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
        if (DEBUG) console.info('[PersistentSession] Connection already in progress, skipping');
        return;
      }
      isConnectingRef.current = true;

      if (DEBUG) console.info('[PersistentSession] Connecting to session:', sessionId);
      setIsConnecting(true);
      setError(null);

      try {
        graphqlClient = createGraphQLClient({
          url: backendUrl!,
          authToken: wsAuthTokenRef.current,
          onReconnect: () => void handleReconnect(),
          connectionName: 'session',
        });

        if (!mountedRef.current) {
          void graphqlClient.dispose();
          isConnectingRef.current = false;
          return;
        }

        setClient(graphqlClient);

        const sessionData = await joinSession(graphqlClient);

        if (connectionGenerationRef.current !== connectionGeneration) {
          return;
        }

        if (!mountedRef.current) {
          void graphqlClient.dispose();
          return;
        }

        if (!sessionData) {
          throw new TransientJoinError('JoinSession returned no payload');
        }

        if (DEBUG) console.info('[PersistentSession] Joined session, clientId:', sessionData.clientId);

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

        await loadBoardSends(graphqlClient);

        // Subscribe to queue updates
        queueUnsubscribeRef.current = subscribe<{ queueUpdates: SubscriptionQueueEvent }>(
          graphqlClient,
          { query: QUEUE_UPDATES, variables: { sessionId } },
          {
            next: (data) => {
              if (data.queueUpdates) {
                handleQueueEvent(data.queueUpdates);
              }
            },
            error: (err) => {
              const transientTransportError = isTransientTransportError(err);
              if (transientTransportError) {
                console.warn('[PersistentSession] Queue subscription transport error:', err);
              } else {
                console.error('[PersistentSession] Queue subscription error:', err);
              }
              queueUnsubscribeRef.current = null;
              if (mountedRef.current && !transientTransportError) {
                setError(err instanceof Error ? err : new Error(String(err)));
              }
            },
            complete: () => {
              if (DEBUG) console.info('[PersistentSession] Queue subscription completed');
              queueUnsubscribeRef.current = null;
            },
          },
        );

        // Subscribe to session updates
        sessionUnsubscribeRef.current = subscribe<{ sessionUpdates: SessionEvent }>(
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
                          users: prev.users.map((u) => ({
                            ...u,
                            isLeader: u.id === event.leaderId,
                          })),
                        };
                      case 'SessionEnded':
                        if (DEBUG) console.info('[PersistentSession] Session ended:', event.reason);
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
              if (isTransientTransportError(err)) {
                console.warn('[PersistentSession] Session subscription transport error:', err);
              } else {
                console.error('[PersistentSession] Session subscription error:', err);
              }
              sessionUnsubscribeRef.current = null;
            },
            complete: () => {
              if (DEBUG) console.info('[PersistentSession] Session subscription completed');
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
              if (DEBUG)
                console.info(
                  `[PersistentSession] Transient retry ${transientRetryCount}/${MAX_TRANSIENT_RETRIES} in ${delay}ms`,
                );
              retryConnectTimeout = setTimeout(() => {
                if (
                  connectionGenerationRef.current === connectionGeneration &&
                  mountedRef.current &&
                  activeSessionRef.current?.sessionId === sessionId &&
                  !isConnectingRef.current
                ) {
                  void connect();
                }
              }, delay);
            }
          } else {
            removePreference(ACTIVE_SESSION_KEY).catch(() => {});
            setActiveSession(null);
          }
        }
        if (graphqlClient) {
          void graphqlClient.dispose();
        }
      }
    }

    void connect();

    return () => {
      if (DEBUG) console.info('[PersistentSession] Cleaning up connection');
      mountedRef.current = false;
      isConnectingRef.current = false;

      const clientToCleanup = graphqlClient;
      graphqlClient = null;

      queueUnsubscribeRef.current?.();
      queueUnsubscribeRef.current = null;
      sessionUnsubscribeRef.current?.();
      sessionUnsubscribeRef.current = null;

      if (clientToCleanup) {
        void Promise.resolve()
          .then(async () => {
            if (sessionRef.current) {
              await execute(clientToCleanup, { query: LEAVE_SESSION }).catch(() => {});
            }
            void clientToCleanup.dispose();
          })
          .catch((err) => {
            // Swallow errors during cleanup — the WebSocket is being torn down
            if (DEBUG) console.info('[PersistentSession] Cleanup error suppressed:', err);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable, only .current changes; intentional dep list
  }, [activeSession, isAuthLoading, handleQueueEvent, handleSessionEvent, setSession, pendingInitialQueue]);

  return {
    activeSession,
    client,
    session,
    isConnecting,
    hasConnected,
    error,
    sessionSummary,
    sessionSummaryBoardType,
    sessionSummaryHealthKitWorkoutId,
    activateSession,
    deactivateSession,
    setInitialQueueForSession,
    endSessionWithSummary,
    dismissSessionSummary,
    setSession,
  };
}
