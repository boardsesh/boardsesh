import {
  createContext,
  useContext,
  useReducer,
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { queueReducer, initialState, createQueueSyncCoordinator, generateClientId } from '@boardsesh/queue';
import type { QueueState, QueueAction, QueueSearchParams, ClimbQueueItem } from '@boardsesh/queue';
import {
  createJoinSessionTracker,
  createSetCurrentClimbCoalescer,
  mapSubscriptionEnvelopeToAction,
  type SubscriptionWireEnvelope,
} from '@boardsesh/queue-runtime';
import type { SessionSummary } from '@boardsesh/shared-schema';
import { execute } from '@boardsesh/graphql-client';
import { buildBoardPath } from '@boardsesh/board-config';
import { JOIN_SESSION } from '@boardsesh/graphql/operations/queue-session';
import { getWsClient } from '../lib/graphql/ws-client';
import { getHttpClient } from '../lib/graphql/client';
import {
  QUEUE_UPDATES_SUBSCRIPTION,
  ADD_QUEUE_ITEM,
  REMOVE_QUEUE_ITEM,
  SET_CURRENT_CLIMB,
  CREATE_SESSION,
  END_SESSION,
  type AddQueueItemMutationResponse,
  type RemoveQueueItemMutationResponse,
  type SetCurrentClimbMutationResponse,
  type CreateSessionMutationResponse,
  type EndSessionMutationResponse,
} from '../lib/graphql/operations';
import { getStoredBoardConfig } from '../lib/board-store';
import { getStoredSessionId, setStoredSessionId, clearStoredSessionId } from '../lib/session-store';
import { findNextQueueItem, findPreviousQueueItem } from '@boardsesh/play-view';
import { toClimbQueueItem, type SubscriptionQueueItem } from '../lib/queue-conversion';
import { useToast } from './toast-provider';

type QueueContextValue = {
  state: QueueState;
  dispatch: React.Dispatch<QueueAction>;
  sessionId: string | null;
  setSessionId: (id: string | null) => void;
  addToQueue: (item: ClimbQueueItem) => void;
  removeFromQueue: (uuid: string) => void;
  clearQueue: () => void;
  setCurrentClimb: (item: ClimbQueueItem) => void;
  nextClimb: () => void;
  previousClimb: () => void;
  clearSession: () => Promise<void>;
  endSession: () => Promise<SessionSummary | null>;
};

const QueueContext = createContext<QueueContextValue | null>(null);

export function useQueue(): QueueContextValue {
  const context = useContext(QueueContext);
  if (!context) throw new Error('useQueue must be used within QueueProvider');
  return context;
}

const defaultSearchParams: QueueSearchParams = {};

// The wire envelope shape matches what QUEUE_UPDATES_SUBSCRIPTION returns —
// the subscription aliases `item`→`addedItem` (disambiguates from the
// overlapping `item` selection on CurrentClimbChanged) and `uuid`→`mirroredUuid`
// (disambiguates from QueueItemRemoved.uuid). Both aliases are first-class on
// `SubscriptionWireEnvelope` so we can use the wire type directly.
type QueueUpdateEvent = SubscriptionWireEnvelope<SubscriptionQueueItem>;

export function QueueProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(queueReducer, defaultSearchParams, initialState);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const sessionCreationRef = useRef<Promise<string | null> | null>(null);
  const { showToast } = useToast();
  const { t } = useTranslation('session');

  // JOIN_SESSION cache, keyed by (sessionId, connection epoch). Built once
  // per mount so its inFlight state survives re-renders. Web has a separate
  // implementation inside `persistent-session/hooks/use-session-lifecycle.ts`;
  // adopting this tracker there is a follow-up.
  const joinTracker = useMemo(
    () =>
      createJoinSessionTracker({
        getBoardPath: async () => {
          const boardConfig = await getStoredBoardConfig();
          if (!boardConfig) return null;
          return buildBoardPath(
            boardConfig.boardName,
            boardConfig.layoutId,
            boardConfig.sizeId,
            boardConfig.setIds,
            boardConfig.angle,
          );
        },
        execute: ({ sessionId: sid, boardPath }) =>
          execute(getWsClient(), { query: JOIN_SESSION, variables: { sessionId: sid, boardPath } }),
      }),
    [],
  );
  const ensureJoined = useCallback((sessionIdToJoin: string) => joinTracker.ensureJoined(sessionIdToJoin), [joinTracker]);

  // Build the sync coordinator once per provider mount. The clientId is
  // generated fresh per app launch (no persistence needed today — only
  // matters within a single WebSocket session for echo suppression). Pass
  // the reducer's dispatch in so the coordinator can prune timed-out
  // pending correlation IDs.
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const coordinator = useMemo(
    () =>
      createQueueSyncCoordinator({
        clientId: generateClientId(),
        dispatch: (action) => dispatchRef.current(action),
      }),
    [],
  );
  useEffect(() => () => coordinator.dispose(), [coordinator]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    getStoredSessionId().then((storedId) => {
      if (__DEV__) {
        console.info(`[session] restored from store: ${storedId ?? '(none)'}`);
      }
      if (storedId) setSessionId(storedId);
    });
  }, []);

  // showToast and t aren't stable callbacks — capture via refs so the WS
  // subscription effect doesn't tear down & re-subscribe on locale change
  // (which would briefly miss in-flight peer events). coordinator and dispatch
  // are stable (useMemo([]) / useReducer respectively) so they can sit in the
  // dep array directly.
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    if (!sessionId) {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      joinTracker.reset();
      return;
    }

    const wsClient = getWsClient();

    // graphql-ws auto-reconnects, and every reconnect gives us a fresh
    // per-connection ConnectionContext on the backend. Invalidate the join
    // cache on `closed` (not on `connected`) — invalidating on `connected`
    // races mutations issued while the socket is down: they read the
    // resolved-but-stale ref from the dead connection, then graphql-ws sends
    // them over the new socket before the re-issued JOIN_SESSION lands.
    // Bumping the epoch on `closed` makes any cached entry stale by key.
    const unsubClosed = wsClient.on('closed', () => {
      joinTracker.bumpEpoch();
    });
    const logJoinFailure = (err: unknown) => {
      if (__DEV__) console.warn('[queue] joinSession failed', err);
    };
    const unsubConnected = wsClient.on('connected', () => {
      // On initial connect this is a no-op (eager fire below cached the
      // entry at the same epoch); on reconnect `closed` already cleared
      // the ref so this re-fires JOIN_SESSION on the new socket.
      ensureJoined(sessionId).catch(logJoinFailure);
    });

    // Fire the initial join eagerly so mutations issued before the first user
    // interaction still find a resolved promise in joinPromiseRef.
    ensureJoined(sessionId).catch(logJoinFailure);

    const cleanup = wsClient.subscribe<{ queueUpdates: QueueUpdateEvent }>(
      {
        query: QUEUE_UPDATES_SUBSCRIPTION,
        variables: { sessionId },
      },
      {
        next: ({ data }) => {
          if (!data?.queueUpdates) return;
          const result = mapSubscriptionEnvelopeToAction(data.queueUpdates, {
            mapItem: toClimbQueueItem,
            context: { myClientId: coordinator.clientId },
          });
          if (result.kind === 'dispatch') dispatch(result.action);
          // TODO(analytics-parity): web's use-queue-event-subscription.ts
          // tracks peer-broadcast QueueItemAdded/QueueItemRemoved via track().
          // Mobile lacks an analytics module today; revisit once the mobile
          // analytics surface exists.
        },
        error: () => {
          showToastRef.current(tRef.current('mobile.queue.syncError'), 'error');
        },
        complete: () => {},
      },
    );

    unsubscribeRef.current = cleanup;

    return () => {
      cleanup();
      unsubConnected();
      unsubClosed();
      unsubscribeRef.current = null;
      joinTracker.reset();
    };
  }, [sessionId, coordinator, ensureJoined, joinTracker]);

  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (sessionCreationRef.current) return sessionCreationRef.current;

    const createPromise = (async () => {
      const boardConfig = await getStoredBoardConfig();
      if (!boardConfig) return null;

      const boardPath = buildBoardPath(
        boardConfig.boardName,
        boardConfig.layoutId,
        boardConfig.sizeId,
        boardConfig.setIds,
        boardConfig.angle,
      );

      try {
        const response = await getHttpClient().request<CreateSessionMutationResponse>(CREATE_SESSION, {
          input: { boardPath, latitude: 0, longitude: 0, discoverable: false },
        });
        const newId = response.createSession.id;
        sessionIdRef.current = newId;
        setSessionId(newId);
        await setStoredSessionId(newId);
        return newId;
      } catch {
        showToast(t('mobile.queue.sessionCreateError'), 'error');
        return null;
      } finally {
        sessionCreationRef.current = null;
      }
    })();

    sessionCreationRef.current = createPromise;
    return createPromise;
  }, [showToast, t]);

  const addToQueue = useCallback(
    (item: ClimbQueueItem) => {
      // Optimistic local dispatch. The server will echo this item via the WS subscription,
      // but the reducer's DELTA_ADD_QUEUE_ITEM handler uses insertQueueItemIdempotent which
      // deduplicates by item.uuid, so the echo is a no-op.
      dispatch({ type: 'DELTA_ADD_QUEUE_ITEM', payload: { item } });

      ensureSession().then(async (activeSessionId) => {
        if (!activeSessionId) return;
        try {
          await ensureJoined(activeSessionId);
          await execute<AddQueueItemMutationResponse>(getWsClient(), {
            query: ADD_QUEUE_ITEM,
            variables: { item: { uuid: item.uuid, climb: item.climb } },
          });
        } catch {
          showToast(t('mobile.queue.actionFailed'), 'error');
        }
      });
    },
    [ensureSession, ensureJoined, showToast, t],
  );

  const removeFromQueue = useCallback(
    (uuid: string) => {
      dispatch({ type: 'DELTA_REMOVE_QUEUE_ITEM', payload: { uuid } });

      const activeSessionId = sessionIdRef.current;
      if (!activeSessionId) return;
      (async () => {
        try {
          await ensureJoined(activeSessionId);
          await execute<RemoveQueueItemMutationResponse>(getWsClient(), {
            query: REMOVE_QUEUE_ITEM,
            variables: { uuid },
          });
        } catch {
          showToast(t('mobile.queue.actionFailed'), 'error');
        }
      })();
    },
    [ensureJoined, showToast, t],
  );

  const clearQueue = useCallback(() => {
    const itemsToRemove = stateRef.current.queue;
    dispatch({ type: 'CLEAR_QUEUE' });

    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId) return;
    (async () => {
      try {
        await ensureJoined(activeSessionId);
        for (const item of itemsToRemove) {
          execute<RemoveQueueItemMutationResponse>(getWsClient(), {
            query: REMOVE_QUEUE_ITEM,
            variables: { uuid: item.uuid },
          }).catch(() => showToast(t('mobile.queue.actionFailed'), 'error'));
        }
      } catch {
        showToast(t('mobile.queue.actionFailed'), 'error');
      }
    })();
  }, [ensureJoined, showToast, t]);

  // Serialize-and-supersede SET_CURRENT_CLIMB. Rapid swipes used to stack
  // up requests; the coalescer keeps at most one in flight and drops all but
  // the latest pending args. Built once per mount (stable) — sendArgs reads
  // from refs so locale changes don't reset the inFlight/pending state.
  //
  // `getContext` snapshots the session id at enqueue. The captured value
  // (string | null) flows through sendArgs and sendSupersededQueueAdd. If
  // null at enqueue (no session yet — common when ensureSession is still
  // creating the session), sendArgs awaits ensureSession to create one,
  // and the supersede ADD waits for the same promise so it doesn't race
  // ahead of session creation.
  const ensureSessionRef = useRef(ensureSession);
  ensureSessionRef.current = ensureSession;
  const setCurrentClimbCoalescer = useMemo(
    () =>
      createSetCurrentClimbCoalescer<string | null>({
        getContext: () => sessionIdRef.current,
        sendArgs: async (args, capturedSessionId) => {
          if (!args.item) return;
          // If no session was captured at enqueue, create one now (and use
          // it for any drained pending args from the same enqueue batch).
          // If a session was captured but has since flipped, drop — same
          // reasoning as web: applying a stale setCurrent to a new session
          // would surface a stale climb.
          const sessionId = capturedSessionId ?? (await ensureSessionRef.current());
          if (!sessionId) return;
          if (capturedSessionId !== null && sessionIdRef.current !== capturedSessionId) return;
          await ensureJoined(sessionId);
          await execute<SetCurrentClimbMutationResponse>(getWsClient(), {
            query: SET_CURRENT_CLIMB,
            variables: {
              item: { uuid: args.item.uuid, climb: args.item.climb },
              shouldAddToQueue: args.shouldAddToQueue,
              correlationId: args.correlationId,
            },
          });
        },
        sendSupersededQueueAdd: async (item, capturedSessionId) => {
          // Fire the ADD_QUEUE_ITEM against the session that was active when
          // the now-superseded args were enqueued, not the current one. If
          // no session was captured (enqueued before ensureSession resolved)
          // or the captured session has since flipped, drop.
          if (!capturedSessionId || sessionIdRef.current !== capturedSessionId) return;
          await ensureJoined(capturedSessionId);
          await execute<AddQueueItemMutationResponse>(getWsClient(), {
            query: ADD_QUEUE_ITEM,
            variables: { item: { uuid: item.uuid, climb: item.climb } },
          });
        },
        onDrainError: () => {
          showToastRef.current(tRef.current('mobile.queue.actionFailed'), 'error');
        },
        onSupersededQueueAddError: () => {
          showToastRef.current(tRef.current('mobile.queue.actionFailed'), 'error');
        },
      }),
    [ensureJoined],
  );

  // Optimistic local dispatch + correlated SET_CURRENT_CLIMB mutation.
  // The reducer stores `correlationId` in pendingCurrentClimbUpdates so the
  // echoed CurrentClimbChanged event (carrying the same id back in
  // `serverCorrelationId`) is suppressed instead of re-applied.
  const dispatchSetCurrent = useCallback(
    (item: ClimbQueueItem, shouldAddToQueue: boolean) => {
      const correlationId = coordinator.generateCorrelationId();
      dispatch({
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: { item, shouldAddToQueue, isServerEvent: false, correlationId },
      });
      coordinator.trackPendingMutation(correlationId);
      setCurrentClimbCoalescer.enqueue({ item, shouldAddToQueue, correlationId }).catch(() => {
        showToast(t('mobile.queue.actionFailed'), 'error');
      });
    },
    [coordinator, setCurrentClimbCoalescer, showToast, t],
  );

  const setCurrentClimb = useCallback((item: ClimbQueueItem) => dispatchSetCurrent(item, true), [dispatchSetCurrent]);

  const nextClimb = useCallback(() => {
    const { queue, currentClimbQueueItem } = stateRef.current;
    const nextItem = findNextQueueItem(queue, currentClimbQueueItem);
    if (nextItem) dispatchSetCurrent(nextItem, false);
  }, [dispatchSetCurrent]);

  const previousClimb = useCallback(() => {
    const { queue, currentClimbQueueItem } = stateRef.current;
    const prevItem = findPreviousQueueItem(queue, currentClimbQueueItem);
    if (prevItem) dispatchSetCurrent(prevItem, false);
  }, [dispatchSetCurrent]);

  const clearSession = useCallback(async () => {
    setSessionId(null);
    dispatch({
      type: 'INITIAL_QUEUE_DATA',
      payload: { queue: [], currentClimbQueueItem: null },
    });
    await clearStoredSessionId();
  }, []);

  const endSession = useCallback(async (): Promise<SessionSummary | null> => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) return null;

    try {
      const response = await getHttpClient().request<EndSessionMutationResponse>(END_SESSION, {
        sessionId: currentSessionId,
      });
      await clearSession();
      showToast(t('mobile.toast.sessionEnded'), 'success');
      return response.endSession;
    } catch {
      showToast(t('mobile.queue.actionFailed'), 'error');
      return null;
    }
  }, [clearSession, showToast, t]);

  const contextValue = useMemo<QueueContextValue>(
    () => ({
      state,
      dispatch,
      sessionId,
      setSessionId,
      addToQueue,
      removeFromQueue,
      clearQueue,
      setCurrentClimb,
      nextClimb,
      previousClimb,
      clearSession,
      endSession,
    }),
    [
      state,
      sessionId,
      addToQueue,
      removeFromQueue,
      clearQueue,
      setCurrentClimb,
      nextClimb,
      previousClimb,
      clearSession,
      endSession,
    ],
  );

  return <QueueContext.Provider value={contextValue}>{children}</QueueContext.Provider>;
}
