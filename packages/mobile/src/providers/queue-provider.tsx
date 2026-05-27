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
import {
  queueReducer,
  initialState,
  createQueueSyncCoordinator,
  generateClientId,
  type SyncQueueEvent,
} from '@boardsesh/queue';
import type { QueueState, QueueAction, QueueSearchParams, ClimbQueueItem } from '@boardsesh/queue';
import type { SessionSummary } from '@boardsesh/shared-schema';
import { execute } from '@boardsesh/graphql-client';
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

// -- Subscription event types (used only for the event discriminated union) --
//
// Mirrors what the QUEUE_UPDATES_SUBSCRIPTION request asks for. The
// SubscriptionQueueItem variant comes back nested under each event; the
// outer envelope carries server bookkeeping (sequence, stateHash) plus the
// echo-suppression hints (`clientId`, `correlationId`) on CurrentClimbChanged.
// We adapt these to the coordinator's wider `SyncQueueEvent` shape before
// dispatching.

type FullSyncEvent = {
  __typename: 'FullSync';
  sequence: number;
  state: {
    sequence: number;
    stateHash: string;
    queue: SubscriptionQueueItem[];
    currentClimbQueueItem: SubscriptionQueueItem | null;
  };
};

type QueueItemAddedEvent = {
  __typename: 'QueueItemAdded';
  sequence: number;
  stateHash: string;
  item: SubscriptionQueueItem;
  position: number | null;
};

type QueueItemRemovedEvent = {
  __typename: 'QueueItemRemoved';
  sequence: number;
  stateHash: string;
  uuid: string;
};

type QueueReorderedEvent = {
  __typename: 'QueueReordered';
  sequence: number;
  stateHash: string;
  uuid: string;
  oldIndex: number;
  newIndex: number;
};

type CurrentClimbChangedEvent = {
  __typename: 'CurrentClimbChanged';
  sequence: number;
  stateHash: string;
  item: SubscriptionQueueItem | null;
  clientId: string | null;
  correlationId: string | null;
};

type ClimbMirroredEvent = {
  __typename: 'ClimbMirrored';
  sequence: number;
  stateHash: string;
  uuid: string | null;
  mirrored: boolean;
};

type QueueUpdateEvent =
  | FullSyncEvent
  | QueueItemAddedEvent
  | QueueItemRemovedEvent
  | QueueReorderedEvent
  | CurrentClimbChangedEvent
  | ClimbMirroredEvent;

function toSyncQueueEvent(event: QueueUpdateEvent): SyncQueueEvent {
  switch (event.__typename) {
    case 'FullSync': {
      return {
        __typename: 'FullSync',
        state: {
          queue: event.state.queue.map(toClimbQueueItem),
          currentClimbQueueItem: event.state.currentClimbQueueItem
            ? toClimbQueueItem(event.state.currentClimbQueueItem)
            : null,
        },
      };
    }
    case 'QueueItemAdded':
      return {
        __typename: 'QueueItemAdded',
        item: toClimbQueueItem(event.item),
        position: event.position,
      };
    case 'QueueItemRemoved':
      return { __typename: 'QueueItemRemoved', uuid: event.uuid };
    case 'QueueReordered':
      return {
        __typename: 'QueueReordered',
        uuid: event.uuid,
        oldIndex: event.oldIndex,
        newIndex: event.newIndex,
      };
    case 'CurrentClimbChanged':
      return {
        __typename: 'CurrentClimbChanged',
        item: event.item ? toClimbQueueItem(event.item) : null,
        clientId: event.clientId,
        correlationId: event.correlationId,
      };
    case 'ClimbMirrored':
      return {
        __typename: 'ClimbMirrored',
        mirrored: event.mirrored,
        // Server emits the canonical queue-item uuid under `uuid`; the
        // coordinator forwards it as `mirroredUuid` for the reducer's
        // race-guard against driver navigating mid-mirror.
        mirroredUuid: event.uuid,
      };
  }
}

