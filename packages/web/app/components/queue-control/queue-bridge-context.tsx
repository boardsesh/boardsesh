'use client';

import React, { createContext, useContext, useState, useCallback, useMemo, useLayoutEffect, useRef, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { QueueContext, type GraphQLQueueContextType } from '../graphql-queue/QueueContext';
import { usePersistentSession } from '../persistent-session';
import { getBaseBoardPath } from '@/app/lib/url-utils';
import { DEFAULT_SEARCH_PARAMS } from '@/app/lib/url-utils';
import type { BoardDetails, Angle, Climb, SearchRequestPagination } from '@/app/lib/types';
import type { ClimbQueueItem } from './types';

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
  inject: (ctx: GraphQLQueueContextType, bd: BoardDetails, angle: Angle) => void;
  updateContext: (ctx: GraphQLQueueContextType) => void;
  clear: () => void;
}

const QueueBridgeSetterContext = createContext<QueueBridgeSetters>({
  inject: () => {},
  updateContext: () => {},
  clear: () => {},
});

// -------------------------------------------------------------------
// usePersistentSessionQueueAdapter — thin adapter over PersistentSession
// -------------------------------------------------------------------

function usePersistentSessionQueueAdapter(): {
  context: GraphQLQueueContextType;
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
      // Fallback — should not be consumed when hasActiveQueue is false
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

  const getNextClimbQueueItem = useCallback((): ClimbQueueItem | null => {
    const idx = queue.findIndex(({ uuid }) => uuid === currentClimbQueueItem?.uuid);
    return idx >= 0 && idx < queue.length - 1 ? queue[idx + 1] : null;
  }, [queue, currentClimbQueueItem]);

  const getPreviousClimbQueueItem = useCallback((): ClimbQueueItem | null => {
    const idx = queue.findIndex(({ uuid }) => uuid === currentClimbQueueItem?.uuid);
    return idx > 0 ? queue[idx - 1] : null;
  }, [queue, currentClimbQueueItem]);

  const setCurrentClimbQueueItem = useCallback(
    (item: ClimbQueueItem) => {
      if (!boardDetails) return;
      const alreadyInQueue = queue.some(q => q.uuid === item.uuid);
      // Skip if item is already current and already in the queue — nothing changed
      if (alreadyInQueue && currentClimbQueueItem?.uuid === item.uuid) return;
      const newQueue = alreadyInQueue ? queue : [...queue, item];
      ps.setLocalQueueState(newQueue, item, baseBoardPath, boardDetails);
    },
    [queue, currentClimbQueueItem, boardDetails, baseBoardPath, ps],
  );

  const addToQueue = useCallback(
    (climb: Climb) => {
      if (!boardDetails) return;
      const newItem: ClimbQueueItem = {
        climb,
        addedBy: null,
        uuid: uuidv4(),
        suggested: false,
      };
      const newQueue = [...queue, newItem];
      const current = currentClimbQueueItem ?? newItem;
      ps.setLocalQueueState(newQueue, current, baseBoardPath, boardDetails);
    },
    [queue, currentClimbQueueItem, boardDetails, baseBoardPath, ps],
  );

  const removeFromQueue = useCallback(
    (item: ClimbQueueItem) => {
      if (!boardDetails) return;
      const newQueue = queue.filter(q => q.uuid !== item.uuid);
      const newCurrent = currentClimbQueueItem?.uuid === item.uuid
        ? (newQueue[0] ?? null)
        : currentClimbQueueItem;
      ps.setLocalQueueState(newQueue, newCurrent, baseBoardPath, boardDetails);
    },
    [queue, currentClimbQueueItem, boardDetails, baseBoardPath, ps],
  );

  const setQueue = useCallback(
    (newQueue: ClimbQueueItem[]) => {
      if (!boardDetails) return;
      const newCurrent = newQueue.length === 0
        ? null
        : (currentClimbQueueItem && newQueue.some(q => q.uuid === currentClimbQueueItem.uuid)
            ? currentClimbQueueItem
            : newQueue[0]);
      ps.setLocalQueueState(newQueue, newCurrent, baseBoardPath, boardDetails);
    },
    [currentClimbQueueItem, boardDetails, baseBoardPath, ps],
  );

  const mirrorClimb = useCallback(() => {
    if (!currentClimbQueueItem?.climb || !boardDetails) return;
    const mirrored = !currentClimbQueueItem.climb.mirrored;
    const updatedItem: ClimbQueueItem = {
      ...currentClimbQueueItem,
      climb: { ...currentClimbQueueItem.climb, mirrored },
    };
    const newQueue = queue.map(q => (q.uuid === updatedItem.uuid ? updatedItem : q));
    ps.setLocalQueueState(newQueue, updatedItem, baseBoardPath, boardDetails);
  }, [currentClimbQueueItem, queue, boardDetails, baseBoardPath, ps]);

  const setCurrentClimb = useCallback(
    (climb: Climb) => {
      if (!boardDetails) return;
      const newItem: ClimbQueueItem = {
        climb,
        addedBy: null,
        uuid: uuidv4(),
        suggested: false,
      };
      // Insert after current in queue
      const currentIdx = currentClimbQueueItem
        ? queue.findIndex(q => q.uuid === currentClimbQueueItem.uuid)
        : -1;
      const newQueue = [...queue];
      if (currentIdx >= 0) {
        newQueue.splice(currentIdx + 1, 0, newItem);
      } else {
        newQueue.push(newItem);
      }
      ps.setLocalQueueState(newQueue, newItem, baseBoardPath, boardDetails);
    },
    [queue, currentClimbQueueItem, boardDetails, baseBoardPath, ps],
  );

  // No-op functions for fields not used by the bottom bar — each matches its exact type signature
  const noop = useCallback(() => {}, []);
  const noopStartSession = useCallback(
    async (_options?: { discoverable?: boolean; name?: string; sessionId?: string }) => '',
    [],
  );
  const noopJoinSession = useCallback(async (_sessionId: string) => {}, []);
  const noopSetClimbSearchParams = useCallback((_params: SearchRequestPagination) => {}, []);

  const context: GraphQLQueueContextType = useMemo(
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

      // Session management
      isSessionActive: isParty && ps.hasConnected,
      sessionId: ps.activeSession?.sessionId ?? null,
      startSession: noopStartSession,
      joinSession: noopJoinSession,
      endSession: ps.deactivateSession,
      sessionSummary: null,
      dismissSessionSummary: noop,
      sessionGoal: ps.session?.goal ?? null,

      // Session data
      users: isParty ? ps.users : [],
      clientId: ps.clientId,
      isLeader: ps.isLeader,
      isBackendMode: true,
      hasConnected: ps.hasConnected,
      connectionError: ps.error,
      disconnect: ps.deactivateSession,

      // Actions
      addToQueue,
      removeFromQueue,
      setCurrentClimb,
      setCurrentClimbQueueItem,
      setClimbSearchParams: noopSetClimbSearchParams,
      setCountSearchParams: noopSetClimbSearchParams,
      mirrorClimb,
      isDisconnected: false,
      fetchMoreClimbs: noop,
      getNextClimbQueueItem,
      getPreviousClimbQueueItem,
      setQueue,
    }),
    [
      queue,
      currentClimbQueueItem,
      parsedParams,
      isParty,
      ps.hasConnected,
      ps.activeSession?.sessionId,
      ps.deactivateSession,
      ps.session?.goal,
      ps.users,
      ps.clientId,
      ps.isLeader,
      ps.error,
      noopStartSession,
      noopJoinSession,
      noopSetClimbSearchParams,
      noop,
      addToQueue,
      removeFromQueue,
      setCurrentClimb,
      setCurrentClimbQueueItem,
      mirrorClimb,
      getNextClimbQueueItem,
      getPreviousClimbQueueItem,
      setQueue,
    ],
  );

  return { context, boardDetails, angle, hasActiveQueue };
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
  // The queue context value is stored in a ref to avoid cleanup/setup cycles
  // on every context update. The ref is read synchronously during render.
  const injectedContextRef = useRef<GraphQLQueueContextType | null>(null);
  // Counter to force re-renders when the injected context ref changes
  const [contextVersion, setContextVersion] = useState(0);

  const adapter = usePersistentSessionQueueAdapter();

  // When a board route is active (isInjected), use the injected context.
  // Otherwise, fall back to the PersistentSession adapter.
  //
  // Why ref + version counter instead of useState? Storing the full context object
  // in state would trigger React's cleanup/setup cycle on every context update,
  // causing the bottom bar to briefly unmount and remount (visible flash). By
  // keeping the value in a ref and bumping a version counter, we get a re-render
  // that reads the latest ref value without the cleanup/setup cost.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- contextVersion forces re-read of ref
  const effectiveContext = useMemo(
    () => (isInjected && injectedContextRef.current) ? injectedContextRef.current : adapter.context,
    [isInjected, contextVersion, adapter.context],
  );
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

  const inject = useCallback((ctx: GraphQLQueueContextType, bd: BoardDetails, a: Angle) => {
    injectedContextRef.current = ctx;
    setInjectedBoardDetails(bd);
    setInjectedAngle(a);
    setIsInjected(true);
    setContextVersion(v => v + 1);
  }, []);

  const updateContext = useCallback((ctx: GraphQLQueueContextType) => {
    injectedContextRef.current = ctx;
    setContextVersion(v => v + 1);
  }, []);

  const clear = useCallback(() => {
    injectedContextRef.current = null;
    setIsInjected(false);
    setInjectedBoardDetails(null);
    setInjectedAngle(0);
    setContextVersion(v => v + 1);
  }, []);

  const setters = useMemo<QueueBridgeSetters>(
    () => ({ inject, updateContext, clear }),
    [inject, updateContext, clear],
  );

  return (
    <QueueBridgeSetterContext.Provider value={setters}>
      <QueueBridgeBoardInfoContext.Provider value={boardInfo}>
        <QueueContext.Provider value={effectiveContext}>
          {children}
        </QueueContext.Provider>
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

  // Read the board route's QueueContext (from GraphQLQueueProvider which is a parent)
  const queueContext = useContext(QueueContext);

  // Track whether we've done the initial injection
  const hasInjectedRef = useRef(false);

  // Initial injection: set board details + context on mount
  useLayoutEffect(() => {
    if (queueContext) {
      inject(queueContext, boardDetails, angle);
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

  // Update the context ref whenever the queue context value changes.
  // Also handles deferred injection if queueContext was null during the useLayoutEffect.
  useEffect(() => {
    if (!queueContext) return;
    if (hasInjectedRef.current) {
      updateContext(queueContext);
    } else {
      inject(queueContext, boardDetails, angle);
      hasInjectedRef.current = true;
    }
  }, [queueContext, updateContext, inject, boardDetails, angle]);

  return null;
}
