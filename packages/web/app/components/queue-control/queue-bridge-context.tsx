'use client';

import React, { createContext, useContext, useState, useCallback, useMemo, useLayoutEffect, useRef, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import {
  QueueContext, QueueActionsContext, QueueDataContext,
  CurrentClimbContext, QueueListContext, SearchContext, SessionContext,
  type GraphQLQueueContextType, type GraphQLQueueActionsType, type GraphQLQueueDataType,
} from '../graphql-queue/QueueContext';
import type { CurrentClimbDataType, QueueListDataType, SearchDataType, SessionDataType } from '../graphql-queue/types';
import { usePersistentSession } from '../persistent-session';
import { getBaseBoardPath } from '@/app/lib/url-utils';
import { DEFAULT_SEARCH_PARAMS } from '@/app/lib/url-utils';
import type { BoardDetails, Angle, Climb, SearchRequestPagination } from '@/app/lib/types';
import type { ClimbQueueItem } from './types';
import dynamic from 'next/dynamic';

const LiveActivityBridge = dynamic(
  () => import('@/app/lib/live-activity/live-activity-bridge'),
  { ssr: false },
);

// -------------------------------------------------------------------
// Board info context (for the root-level bottom bar to know what board is active)
// -------------------------------------------------------------------

interface QueueBridgeBoardInfo {
  boardDetails: BoardDetails | null;
  angle: Angle;
  hasActiveQueue: boolean;
}

const QueueBridgeBoardInfoContext = createContext<QueueBridgeBoardInfo>({
  boardDetails: null,
  angle: 0,
  hasActiveQueue: false,
});

export function useQueueBridgeBoardInfo() {
  return useContext(QueueBridgeBoardInfoContext);
}

// -------------------------------------------------------------------
// Setter context (for the injector to push board-route context into the bridge)
// -------------------------------------------------------------------

interface QueueBridgeSetters {
  inject: (
    ctx: GraphQLQueueContextType,
    actions: GraphQLQueueActionsType,
    data: GraphQLQueueDataType,
    bd: BoardDetails,
    angle: Angle,
  ) => void;
  updateContext: (
    ctx: GraphQLQueueContextType,
    actions: GraphQLQueueActionsType,
    data: GraphQLQueueDataType,
  ) => void;
  clear: () => void;
}

const QueueBridgeSetterContext = createContext<QueueBridgeSetters>({
  inject: () => {},
  updateContext: () => {},
  clear: () => {},
});

// -------------------------------------------------------------------
// usePersistentSessionQueueAdapter — thin adapter over PersistentSession
// Uses latestRef pattern for stable action callbacks (matches GraphQLQueueProvider).
// -------------------------------------------------------------------

function usePersistentSessionQueueAdapter(): {
  context: GraphQLQueueContextType;
  actionsValue: GraphQLQueueActionsType;
  dataValue: GraphQLQueueDataType;
  boardDetails: BoardDetails | null;
  angle: Angle;
  hasActiveQueue: boolean;
} {
  const ps = usePersistentSession();

  const isParty = !!ps.activeSession;
  const queue = isParty ? ps.queue : ps.localQueue;
  const currentClimbQueueItem = isParty ? ps.currentClimbQueueItem : ps.localCurrentClimbQueueItem;
  const boardDetails = isParty ? ps.activeSession!.boardDetails : ps.localBoardDetails;
  const angle: Angle = isParty
    ? ps.activeSession!.parsedParams.angle
    : (ps.localCurrentClimbQueueItem?.climb?.angle ?? 0);

  const baseBoardPath = useMemo(() => {
    if (isParty && ps.activeSession?.boardPath) {
      return getBaseBoardPath(ps.activeSession.boardPath);
    }
    return ps.localBoardPath ?? '';
  }, [isParty, ps.activeSession?.boardPath, ps.localBoardPath]);

  const hasActiveQueue = (queue.length > 0 || !!currentClimbQueueItem || isParty) && !!boardDetails;

  const parsedParams = useMemo(() => {
    if (!boardDetails) {
      return { board_name: 'kilter' as const, layout_id: 0, size_id: 0, set_ids: [0], angle: 0 };
    }
    return {
      board_name: boardDetails.board_name,
      layout_id: boardDetails.layout_id,
      size_id: boardDetails.size_id,
      set_ids: boardDetails.set_ids,
      angle,
    };
  }, [boardDetails, angle]);

  // --- Ref holding latest values so action callbacks can be stable ---
  const latestRef = useRef({ queue, currentClimbQueueItem, boardDetails, baseBoardPath, ps });
  latestRef.current = { queue, currentClimbQueueItem, boardDetails, baseBoardPath, ps };

  const getNextClimbQueueItem = useCallback((): ClimbQueueItem | null => {
    const r = latestRef.current;
    const idx = r.queue.findIndex(({ uuid }) => uuid === r.currentClimbQueueItem?.uuid);
    return idx >= 0 && idx < r.queue.length - 1 ? r.queue[idx + 1] : null;
  }, []);

  const getPreviousClimbQueueItem = useCallback((): ClimbQueueItem | null => {
    const r = latestRef.current;
    const idx = r.queue.findIndex(({ uuid }) => uuid === r.currentClimbQueueItem?.uuid);
    return idx > 0 ? r.queue[idx - 1] : null;
  }, []);

  const setCurrentClimbQueueItem = useCallback(
    (item: ClimbQueueItem) => {
      const r = latestRef.current;
      if (!r.boardDetails) return;
      const alreadyInQueue = r.queue.some(q => q.uuid === item.uuid);
      if (alreadyInQueue && r.currentClimbQueueItem?.uuid === item.uuid) return;
      const newQueue = alreadyInQueue ? r.queue : [...r.queue, item];
      r.ps.setLocalQueueState(newQueue, item, r.baseBoardPath, r.boardDetails);
    },
    [],
  );

  const addToQueue = useCallback(
    (climb: Climb) => {
      const r = latestRef.current;
      if (!r.boardDetails) return;
      const newItem: ClimbQueueItem = {
        climb,
        addedBy: null,
        uuid: uuidv4(),
        suggested: false,
      };
      const newQueue = [...r.queue, newItem];
      const current = r.currentClimbQueueItem ?? newItem;
      r.ps.setLocalQueueState(newQueue, current, r.baseBoardPath, r.boardDetails);
    },
    [],
  );

  const removeFromQueue = useCallback(
    (item: ClimbQueueItem) => {
      const r = latestRef.current;
      if (!r.boardDetails) return;
      const newQueue = r.queue.filter(q => q.uuid !== item.uuid);
      const newCurrent = r.currentClimbQueueItem?.uuid === item.uuid
        ? (newQueue[0] ?? null)
        : r.currentClimbQueueItem;
      r.ps.setLocalQueueState(newQueue, newCurrent, r.baseBoardPath, r.boardDetails);
    },
    [],
  );

  const setQueue = useCallback(
    (newQueue: ClimbQueueItem[]) => {
      const r = latestRef.current;
      if (!r.boardDetails) return;
      const newCurrent = newQueue.length === 0
        ? null
        : (r.currentClimbQueueItem && newQueue.some(q => q.uuid === r.currentClimbQueueItem!.uuid)
            ? r.currentClimbQueueItem
            : newQueue[0]);
      r.ps.setLocalQueueState(newQueue, newCurrent, r.baseBoardPath, r.boardDetails);
    },
    [],
  );

  const mirrorClimb = useCallback(() => {
    const r = latestRef.current;
    if (!r.currentClimbQueueItem?.climb || !r.boardDetails) return;
    const mirrored = !r.currentClimbQueueItem.climb.mirrored;
    const updatedItem: ClimbQueueItem = {
      ...r.currentClimbQueueItem,
      climb: { ...r.currentClimbQueueItem.climb, mirrored },
    };
    const newQueue = r.queue.map(q => (q.uuid === updatedItem.uuid ? updatedItem : q));
    r.ps.setLocalQueueState(newQueue, updatedItem, r.baseBoardPath, r.boardDetails);
  }, []);

  const setCurrentClimb = useCallback(
    (climb: Climb) => {
      const r = latestRef.current;
      if (!r.boardDetails) return;
      const newItem: ClimbQueueItem = {
        climb,
        addedBy: null,
        uuid: uuidv4(),
        suggested: false,
      };
      const currentIdx = r.currentClimbQueueItem
        ? r.queue.findIndex(q => q.uuid === r.currentClimbQueueItem!.uuid)
        : -1;
      const newQueue = [...r.queue];
      if (currentIdx >= 0) {
        newQueue.splice(currentIdx + 1, 0, newItem);
      } else {
        newQueue.push(newItem);
      }
      r.ps.setLocalQueueState(newQueue, newItem, r.baseBoardPath, r.boardDetails);
    },
    [],
  );

  // No-op functions for fields not used by the bottom bar
  const noop = useCallback(() => {}, []);
  const noopStartSession = useCallback(
    async (_options?: { discoverable?: boolean; name?: string; sessionId?: string }) => '',
    [],
  );
  const noopJoinSession = useCallback(async (_sessionId: string) => {}, []);
  const noopSetClimbSearchParams = useCallback((_params: SearchRequestPagination) => {}, []);
  // Wrap deactivateSession via ref so actionsValue deps are fully stable
  const stableDeactivateSession = useCallback(() => {
    latestRef.current.ps.deactivateSession();
  }, []);

  // Actions value is now stable — all callbacks use latestRef with empty deps
  const actionsValue: GraphQLQueueActionsType = useMemo(
    () => ({
      addToQueue,
      removeFromQueue,
      setCurrentClimb,
      setCurrentClimbQueueItem,
      setClimbSearchParams: noopSetClimbSearchParams,
      setCountSearchParams: noopSetClimbSearchParams,
      mirrorClimb,
      fetchMoreClimbs: noop,
      getNextClimbQueueItem,
      getPreviousClimbQueueItem,
      setQueue,
      startSession: noopStartSession,
      joinSession: noopJoinSession,
      endSession: stableDeactivateSession,
      dismissSessionSummary: noop,
      disconnect: stableDeactivateSession,
    }),
    [
      addToQueue,
      removeFromQueue,
      setCurrentClimb,
      setCurrentClimbQueueItem,
      noopSetClimbSearchParams,
      mirrorClimb,
      noop,
      getNextClimbQueueItem,
      getPreviousClimbQueueItem,
      setQueue,
      stableDeactivateSession,
      noopStartSession,
      noopJoinSession,
    ],
  );

  const dataValue: GraphQLQueueDataType = useMemo(
    () => ({
      queue,
      currentClimbQueueItem,
      currentClimb: currentClimbQueueItem?.climb ?? null,
      climbSearchParams: DEFAULT_SEARCH_PARAMS,
      climbSearchResults: null,
      suggestedClimbs: [],
      totalSearchResultCount: null,
      hasMoreResults: false,
      isFetchingClimbs: false,
      isFetchingNextPage: false,
      hasDoneFirstFetch: false,
      viewOnlyMode: false,
      connectionState: 'connected',
      canMutate: true,
      parsedParams,
      isSessionActive: isParty && ps.hasConnected,
      sessionId: ps.activeSession?.sessionId ?? null,
      sessionSummary: null,
      sessionGoal: ps.session?.goal ?? null,
      users: isParty ? ps.users : [],
      clientId: ps.clientId,
      isLeader: ps.isLeader,
      isBackendMode: true,
      hasConnected: ps.hasConnected,
      connectionError: ps.error,
      isDisconnected: false,
    }),
    [
      queue,
      currentClimbQueueItem,
      parsedParams,
      isParty,
      ps.hasConnected,
      ps.activeSession?.sessionId,
      ps.session?.goal,
      ps.users,
      ps.clientId,
      ps.isLeader,
      ps.error,
    ],
  );

  const context: GraphQLQueueContextType = useMemo(
    () => ({ ...dataValue, ...actionsValue }),
    [dataValue, actionsValue],
  );

  return { context, actionsValue, dataValue, boardDetails, angle, hasActiveQueue };
}

// -------------------------------------------------------------------
// QueueBridgeProvider — wraps children + bottom bar at root level
// -------------------------------------------------------------------

export function QueueBridgeProvider({ children }: { children: React.ReactNode }) {
  // Whether a board route injector is currently mounted
  const [isInjected, setIsInjected] = useState(false);
  // Board details and angle from the injector (stable across context updates)
  const [injectedBoardDetails, setInjectedBoardDetails] = useState<BoardDetails | null>(null);
  const [injectedAngle, setInjectedAngle] = useState<Angle>(0);

  // Injected values stored in refs to avoid cleanup/setup cycles.
  // Separate refs for combined, actions, and data so we can track
  // actions identity changes independently from data changes.
  const injectedContextRef = useRef<GraphQLQueueContextType | null>(null);
  const injectedActionsRef = useRef<GraphQLQueueActionsType | null>(null);
  const injectedDataRef = useRef<GraphQLQueueDataType | null>(null);

  // Separate version counters: actionsVersion only bumps when the injected
  // actions object identity changes (rare — GraphQLQueueProvider uses latestRef
  // pattern). dataVersion bumps on every data change (expected).
  const [actionsVersion, setActionsVersion] = useState(0);
  const [dataVersion, setDataVersion] = useState(0);

  const adapter = usePersistentSessionQueueAdapter();

  // eslint-disable-next-line react-hooks/exhaustive-deps -- actionsVersion/dataVersion force re-read of refs
  const effectiveContext = useMemo(
    () => (isInjected && injectedContextRef.current) ? injectedContextRef.current : adapter.context,
    [isInjected, actionsVersion, dataVersion, adapter.context],
  );

  // Actions: when injected, use the injected actions ref directly.
  // This does NOT depend on effectiveContext or dataVersion, so it stays
  // stable when only data changes (which is the common case).
  // eslint-disable-next-line react-hooks/exhaustive-deps -- actionsVersion forces re-read of ref
  const effectiveActions: GraphQLQueueActionsType = useMemo(() => {
    if (!isInjected) return adapter.actionsValue;
    return injectedActionsRef.current!;
  }, [isInjected, adapter.actionsValue, actionsVersion]);

  // Data: when injected, use the injected data ref directly.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- dataVersion forces re-read of ref
  const effectiveData: GraphQLQueueDataType = useMemo(() => {
    if (!isInjected) return adapter.dataValue;
    return injectedDataRef.current!;
  }, [isInjected, adapter.dataValue, dataVersion]);

  const effectiveBoardDetails = isInjected ? injectedBoardDetails : adapter.boardDetails;
  const effectiveAngle = isInjected ? injectedAngle : adapter.angle;
  const effectiveHasActiveQueue = isInjected
    ? true // If injected, a board route is active — always show bar
    : adapter.hasActiveQueue;

  const boardInfo = useMemo<QueueBridgeBoardInfo>(
    () => ({
      boardDetails: effectiveBoardDetails,
      angle: effectiveAngle,
      hasActiveQueue: effectiveHasActiveQueue,
    }),
    [effectiveBoardDetails, effectiveAngle, effectiveHasActiveQueue],
  );

  const inject = useCallback((
    ctx: GraphQLQueueContextType,
    actions: GraphQLQueueActionsType,
    data: GraphQLQueueDataType,
    bd: BoardDetails,
    a: Angle,
  ) => {
    injectedContextRef.current = ctx;
    injectedActionsRef.current = actions;
    injectedDataRef.current = data;
    setInjectedBoardDetails(bd);
    setInjectedAngle(a);
    setIsInjected(true);
    setActionsVersion(v => v + 1);
    setDataVersion(v => v + 1);
  }, []);

  const updateContext = useCallback((
    ctx: GraphQLQueueContextType,
    actions: GraphQLQueueActionsType,
    data: GraphQLQueueDataType,
  ) => {
    const actionsChanged = actions !== injectedActionsRef.current;
    injectedContextRef.current = ctx;
    injectedActionsRef.current = actions;
    injectedDataRef.current = data;
    // Always bump data version (data changes are expected and frequent)
    setDataVersion(v => v + 1);
    // Only bump actions version when the actions object identity actually changed.
    // GraphQLQueueProvider's actionsValue uses latestRef with empty deps, so this
    // almost never changes — keeping QueueActionsContext stable for consumers.
    if (actionsChanged) {
      setActionsVersion(v => v + 1);
    }
  }, []);

  const clear = useCallback(() => {
    injectedContextRef.current = null;
    injectedActionsRef.current = null;
    injectedDataRef.current = null;
    setIsInjected(false);
    setInjectedBoardDetails(null);
    setInjectedAngle(0);
    setActionsVersion(v => v + 1);
    setDataVersion(v => v + 1);
  }, []);

  const setters = useMemo<QueueBridgeSetters>(
    () => ({ inject, updateContext, clear }),
    [inject, updateContext, clear],
  );

  // Derive fine-grained context values from the effective data
  const effectiveCurrentClimb: CurrentClimbDataType = useMemo(() => ({
    currentClimbQueueItem: effectiveData.currentClimbQueueItem,
    currentClimb: effectiveData.currentClimb,
  }), [effectiveData.currentClimbQueueItem, effectiveData.currentClimb]);

  const effectiveQueueList: QueueListDataType = useMemo(() => ({
    queue: effectiveData.queue,
    suggestedClimbs: effectiveData.suggestedClimbs,
  }), [effectiveData.queue, effectiveData.suggestedClimbs]);

  const effectiveSearch: SearchDataType = useMemo(() => ({
    climbSearchParams: effectiveData.climbSearchParams,
    climbSearchResults: effectiveData.climbSearchResults,
    totalSearchResultCount: effectiveData.totalSearchResultCount,
    hasMoreResults: effectiveData.hasMoreResults,
    isFetchingClimbs: effectiveData.isFetchingClimbs,
    isFetchingNextPage: effectiveData.isFetchingNextPage,
    hasDoneFirstFetch: effectiveData.hasDoneFirstFetch,
    parsedParams: effectiveData.parsedParams,
  }), [
    effectiveData.climbSearchParams, effectiveData.climbSearchResults,
    effectiveData.totalSearchResultCount,
    effectiveData.hasMoreResults, effectiveData.isFetchingClimbs,
    effectiveData.isFetchingNextPage, effectiveData.hasDoneFirstFetch,
    effectiveData.parsedParams,
  ]);

  const effectiveSession: SessionDataType = useMemo(() => ({
    viewOnlyMode: effectiveData.viewOnlyMode,
    isSessionActive: effectiveData.isSessionActive,
    sessionId: effectiveData.sessionId,
    sessionSummary: effectiveData.sessionSummary,
    sessionGoal: effectiveData.sessionGoal,
    connectionState: effectiveData.connectionState,
    canMutate: effectiveData.canMutate,
    isDisconnected: effectiveData.isDisconnected,
    users: effectiveData.users ?? [],
    clientId: effectiveData.clientId ?? null,
    isLeader: effectiveData.isLeader ?? false,
    isBackendMode: effectiveData.isBackendMode ?? false,
    hasConnected: effectiveData.hasConnected ?? false,
    connectionError: effectiveData.connectionError ?? null,
  }), [
    effectiveData.viewOnlyMode, effectiveData.isSessionActive, effectiveData.sessionId,
    effectiveData.sessionSummary, effectiveData.sessionGoal, effectiveData.connectionState,
    effectiveData.canMutate, effectiveData.isDisconnected, effectiveData.users,
    effectiveData.clientId, effectiveData.isLeader, effectiveData.isBackendMode,
    effectiveData.hasConnected, effectiveData.connectionError,
  ]);

  return (
    <QueueBridgeSetterContext.Provider value={setters}>
      <QueueBridgeBoardInfoContext.Provider value={boardInfo}>
        <QueueActionsContext.Provider value={effectiveActions}>
          <QueueDataContext.Provider value={effectiveData}>
            <QueueContext.Provider value={effectiveContext}>
              <CurrentClimbContext.Provider value={effectiveCurrentClimb}>
                <QueueListContext.Provider value={effectiveQueueList}>
                  <SearchContext.Provider value={effectiveSearch}>
                    <SessionContext.Provider value={effectiveSession}>
                      {/* Sync queue state to iOS Live Activity (code-split, no-op on non-iOS) */}
                      <LiveActivityBridge
                        queue={adapter.context.queue}
                        currentClimbQueueItem={adapter.context.currentClimbQueueItem}
                        boardDetails={adapter.boardDetails}
                        sessionId={adapter.context.sessionId}
                        isSessionActive={adapter.context.isSessionActive}
                        onSetCurrentClimb={adapter.context.setCurrentClimbQueueItem}
                      />
                      {children}
                    </SessionContext.Provider>
                  </SearchContext.Provider>
                </QueueListContext.Provider>
              </CurrentClimbContext.Provider>
            </QueueContext.Provider>
          </QueueDataContext.Provider>
        </QueueActionsContext.Provider>
      </QueueBridgeBoardInfoContext.Provider>
    </QueueBridgeSetterContext.Provider>
  );
}

// -------------------------------------------------------------------
// QueueBridgeInjector — placed inside board route layouts
// -------------------------------------------------------------------

interface QueueBridgeInjectorProps {
  boardDetails: BoardDetails;
  angle: Angle;
}

export function QueueBridgeInjector({ boardDetails, angle }: QueueBridgeInjectorProps) {
  const { inject, updateContext, clear } = useContext(QueueBridgeSetterContext);

  // Read the board route's split contexts from GraphQLQueueProvider
  const queueContext = useContext(QueueContext);
  const queueActions = useContext(QueueActionsContext);
  const queueData = useContext(QueueDataContext);

  // Track whether we've done the initial injection
  const hasInjectedRef = useRef(false);

  // Initial injection: set board details + context on mount
  useLayoutEffect(() => {
    if (queueContext && queueActions && queueData) {
      inject(queueContext, queueActions, queueData, boardDetails, angle);
      hasInjectedRef.current = true;
    }
    // Only clean up on unmount (navigating away from board route)
    return () => {
      hasInjectedRef.current = false;
      clear();
    };
  // Only re-run when board details or angle change (navigation between boards)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardDetails, angle, inject, clear]);

  // Update the context ref whenever any of the queue context values change.
  // Also handles deferred injection if contexts were null during the useLayoutEffect.
  useEffect(() => {
    if (!queueContext || !queueActions || !queueData) return;
    if (hasInjectedRef.current) {
      updateContext(queueContext, queueActions, queueData);
    } else {
      inject(queueContext, queueActions, queueData, boardDetails, angle);
      hasInjectedRef.current = true;
    }
  }, [queueContext, queueActions, queueData, updateContext, inject, boardDetails, angle]);

  return null;
}
