import { useState, useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { type Client, createGraphQLClient, execute, subscribe } from '../../graphql-queue/graphql-client';
import {
  INITIAL_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  BACKOFF_MULTIPLIER,
  MAX_TRANSIENT_RETRIES,
} from '@boardsesh/graphql-client';
import {
  JOIN_SESSION,
  LEAVE_SESSION,
  QUEUE_UPDATES,
  SESSION_UPDATES,
  EVENTS_REPLAY,
} from '@boardsesh/graphql/operations/queue-session';
import { applySessionRuntimeEvent, type RuntimeSessionEvent } from '@boardsesh/queue-runtime';
import type {
  SubscriptionQueueEvent,
  SessionEvent,
  QueueEvent,
  EventsReplayResponse,
  SessionSummary,
} from '@boardsesh/shared-schema';
import type { ClimbQueueItem as LocalClimbQueueItem } from '../../queue-control/types';
import { computeQueueStateHash } from '@/app/utils/hash';
import { setPreference, removePreference } from '@/app/lib/user-preferences-db';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { END_SESSION as END_SESSION_GQL, type EndSessionResponse } from '@boardsesh/graphql/operations/sessions';
import { fetchAutoFinishedSummary } from './use-queue-storage';
import { coerceSessionUser } from '../event-utils';
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

/**
 * Transform QueueEvent (from eventsReplay) to SubscriptionQueueEvent format.
 */
export function transformToSubscriptionEvent(event: QueueEvent | SubscriptionQueueEvent): SubscriptionQueueEvent {
  switch (event.__typename) {
    case 'QueueItemAdded': {
      const addedItem = 'addedItem' in event ? event.addedItem : event.item;
      return {
        __typename: 'QueueItemAdded',
        sequence: event.sequence,
        stateHash: event.stateHash,
        addedItem,
        position: event.position,
      };
    }
    case 'CurrentClimbChanged': {
      const currentItem = 'currentItem' in event ? event.currentItem : event.item;
      return {
        __typename: 'CurrentClimbChanged',
        sequence: event.sequence,
        stateHash: event.stateHash,
        currentItem,
        clientId: event.clientId,
        correlationId: event.correlationId,
      };
    }
    case 'ClimbMirrored': {
      // Wire shape exposes `uuid`; aliased subscription shape uses `mirroredUuid`. Read both.
      const climbMirroredCandidate = event as { uuid?: string | null; mirroredUuid?: string | null };
      const mirroredUuid = climbMirroredCandidate.mirroredUuid ?? climbMirroredCandidate.uuid ?? null;
      return {
        __typename: 'ClimbMirrored',
        sequence: event.sequence,
        stateHash: event.stateHash,
        mirroredUuid,
        mirrored: event.mirrored,
      };
    }
    default:
      return event as SubscriptionQueueEvent;
  }
}

type WebRuntimeSessionUser = Parameters<typeof coerceSessionUser>[0];

function toWebSessionRuntimeEvent(event: SessionEvent): RuntimeSessionEvent<WebRuntimeSessionUser> | null {
  switch (event.__typename) {
    case 'UserJoined':
    case 'UserPresenceChanged':
      return { __typename: event.__typename, user: event.user as unknown as WebRuntimeSessionUser };
    case 'UserLeft':
      return { __typename: 'UserLeft', userId: event.userId };
    case 'LeaderChanged':
      return {
        __typename: 'LeaderChanged',
        leaderId: event.leaderId,
        leaderConnectionId: event.leaderConnectionId ?? null,
      };
    case 'DriverChanged':
      return {
        __typename: 'DriverChanged',
        driverParticipantId: event.driverParticipantId ?? null,
        previousDriverParticipantId: event.previousDriverParticipantId ?? null,
      };
    case 'SessionBoardSerialChanged':
      return {
        __typename: 'SessionBoardSerialChanged',
        lastConnectedBoardSerial: event.lastConnectedBoardSerial ?? null,
      };
    case 'SessionBoardPathChanged':
      return {
        __typename: 'SessionBoardPathChanged',
        boardPath: event.boardPath,
        changedByParticipantId: event.changedByParticipantId ?? null,
      };
    case 'SessionEnded':
      return { __typename: 'SessionEnded', reason: event.reason ?? null, newPath: event.newPath ?? null };
    default:
      return null;
  }
}

/**
 * Apply a single `SessionEvent` (excluding `SessionStatsUpdated`, which is
 * dispatched through the React Query cache rather than the session reducer)
 * to a `Session`. Pure so the rules can be unit-tested without standing up
 * the WebSocket subscription pipeline.
 *
 * Returns `null` when `prev` is `null` (no session to mutate). For
 * `SessionEnded` we leave the previous state in place — clearing happens via
 * IndexedDB removal and the next lifecycle tick, not the reducer.
 */
export function applySessionEvent(prev: Session | null, event: SessionEvent): Session | null {
  const runtimeEvent = toWebSessionRuntimeEvent(event);
  return runtimeEvent ? applySessionRuntimeEvent(prev, runtimeEvent, { coerceUser: coerceSessionUser }) : prev;
}

export function hasContiguousReplayCoverage(
  events: SubscriptionQueueEvent[],
  sinceSequence: number,
  currentSequence: number,
): boolean {
  if (currentSequence <= sinceSequence) {
    return true;
  }

  let expectedSequence = sinceSequence + 1;
  // FullSync and CurrentClimbChanged can share a sequence number when a
  // controller-issued climb change races with a snapshot. Process FullSync
  // first within a tie so the snapshot establishes the new expected sequence
  // before the same-sequence delta is checked — otherwise the delta would
  // fail the `event.sequence !== expectedSequence` invariant and we'd
  // wrongly report a gap. We can't rely on sort stability for this — even
  // with ECMAScript 2019's stable sort, the assertion still depends on the
  // caller's insertion order, which is not contractual.
  const sortedEvents = [...events].sort((a, b) => {
    if (a.sequence !== b.sequence) return a.sequence - b.sequence;
    if (a.__typename === 'FullSync' && b.__typename !== 'FullSync') return -1;
    if (b.__typename === 'FullSync' && a.__typename !== 'FullSync') return 1;
    return 0;
  });

  for (const event of sortedEvents) {
    if (event.sequence < expectedSequence) {
      continue;
    }

    if (event.__typename === 'FullSync') {
      expectedSequence = event.sequence + 1;
      continue;
    }

    if (event.sequence !== expectedSequence) {
      return false;
    }

    expectedSequence++;
  }

  return expectedSequence > currentSequence;
}

type UseSessionLifecycleArgs = {
  isAuthLoading: boolean;
  handleQueueEvent: (event: SubscriptionQueueEvent) => void;
  handleSessionEvent: (event: SessionEvent) => void;
  setLastReceivedStateHash: Dispatch<SetStateAction<string | null>>;
  refs: Pick<
    SharedRefs,
    | 'wsAuthTokenRef'
    | 'usernameRef'
    | 'avatarUrlRef'
    | 'sessionRef'
    | 'activeSessionRef'
    | 'queueRef'
    | 'currentClimbQueueItemRef'
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
  sessionSummaryAutoFinished: boolean;
};

export type SessionLifecycleActions = {
  activateSession: (info: ActiveSessionInfo) => void;
  deactivateSession: (options?: { notifyServer?: boolean }) => void;
  setInitialQueueForSession: (
    sessionId: string,
    queue: LocalClimbQueueItem[],
    currentClimb: LocalClimbQueueItem | null,
    sessionName?: string,
  ) => void;
  endSessionWithSummary: () => void;
  setAutoFinishedSummary: (summary: SessionSummary, boardType: string | null) => void;
  dismissSessionSummary: () => void;
  setSession: Dispatch<SetStateAction<Session | null>>;
};

export function useSessionLifecycle({
  isAuthLoading,
  handleQueueEvent,
  handleSessionEvent,
  setLastReceivedStateHash,
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
  const [session, setSession] = useState<Session | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [hasConnected, setHasConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [sessionSummary, setSessionSummary] = useState<SessionSummary | null>(null);
  const [sessionSummaryBoardType, setSessionSummaryBoardType] = useState<string | null>(null);
  const [sessionSummaryHealthKitWorkoutId, setSessionSummaryHealthKitWorkoutId] = useState<string | null>(null);
  const [sessionSummaryAutoFinished, setSessionSummaryAutoFinished] = useState(false);
  const sendLeaveOnCleanupRef = useRef(false);

  // Pending initial queue for new sessions. This intentionally lives in a ref
  // so session activation and queue seeding can happen in either order without
  // the WebSocket effect capturing a stale null value.
  const pendingInitialQueueRef = useRef<PendingInitialQueue | null>(null);

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
      if (prev) {
        sendLeaveOnCleanupRef.current = true;
      }
      if (DEBUG) console.info('[PersistentSession] Activating session:', info.sessionId);
      setPreference(ACTIVE_SESSION_KEY, info).catch((err) =>
        console.error('[PersistentSession] Failed to persist session:', err),
      );
      return info;
    });
  }, []);

  const deactivateSession = useCallback((options?: { notifyServer?: boolean }) => {
    if (DEBUG) console.info('[PersistentSession] Deactivating session');
    if (options?.notifyServer !== false) {
      sendLeaveOnCleanupRef.current = true;
    }
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
      pendingInitialQueueRef.current = { sessionId, queue, currentClimb, sessionName };
    },
    [],
  );

  const dismissSessionSummary = useCallback(() => {
    setSessionSummary(null);
    setSessionSummaryBoardType(null);
    setSessionSummaryHealthKitWorkoutId(null);
    setSessionSummaryAutoFinished(false);
  }, []);

  const setAutoFinishedSummary = useCallback((summary: SessionSummary, boardType: string | null) => {
    setSessionSummary(summary);
    setSessionSummaryBoardType(boardType);
    setSessionSummaryHealthKitWorkoutId(null);
    setSessionSummaryAutoFinished(true);
  }, []);

  const endSessionWithSummary = useCallback(() => {
    const endingSessionId = activeSessionRef.current?.sessionId;
    const boardType = activeSessionRef.current?.parsedParams.board_name ?? null;
    const token = wsAuthTokenRef.current;

    deactivateSession({ notifyServer: false });

    if (endingSessionId && token) {
      const httpClient = createGraphQLHttpClient(token);
      httpClient
        .request<EndSessionResponse>(END_SESSION_GQL, { sessionId: endingSessionId })
        .then((response) => {
          if (response.endSession) {
            setSessionSummary(response.endSession);
            setSessionSummaryBoardType(boardType);
            setSessionSummaryHealthKitWorkoutId(null);
            setSessionSummaryAutoFinished(false);
          }
        })
        .catch((err) => {
          console.error('[PersistentSession] Failed to get session summary:', err);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable, only .current changes
  }, [deactivateSession]);

  // Re-run the auto-finished pre-flight when the tab returns to visible — backend may have swept the session.
  const visibilityCheckInFlightRef = useRef(false);
  useEffect(() => {
    if (typeof document === 'undefined') return;

    async function checkIfAutoFinished() {
      if (visibilityCheckInFlightRef.current) return;
      const active = activeSessionRef.current;
      if (!active) return;
      visibilityCheckInFlightRef.current = true;
      try {
        const result = await fetchAutoFinishedSummary(active, wsAuthTokenRef.current);
        if (!result) return;
        if (activeSessionRef.current?.sessionId !== active.sessionId) return;
        deactivateSession({ notifyServer: false });
        setAutoFinishedSummary(result.summary, result.boardType);
      } finally {
        visibilityCheckInFlightRef.current = false;
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') void checkIfAutoFinished();
    }
    function handlePageShow(event: PageTransitionEvent) {
      if (event.persisted) void checkIfAutoFinished();
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pageshow', handlePageShow);

    // BFCache restore: the browser fires `pageshow` with persisted=true after
    // bindings are restored, but if the user navigated back/forward into this
    // page before React's effect attached the listener, the event is lost.
    // Detect via the Performance API and run the check once on mount.
    if (typeof performance !== 'undefined') {
      const navEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      if (navEntry?.type === 'back_forward') {
        void checkIfAutoFinished();
      }
    }

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', handlePageShow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable, callbacks are useCallback([])-stable
  }, [deactivateSession, setAutoFinishedSummary]);

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
    let subscriptionRestartTimeout: ReturnType<typeof setTimeout> | null = null;
    let transientRetryCount = 0;
    let subscriptionRetryCount = 0;
    let isCleaningUp = false;

    async function joinSession(clientToUse: Client): Promise<Session | null> {
      if (DEBUG) console.info('[PersistentSession] Calling joinSession mutation...');
      try {
        const initialQueueData =
          pendingInitialQueueRef.current?.sessionId === sessionId ? pendingInitialQueueRef.current : null;

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
          pendingInitialQueueRef.current = null;
        }

        return joinedSession;
      } catch (err) {
        console.error('[PersistentSession] JoinSession failed:', err);
        return null;
      }
    }

    async function handleReconnect() {
      const clientForReconnect = graphqlClient;
      if (!mountedRef.current || !clientForReconnect) return;
      if (connectionGenerationRef.current !== connectionGeneration) return;
      if (isReconnectingRef.current) {
        if (DEBUG) console.info('[PersistentSession] Reconnection already in progress');
        return;
      }

      isReconnectingRef.current = true;
      if (subscriptionRestartTimeout) {
        clearTimeout(subscriptionRestartTimeout);
        subscriptionRestartTimeout = null;
      }
      try {
        if (DEBUG) console.info('[PersistentSession] Reconnecting...');

        const lastSeq = lastReceivedSequenceRef.current;
        const sessionData = await joinSession(clientForReconnect);
        if (!sessionData || !mountedRef.current) return;

        // Match the initial `connect()` success path: reset both retry
        // counters now that we know the rejoin succeeded. Otherwise a
        // low-traffic session where every reconnect succeeds but no event
        // arrives before the next disconnect accumulates strikes across
        // recovery cycles and silently force-clears the session after
        // MAX_TRANSIENT_RETRIES, even though every individual join was
        // healthy. The next-handler reset only fires when an event arrives,
        // which isn't guaranteed during a quiet window.
        transientRetryCount = 0;
        subscriptionRetryCount = 0;

        const currentSeq = sessionData.queueState.sequence;
        const gap = lastSeq !== null ? currentSeq - lastSeq : 0;

        if (DEBUG)
          console.info(
            `[PersistentSession] Reconnected. Last seq: ${lastSeq}, Current seq: ${currentSeq}, Gap: ${gap}`,
          );

        if (gap > 0 && gap <= 100 && lastSeq !== null && sessionId) {
          try {
            if (DEBUG) console.info(`[PersistentSession] Attempting delta sync for ${gap} missed events...`);

            const response = await execute<{ eventsReplay: EventsReplayResponse }>(clientForReconnect, {
              query: EVENTS_REPLAY,
              variables: { sessionId, sinceSequence: lastSeq },
            });

            const replay = response?.eventsReplay;
            if (!replay) {
              throw new Error('eventsReplay payload missing');
            }

            const replayEvents = replay.events.map(transformToSubscriptionEvent);
            if (replay.currentSequence < currentSeq) {
              throw new Error(
                `eventsReplay currentSequence ${replay.currentSequence} is behind joined sequence ${currentSeq}`,
              );
            }
            if (!hasContiguousReplayCoverage(replayEvents, lastSeq, replay.currentSequence)) {
              throw new Error(
                `eventsReplay returned non-contiguous coverage from ${lastSeq} to ${replay.currentSequence}`,
              );
            }

            if (replayEvents.length > 0) {
              if (DEBUG) console.info(`[PersistentSession] Replaying ${replayEvents.length} events`);
              replayEvents.forEach((event) => {
                handleQueueEvent(event);
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
          const localHash = computeQueueStateHash(queueRef.current, currentClimbQueueItemRef.current?.uuid || null);
          if (localHash !== sessionData.queueState.stateHash) {
            if (DEBUG) console.info('[PersistentSession] Hash mismatch on reconnect despite gap=0, applying full sync');
            applyFullSync(sessionData);
          } else {
            setLastReceivedStateHash(sessionData.queueState.stateHash);
            if (DEBUG) console.info('[PersistentSession] No missed events, already in sync');
          }
        }

        setSession(sessionData);
        startSubscriptions(clientForReconnect);
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

    function scheduleSubscriptionRecovery(reason: string) {
      if (isCleaningUp || !mountedRef.current) return;
      if (connectionGenerationRef.current !== connectionGeneration) return;
      if (subscriptionRestartTimeout) return;
      if (isReconnectingRef.current) return;

      subscriptionRetryCount++;
      if (subscriptionRetryCount > MAX_TRANSIENT_RETRIES) {
        console.warn(`[PersistentSession] Exhausted ${MAX_TRANSIENT_RETRIES} subscription retries, clearing session`);
        subscriptionRetryCount = 0;
        removePreference(ACTIVE_SESSION_KEY).catch(() => {});
        if (mountedRef.current) {
          setActiveSession(null);
        }
        return;
      }

      const delay = Math.min(
        INITIAL_RETRY_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, subscriptionRetryCount - 1),
        MAX_RETRY_DELAY_MS,
      );
      if (DEBUG)
        console.info(
          `[PersistentSession] Scheduling subscription recovery (${subscriptionRetryCount}/${MAX_TRANSIENT_RETRIES}) in ${delay}ms: ${reason}`,
        );
      subscriptionRestartTimeout = setTimeout(() => {
        subscriptionRestartTimeout = null;
        if (isCleaningUp || !mountedRef.current) return;
        if (connectionGenerationRef.current !== connectionGeneration) return;
        void handleReconnect();
      }, delay);
    }

    function startSubscriptions(clientToUse: Client) {
      if (isCleaningUp || !mountedRef.current) return;
      if (connectionGenerationRef.current !== connectionGeneration) return;

      if (!queueUnsubscribeRef.current) {
        queueUnsubscribeRef.current = subscribe<{ queueUpdates: SubscriptionQueueEvent }>(
          clientToUse,
          { query: QUEUE_UPDATES, variables: { sessionId } },
          {
            next: (data) => {
              if (data.queueUpdates) {
                subscriptionRetryCount = 0;
                handleQueueEvent(data.queueUpdates);
              }
            },
            error: (err) => {
              console.error('[PersistentSession] Queue subscription error:', err);
              queueUnsubscribeRef.current = null;
              if (mountedRef.current) {
                setError(err instanceof Error ? err : new Error(String(err)));
              }
              scheduleSubscriptionRecovery('queue subscription error');
            },
            complete: () => {
              if (DEBUG) console.info('[PersistentSession] Queue subscription completed');
              queueUnsubscribeRef.current = null;
              scheduleSubscriptionRecovery('queue subscription completed');
            },
          },
        );
      }

      if (!sessionUnsubscribeRef.current) {
        sessionUnsubscribeRef.current = subscribe<{ sessionUpdates: SessionEvent }>(
          clientToUse,
          { query: SESSION_UPDATES, variables: { sessionId } },
          {
            next: (data) => {
              if (data.sessionUpdates) {
                subscriptionRetryCount = 0;
                const event = data.sessionUpdates;
                // SessionStatsUpdated is dispatched through React Query in
                // `handleSessionEvent` — it doesn't touch session state, so
                // the reducer call skips it.
                if (event.__typename !== 'SessionStatsUpdated') {
                  // SessionEnded carries the side effect of clearing the
                  // persisted session id; `applySessionEvent` is pure so the
                  // IndexedDB removal lives here at the call site.
                  if (event.__typename === 'SessionEnded') {
                    if (DEBUG) console.info('[PersistentSession] Session ended:', event.reason);
                    removePreference(ACTIVE_SESSION_KEY).catch(() => {});
                  }
                  setSession((prev) => applySessionEvent(prev, event));
                }
                handleSessionEvent(event);
              }
            },
            error: (err) => {
              console.error('[PersistentSession] Session subscription error:', err);
              sessionUnsubscribeRef.current = null;
              scheduleSubscriptionRecovery('session subscription error');
            },
            complete: () => {
              if (DEBUG) console.info('[PersistentSession] Session subscription completed');
              sessionUnsubscribeRef.current = null;
              scheduleSubscriptionRecovery('session subscription completed');
            },
          },
        );
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
          onDisconnect: () => {
            // Tear down subscriptions BEFORE graphql-ws retries them on the new
            // connection. Without this, the library re-sends subscription operations
            // that fail requireSessionMember because joinSession hasn't been called
            // on the new connection yet.
            queueUnsubscribeRef.current?.();
            queueUnsubscribeRef.current = null;
            sessionUnsubscribeRef.current?.();
            sessionUnsubscribeRef.current = null;
          },
          connectionName: 'session',
        });
        // Capture a non-null local reference. The outer `graphqlClient` (a
        // closure `let`) is nulled by the cleanup function below — if this
        // effect's cleanup runs while `await joinSession()` is in flight,
        // resuming code that touches `graphqlClient` directly would see
        // `null` and crash on `.dispose()`. The cleanup already disposes
        // its captured client, so calling `.dispose()` again on `client`
        // here is a safe no-op (graphql-ws clients are idempotent).
        const client = graphqlClient;

        if (!mountedRef.current) {
          void client.dispose();
          isConnectingRef.current = false;
          return;
        }

        setClient(client);

        const sessionData = await joinSession(client);

        if (connectionGenerationRef.current !== connectionGeneration) {
          return;
        }

        if (!mountedRef.current) {
          void client.dispose();
          return;
        }

        if (!sessionData) {
          throw new TransientJoinError('JoinSession returned no payload');
        }

        if (DEBUG) console.info('[PersistentSession] Joined session, clientId:', sessionData.clientId);

        transientRetryCount = 0;
        subscriptionRetryCount = 0;
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

        startSubscriptions(client);

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
      isCleaningUp = true;
      mountedRef.current = false;
      isConnectingRef.current = false;
      const shouldSendLeave = sendLeaveOnCleanupRef.current;
      sendLeaveOnCleanupRef.current = false;

      const clientToCleanup = graphqlClient;
      graphqlClient = null;

      queueUnsubscribeRef.current?.();
      queueUnsubscribeRef.current = null;
      sessionUnsubscribeRef.current?.();
      sessionUnsubscribeRef.current = null;

      if (clientToCleanup) {
        void Promise.resolve()
          .then(async () => {
            if (shouldSendLeave) {
              try {
                await execute(clientToCleanup, { query: LEAVE_SESSION }, 5000);
              } catch (err) {
                if (DEBUG) console.info('[PersistentSession] Explicit leave failed during cleanup:', err);
              }
            }
            await clientToCleanup.dispose();
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
      if (subscriptionRestartTimeout) {
        clearTimeout(subscriptionRestartTimeout);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable, only .current changes; intentional dep list
  }, [activeSession, isAuthLoading, handleQueueEvent, handleSessionEvent, setLastReceivedStateHash, setSession]);

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
    sessionSummaryAutoFinished,
    activateSession,
    deactivateSession,
    setInitialQueueForSession,
    endSessionWithSummary,
    setAutoFinishedSummary,
    dismissSessionSummary,
    setSession,
  };
}