export function QueueProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(queueReducer, defaultSearchParams, initialState);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const sessionCreationRef = useRef<Promise<string | null> | null>(null);
  // Tracks the in-flight (or completed) joinSession mutation for the current
  // WS connection. Queue mutations gate on this so a swipe issued right after
  // CREATE_SESSION still goes out *after* the WS-side joinSession has bound
  // sessionId into the backend's per-connection context. Stored alongside the
  // sessionId it was issued for so a session-switch invalidates it.
  const joinPromiseRef = useRef<{ sessionId: string; promise: Promise<unknown> } | null>(null);
  const { showToast } = useToast();
  const { t } = useTranslation('session');

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

  // Lazily fire JOIN_SESSION over the WS so the backend binds sessionId into
  // the per-connection ConnectionContext. After this resolves, all WS-routed
  // queue mutations on the same connection have ctx.sessionId set, which
  // `requireSession(ctx)` in the queue resolvers checks before allowing the
  // operation. Idempotent on the server (re-joining the same session is a
  // no-op for the room manager); we cache the in-flight promise so concurrent
  // callers share one mutation per (sessionId, connection) pair.
  const ensureJoined = useCallback(async (sessionIdToJoin: string): Promise<void> => {
    const current = joinPromiseRef.current;
    if (current && current.sessionId === sessionIdToJoin) {
      await current.promise;
      return;
    }
    const boardConfig = await getStoredBoardConfig();
    if (!boardConfig) return;
    const boardPath = `${boardConfig.boardName}/${boardConfig.layoutId}/${boardConfig.sizeId}/${boardConfig.setIds}/${boardConfig.angle}`;
    const promise = execute(getWsClient(), {
      query: JOIN_SESSION,
      variables: { sessionId: sessionIdToJoin, boardPath },
    });
    joinPromiseRef.current = { sessionId: sessionIdToJoin, promise };
    await promise;
  }, []);

  useEffect(() => {
    if (!sessionId) {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      joinPromiseRef.current = null;
      return;
    }

    const wsClient = getWsClient();

    // graphql-ws auto-reconnects, and every reconnect gives us a fresh
    // per-connection ConnectionContext on the backend. The first `connected`
    // event matches the initial connection — we fire joinSession explicitly
    // below to set up `joinPromiseRef`. Subsequent `connected` events are
    // reconnects: invalidate the stale join and refire over the new connection.
    let isFirstConnect = true;
    const unsubConnected = wsClient.on('connected', () => {
      if (isFirstConnect) {
        isFirstConnect = false;
        return;
      }
      joinPromiseRef.current = null;
      void ensureJoined(sessionId);
    });

    // Fire the initial join eagerly so mutations issued before the first user
    // interaction still find a resolved promise in joinPromiseRef.
    void ensureJoined(sessionId);

    const cleanup = wsClient.subscribe<{ queueUpdates: QueueUpdateEvent }>(
      {
        query: QUEUE_UPDATES_SUBSCRIPTION,
        variables: { sessionId },
      },
      {
        next: ({ data }) => {
          if (!data?.queueUpdates) return;
          const result = coordinator.mapIncomingEvent(toSyncQueueEvent(data.queueUpdates));
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
      unsubscribeRef.current = null;
      joinPromiseRef.current = null;
    };
  }, [sessionId, coordinator, ensureJoined]);

  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (sessionCreationRef.current) return sessionCreationRef.current;

    const createPromise = (async () => {
      const boardConfig = await getStoredBoardConfig();
      if (!boardConfig) return null;

      const boardPath = `${boardConfig.boardName}/${boardConfig.layoutId}/${boardConfig.sizeId}/${boardConfig.setIds}/${boardConfig.angle}`;

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
      ensureSession().then(async (activeSessionId) => {
        if (!activeSessionId) return;
        try {
          await ensureJoined(activeSessionId);
          await execute<SetCurrentClimbMutationResponse>(getWsClient(), {
            query: SET_CURRENT_CLIMB,
            variables: {
              item: { uuid: item.uuid, climb: item.climb },
              shouldAddToQueue,
              correlationId,
            },
          });
        } catch {
          showToast(t('mobile.queue.actionFailed'), 'error');
        }
      });
    },
    [coordinator, ensureSession, ensureJoined, showToast, t],
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
