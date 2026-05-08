'use client';

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useLayoutEffect,
  useRef,
  useEffect,
} from 'react';
import { v4 as uuidv4 } from 'uuid';
import {
  QueueContext,
  QueueActionsContext,
  QueueDataContext,
  CurrentClimbContext,
  CurrentClimbUuidContext,
  QueueListContext,
  SearchContext,
  SessionContext,
  type GraphQLQueueContextType,
  type GraphQLQueueActionsType,
  type GraphQLQueueDataType,
} from '../graphql-queue/QueueContext';
import type { CurrentClimbDataType, QueueListDataType, SearchDataType, SessionDataType } from '../graphql-queue/types';
import { usePersistentSession } from '../persistent-session';
import { usePartyProfile } from '../party-manager/party-profile-context';
import { getBaseBoardPath, DEFAULT_SEARCH_PARAMS } from '@/app/lib/url-utils';
import type { BoardDetails, Angle, Climb, SearchRequestPagination } from '@/app/lib/types';
import type { ClimbQueueItem, QueueItemUser, UserPick } from './types';
import { usePathname } from 'next/navigation';
import dynamic from 'next/dynamic';
import { canAddClimbToBoard } from '@/app/lib/board-compatibility';
import { getBoardDetailsForPlaylist } from '@/app/lib/board-config-for-playlist';
import { useSnackbar } from '../providers/snackbar-provider';
import { queueAddErrorMessage } from '../board-lock/queue-add-error-messages';
import { QueueBridgeBoardInfoContext, type QueueBridgeBoardInfo } from './queue-bridge-board-info-context';

const LiveActivityBridge = dynamic(() => import('@/app/lib/live-activity/live-activity-bridge'), {
  ssr: false,
});

/**
 * Derive BoardDetails + baseBoardPath from a climb's own boardType/layoutId.
 *
 * Used to seed `ps.localBoardDetails` when a user selects a climb from a
 * surface that has no active board context (e.g. a playlist view when the
 * user has never been on a board route). The resulting `baseBoardPath` must
 * match `getBaseBoardPath` output so queue restoration (`use-queue-restoration`)
 * and party-session transfer (`start-sesh-drawer`) keep working.
 */
function deriveSeedStateFromClimb(climb: Climb): { boardDetails: BoardDetails; baseBoardPath: string } | null {
  if (!climb.boardType || climb.layoutId == null) return null;
  const details = getBoardDetailsForPlaylist(climb.boardType, climb.layoutId);
  if (!details) return null;
  const setIds = details.set_ids.join(',');
  const baseBoardPath =
    details.board_name === 'moonboard'
      ? `/moonboard/${details.layout_id}/${setIds}`
      : `/${details.board_name}/${details.layout_id}/${details.size_id}/${setIds}`;
  return { boardDetails: details, baseBoardPath };
}

// -------------------------------------------------------------------
// Board info context (for the root-level bottom bar to know what board is active)
// Extracted to ./queue-bridge-board-info-context so consumers (e.g. board-lock
// hooks) can import it without forming an import cycle through this file.
// -------------------------------------------------------------------

export { useQueueBridgeBoardInfo } from './queue-bridge-board-info-context';

// -------------------------------------------------------------------
// Setter context (for the injector to push board-route context into the bridge)
// -------------------------------------------------------------------

type QueueBridgeSetters = {
  inject: (
    ctx: GraphQLQueueContextType,
    actions: GraphQLQueueActionsType,
    data: GraphQLQueueDataType,
    bd: BoardDetails,
    angle: Angle,
    baseBoardPath: string,
  ) => void;
  updateContext: (ctx: GraphQLQueueContextType, actions: GraphQLQueueActionsType, data: GraphQLQueueDataType) => void;
  clear: () => void;
};

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
  isHydrated: boolean;
  syncFromInjected: (q: ClimbQueueItem[], current: ClimbQueueItem | null, boardPath: string, bd: BoardDetails) => void;
} {
  const ps = usePersistentSession();
  const { showMessage } = useSnackbar();
  const { profile, username, avatarUrl } = usePartyProfile();

  // Mirror GraphQLQueueProvider's currentUserInfo so queue items created off
  // board routes carry the same "who added this" attribution.
  const currentUserInfo: QueueItemUser | undefined = useMemo(() => {
    if (!profile?.id) return undefined;
    return { id: profile.id, username: username || '', avatarUrl };
  }, [profile?.id, username, avatarUrl]);

  const isParty = !!ps.activeSession;
  const queue = isParty ? ps.queue : ps.localQueue;
  const currentClimbQueueItem = isParty ? ps.currentClimbQueueItem : ps.localCurrentClimbQueueItem;
  const [optimisticPicks, setOptimisticPicks] = useState<Record<string, UserPick>>({});
  const serverPicks = useMemo(
    () => Object.fromEntries((isParty ? ps.picks : []).map((pick) => [pick.userId, pick])),
    [isParty, ps.picks],
  );
  const picks = useMemo(
    () => (isParty ? { ...serverPicks, ...optimisticPicks } : {}),
    [isParty, optimisticPicks, serverPicks],
  );
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
  const latestRef = useRef({
    queue,
    currentClimbQueueItem,
    boardDetails,
    baseBoardPath,
    ps,
    showMessage,
    currentUserInfo,
  });
  latestRef.current = {
    queue,
    currentClimbQueueItem,
    boardDetails,
    baseBoardPath,
    ps,
    showMessage,
    currentUserInfo,
  };

  // Counter for correlation IDs sent with party-mode SET_CURRENT_CLIMB
  // mutations so the persistent session's pending-update tracker can
  // match local optimistic state with server confirmations.
  const correlationCounterRef = useRef(0);

  // Build a queue item from a climb, populating addedBy/addedByUser from the
  // current party profile so off-board mutations (logbook, session view)
  // carry the same attribution as items created from the board route.
  const buildQueueItem = useCallback((climb: Climb): ClimbQueueItem => {
    const { ps, currentUserInfo: user } = latestRef.current;
    return {
      climb,
      addedBy: ps.clientId ?? null,
      addedByUser: user,
      uuid: uuidv4(),
      suggested: false,
    };
  }, []);

  const applyOptimisticPick = useCallback((item: ClimbQueueItem) => {
    const { ps, currentUserInfo: user } = latestRef.current;
    const clientId = ps.clientId ?? null;
    const sessionUser = ps.users?.find(
      (candidate) => candidate.id === clientId || (!!user?.id && candidate.userId === user.id),
    );
    const userId = clientId ?? sessionUser?.userId ?? user?.id;
    if (!userId) return;

    setOptimisticPicks((prev) => ({
      ...prev,
      [userId]: {
        userId,
        item,
        updatedAt: new Date().toISOString(),
      },
    }));
  }, []);

  useEffect(() => {
    setOptimisticPicks((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const userId of Object.keys(prev)) {
        if (serverPicks[userId]) {
          delete next[userId];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [serverPicks]);

  // Validates a climb against the locked board (session) or the current
  // adapter board. Shows a Snackbar error and returns false if not
  // compatible. Message formatting lives in `queue-add-error-messages`
  // so the board-route and root-level entry points speak the same copy.
  const validateClimbForQueue = useCallback((climb: Climb): boolean => {
    const { ps, boardDetails, showMessage } = latestRef.current;
    const target = ps.activeSession?.boardDetails ?? boardDetails;
    if (!target) return true;
    const result = canAddClimbToBoard(climb, target);
    if (result.ok) return true;
    showMessage(queueAddErrorMessage(climb, target, result), 'error');
    return false;
  }, []);

  const getNextClimbQueueItem = useCallback((): ClimbQueueItem | null => {
    const { queue, currentClimbQueueItem: current } = latestRef.current;
    const idx = queue.findIndex(({ uuid }) => uuid === current?.uuid);
    return idx >= 0 && idx < queue.length - 1 ? queue[idx + 1] : null;
  }, []);

  const getPreviousClimbQueueItem = useCallback((): ClimbQueueItem | null => {
    const { queue, currentClimbQueueItem: current } = latestRef.current;
    const idx = queue.findIndex(({ uuid }) => uuid === current?.uuid);
    return idx > 0 ? queue[idx - 1] : null;
  }, []);

  const setCurrentClimbQueueItem = useCallback(
    (item: ClimbQueueItem) => {
      const { queue, currentClimbQueueItem: current, ps, boardDetails, baseBoardPath } = latestRef.current;
      const alreadyInQueue = queue.some((q) => q.uuid === item.uuid);
      if (ps.activeSession) {
        const correlationId = ps.clientId ? `${ps.clientId}-${++correlationCounterRef.current}` : undefined;
        applyOptimisticPick(item);
        ps.setMyPick(item, correlationId).catch((err: unknown) => {
          console.error('Failed to set my pick:', err);
        });
        return;
      }
      if (alreadyInQueue && current?.uuid === item.uuid) return;
      if (!boardDetails) return;
      const newQueue = alreadyInQueue ? queue : [...queue, item];
      ps.setLocalQueueState(newQueue, item, baseBoardPath, boardDetails);
    },
    [applyOptimisticPick],
  );

  const addToQueue = useCallback(
    (climb: Climb) => {
      const { queue, currentClimbQueueItem: current, ps, boardDetails, baseBoardPath } = latestRef.current;
      if (!validateClimbForQueue(climb)) return;
      const newItem = buildQueueItem(climb);
      if (ps.activeSession) {
        ps.addQueueItem(newItem).catch((err: unknown) => {
          console.error('Failed to add queue item:', err);
        });
        return;
      }
      if (!boardDetails) {
        // Cold-start path: no active board yet. Seed local state from the
        // climb's own board config so the queue bar begins showing.
        const seed = deriveSeedStateFromClimb(climb);
        if (!seed) return;
        ps.setLocalQueueState([newItem], newItem, seed.baseBoardPath, seed.boardDetails);
        return;
      }
      ps.setLocalQueueState([...queue, newItem], current ?? newItem, baseBoardPath, boardDetails);
    },
    [validateClimbForQueue, buildQueueItem],
  );

  const removeFromQueue = useCallback((item: ClimbQueueItem) => {
    const { queue, currentClimbQueueItem: current, ps, boardDetails, baseBoardPath } = latestRef.current;
    if (ps.activeSession) {
      ps.removeQueueItem(item.uuid).catch((err: unknown) => {
        console.error('Failed to remove queue item:', err);
      });
      return;
    }
    if (!boardDetails) return;
    const newQueue = queue.filter((q) => q.uuid !== item.uuid);
    const newCurrent = current?.uuid === item.uuid ? (newQueue[0] ?? null) : current;
    ps.setLocalQueueState(newQueue, newCurrent, baseBoardPath, boardDetails);
  }, []);

  const setQueue = useCallback((newQueue: ClimbQueueItem[]) => {
    const { currentClimbQueueItem: current, ps, boardDetails, baseBoardPath } = latestRef.current;
    // Pick the new current climb: keep the existing one if it survived the
    // queue update, otherwise fall back to the first item (or null when empty).
    const pickCurrent = (): ClimbQueueItem | null => {
      if (newQueue.length === 0) return null;
      if (current && newQueue.some((q) => q.uuid === current.uuid)) return current;
      return newQueue[0];
    };
    if (ps.activeSession) {
      ps.setQueue(newQueue, pickCurrent()).catch((err: unknown) => {
        console.error('Failed to set queue:', err);
      });
      return;
    }
    if (!boardDetails) return;
    ps.setLocalQueueState(newQueue, pickCurrent(), baseBoardPath, boardDetails);
  }, []);

  const mirrorClimb = useCallback(() => {
    const { queue, currentClimbQueueItem: current, ps, boardDetails, baseBoardPath } = latestRef.current;
    if (!current?.climb) return;
    const mirrored = !current.climb.mirrored;
    if (ps.activeSession) {
      ps.mirrorCurrentClimb(mirrored).catch((err: unknown) => {
        console.error('Failed to mirror current climb:', err);
      });
      return;
    }
    if (!boardDetails) return;
    const updatedItem: ClimbQueueItem = {
      ...current,
      climb: { ...current.climb, mirrored },
    };
    const newQueue = queue.map((q) => (q.uuid === updatedItem.uuid ? updatedItem : q));
    ps.setLocalQueueState(newQueue, updatedItem, baseBoardPath, boardDetails);
  }, []);

  const setCurrentClimb = useCallback(
    async (climb: Climb): Promise<ClimbQueueItem | null> => {
      const { queue, currentClimbQueueItem: current, ps, boardDetails, baseBoardPath } = latestRef.current;
      if (!validateClimbForQueue(climb)) return null;
      if (ps.activeSession) {
        const correlationId = ps.clientId ? `${ps.clientId}-${++correlationCounterRef.current}` : undefined;
        const existing = queue.find((q) => q.climb?.uuid === climb.uuid);
        const item = existing ?? buildQueueItem(climb);
        applyOptimisticPick(item);
        try {
          await ps.setMyPick(item, correlationId);
          return item;
        } catch (err: unknown) {
          console.error('Failed to set my pick:', err);
          return null;
        }
      }
      const newItem = buildQueueItem(climb);
      if (!boardDetails) {
        // Cold-start path: no active board yet. Seed local state from the
        // climb's own board config so the queue bar begins showing.
        const seed = deriveSeedStateFromClimb(climb);
        if (!seed) return null;
        ps.setLocalQueueState([newItem], newItem, seed.baseBoardPath, seed.boardDetails);
        return newItem;
      }
      const currentIdx = current ? queue.findIndex((q) => q.uuid === current.uuid) : -1;
      const newQueue = [...queue];
      if (currentIdx >= 0) {
        newQueue.splice(currentIdx + 1, 0, newItem);
      } else {
        newQueue.push(newItem);
      }
      ps.setLocalQueueState(newQueue, newItem, baseBoardPath, boardDetails);
      return newItem;
    },
    [applyOptimisticPick, validateClimbForQueue, buildQueueItem],
  );

  const setMyPickQueueItem = useCallback(
    async (item: ClimbQueueItem): Promise<void> => {
      const { ps, boardDetails, baseBoardPath, queue } = latestRef.current;
      if (ps.activeSession) {
        const correlationId = ps.clientId ? `${ps.clientId}-${++correlationCounterRef.current}` : undefined;
        applyOptimisticPick(item);
        await ps.setMyPick(item, correlationId);
        return;
      }
      if (!boardDetails) return;
      const alreadyInQueue = queue.some((q) => q.uuid === item.uuid);
      ps.setLocalQueueState(alreadyInQueue ? queue : [...queue, item], item, baseBoardPath, boardDetails);
    },
    [applyOptimisticPick],
  );

  const setMyPick = useCallback(
    async (climb: Climb): Promise<ClimbQueueItem | null> => {
      if (!validateClimbForQueue(climb)) return null;
      const { queue, ps } = latestRef.current;
      const item = queue.find((q) => q.climb?.uuid === climb.uuid) ?? buildQueueItem(climb);
      if (ps.activeSession) {
        try {
          const correlationId = ps.clientId ? `${ps.clientId}-${++correlationCounterRef.current}` : undefined;
          applyOptimisticPick(item);
          await ps.setMyPick(item, correlationId);
          return item;
        } catch (err: unknown) {
          console.error('Failed to set my pick:', err);
          return null;
        }
      }
      await setMyPickQueueItem(item);
      return item;
    },
    [applyOptimisticPick, buildQueueItem, setMyPickQueueItem, validateClimbForQueue],
  );

  const claimTurn = useCallback(async (): Promise<void> => {
    const { ps } = latestRef.current;
    if (!ps.activeSession) return;
    const correlationId = ps.clientId ? `${ps.clientId}-${++correlationCounterRef.current}` : undefined;
    await ps.claimTurn(correlationId);
  }, []);

  const yieldTurn = useCallback(async (toUserId: string): Promise<void> => {
    const { ps } = latestRef.current;
    if (!ps.activeSession) return;
    const correlationId = ps.clientId ? `${ps.clientId}-${++correlationCounterRef.current}` : undefined;
    await ps.yieldTurn(toUserId, correlationId);
  }, []);

  const clearMyPick = useCallback(async (): Promise<void> => {
    const { ps } = latestRef.current;
    if (!ps.activeSession) return;
    await ps.clearMyPick();
  }, []);

  // Bridge-mode replace: in party mode, delegate to the persistent session's
  // WebSocket-backed replaceQueueItem; otherwise mirror the local-state update
  // with a new climb while preserving the queue-item uuid and existing
  // addedBy attribution.
  const replaceQueueItem = useCallback((queueItemUuid: string, climb: Climb) => {
    const { queue, currentClimbQueueItem: current, ps, boardDetails, baseBoardPath } = latestRef.current;
    const existing = queue.find((q) => q.uuid === queueItemUuid);
    if (!existing) return;
    const updated: ClimbQueueItem = { ...existing, climb };
    if (ps.activeSession) {
      ps.replaceQueueItem(queueItemUuid, updated).catch((err: unknown) => {
        console.error('Failed to replace queue item:', err);
      });
      return;
    }
    if (!boardDetails) return;
    const newQueue = queue.map((q) => (q.uuid === queueItemUuid ? updated : q));
    const nextCurrent = current?.uuid === queueItemUuid ? updated : current;
    ps.setLocalQueueState(newQueue, nextCurrent, baseBoardPath, boardDetails);
  }, []);

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

  const reorderQueueItem = useCallback((uuid: string, oldIndex: number, newIndex: number) => {
    const { ps } = latestRef.current;
    if (!ps.activeSession) return;
    ps.reorderQueueItem(uuid, oldIndex, newIndex).catch((err: unknown) => {
      console.error('Failed to reorder queue item:', err);
    });
  }, []);

  // Actions value is now stable — all callbacks use latestRef with empty deps
  const actionsValue: GraphQLQueueActionsType = useMemo(
    () => ({
      addToQueue,
      removeFromQueue,
      setCurrentClimb,
      setMyPick,
      setMyPickQueueItem,
      claimTurn,
      yieldTurn,
      clearMyPick,
      setCurrentClimbQueueItem,
      replaceQueueItem,
      setClimbSearchParams: noopSetClimbSearchParams,
      setCountSearchParams: noopSetClimbSearchParams,
      mirrorClimb,
      fetchMoreClimbs: noop,
      getNextClimbQueueItem,
      getPreviousClimbQueueItem,
      setQueue,
      reorderQueueItem,
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
      setMyPick,
      setMyPickQueueItem,
      claimTurn,
      yieldTurn,
      clearMyPick,
      setCurrentClimbQueueItem,
      replaceQueueItem,
      noopSetClimbSearchParams,
      mirrorClimb,
      noop,
      getNextClimbQueueItem,
      getPreviousClimbQueueItem,
      setQueue,
      reorderQueueItem,
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
      picks,
      activeClimberUserId: isParty ? ps.activeClimberUserId : null,
      boardSends: isParty ? ps.boardSends : [],
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
      picks,
      parsedParams,
      isParty,
      ps.activeClimberUserId,
      ps.boardSends,
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

  // Sync injected queue state to local queue so the adapter has fresh data
  // when the bridge falls back from injected mode. Only effective in local
  // (non-party) mode — setLocalQueueState no-ops when a party session is active.
  const syncFromInjected = useCallback(
    (q: ClimbQueueItem[], current: ClimbQueueItem | null, boardPath: string, bd: BoardDetails) => {
      latestRef.current.ps.setLocalQueueState(q, current, boardPath, bd);
    },
    [],
  );

  return {
    context,
    actionsValue,
    dataValue,
    boardDetails,
    angle,
    hasActiveQueue,
    isHydrated: ps.isLocalQueueLoaded,
    syncFromInjected,
  };
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
  // Board state refs for reading during clear() — can't use state in stable callbacks
  const injectedBoardDetailsRef = useRef<BoardDetails | null>(null);
  const injectedBaseBoardPathRef = useRef<string>('');

  // Separate version counters: actionsVersion only bumps when the injected
  // actions object identity changes (rare — GraphQLQueueProvider uses latestRef
  // pattern). dataVersion bumps on every data change (expected).
  const [_actionsVersion, setActionsVersion] = useState(0);
  const [_dataVersion, setDataVersion] = useState(0);

  const adapter = usePersistentSessionQueueAdapter();

  // Ref for adapter sync function — keeps clear() deps empty
  const adapterSyncRef = useRef(adapter.syncFromInjected);
  adapterSyncRef.current = adapter.syncFromInjected;

  // Version counters are included in deps so useMemo re-reads the injected
  // refs on each updateContext() call. Without them the memo returns its
  // cached value from first injection (initial empty state), so consumers
  // never see queue updates that arrive after the board route mounts.
  const effectiveContext = useMemo(
    () => (isInjected && injectedContextRef.current ? injectedContextRef.current : adapter.context),
    [isInjected, adapter.context, _dataVersion, _actionsVersion],
  );

  const effectiveActions: GraphQLQueueActionsType = useMemo(() => {
    if (!isInjected) return adapter.actionsValue;
    return injectedActionsRef.current!;
  }, [isInjected, adapter.actionsValue, _actionsVersion]);

  const effectiveData: GraphQLQueueDataType = useMemo(() => {
    if (!isInjected) return adapter.dataValue;
    return injectedDataRef.current!;
  }, [isInjected, adapter.dataValue, _dataVersion]);

  const effectiveBoardDetails = isInjected ? injectedBoardDetails : adapter.boardDetails;
  const effectiveAngle = isInjected ? injectedAngle : adapter.angle;
  const effectiveHasActiveQueue = isInjected
    ? true // If injected, a board route is active — always show bar
    : adapter.hasActiveQueue;
  // When a board route injector is active we already know board state
  // synchronously; otherwise mirror the persistent session's restore flag.
  const effectiveIsHydrated = isInjected ? true : adapter.isHydrated;

  const boardInfo = useMemo<QueueBridgeBoardInfo>(
    () => ({
      boardDetails: effectiveBoardDetails,
      angle: effectiveAngle,
      hasActiveQueue: effectiveHasActiveQueue,
      isHydrated: effectiveIsHydrated,
    }),
    [effectiveBoardDetails, effectiveAngle, effectiveHasActiveQueue, effectiveIsHydrated],
  );

  const inject = useCallback(
    (
      ctx: GraphQLQueueContextType,
      actions: GraphQLQueueActionsType,
      data: GraphQLQueueDataType,
      bd: BoardDetails,
      a: Angle,
      baseBoardPath: string,
    ) => {
      injectedContextRef.current = ctx;
      injectedActionsRef.current = actions;
      injectedDataRef.current = data;
      injectedBoardDetailsRef.current = bd;
      injectedBaseBoardPathRef.current = baseBoardPath;
      setInjectedBoardDetails(bd);
      setInjectedAngle(a);
      setIsInjected(true);
      setActionsVersion((v) => v + 1);
      setDataVersion((v) => v + 1);
    },
    [],
  );

  const updateContext = useCallback(
    (ctx: GraphQLQueueContextType, actions: GraphQLQueueActionsType, data: GraphQLQueueDataType) => {
      const actionsChanged = actions !== injectedActionsRef.current;
      const dataChanged = data !== injectedDataRef.current;
      injectedContextRef.current = ctx;
      injectedActionsRef.current = actions;
      injectedDataRef.current = data;
      // Only bump data version when the injected data reference actually changed.
      // Prevents cascading re-renders when updateContext is called with the same
      // data (e.g. during session stats updates that don't change queue data).
      if (dataChanged) {
        setDataVersion((v) => v + 1);
      }
      // Only bump actions version when the actions object identity actually changed.
      // GraphQLQueueProvider's actionsValue uses latestRef with empty deps, so this
      // almost never changes — keeping QueueActionsContext stable for consumers.
      if (actionsChanged) {
        setActionsVersion((v) => v + 1);
      }
    },
    [],
  );

  const clear = useCallback(() => {
    // Before clearing: sync the last injected queue state to the persistent
    // session's local queue so the adapter has up-to-date data when it takes
    // over. In party mode this is a no-op (setLocalQueueState guards on
    // activeSession).
    const lastData = injectedDataRef.current;
    const bd = injectedBoardDetailsRef.current;
    const bbp = injectedBaseBoardPathRef.current;
    if (lastData && bd && bbp) {
      adapterSyncRef.current(lastData.queue, lastData.currentClimbQueueItem, bbp, bd);
    }

    injectedContextRef.current = null;
    injectedActionsRef.current = null;
    injectedDataRef.current = null;
    injectedBoardDetailsRef.current = null;
    injectedBaseBoardPathRef.current = '';
    setIsInjected(false);
    setInjectedBoardDetails(null);
    setInjectedAngle(0);
    setActionsVersion((v) => v + 1);
    setDataVersion((v) => v + 1);
  }, []);

  const setters = useMemo<QueueBridgeSetters>(() => ({ inject, updateContext, clear }), [inject, updateContext, clear]);

  // Derive fine-grained context values from the effective data
  const effectiveCurrentClimb: CurrentClimbDataType = useMemo(
    () => ({
      currentClimbQueueItem: effectiveData.currentClimbQueueItem,
      currentClimb: effectiveData.currentClimb,
    }),
    [effectiveData.currentClimbQueueItem, effectiveData.currentClimb],
  );
  const effectiveCurrentClimbUuid = effectiveData.currentClimbQueueItem?.uuid ?? null;

  const effectiveQueueList: QueueListDataType = useMemo(
    () => ({
      queue: effectiveData.queue,
      suggestedClimbs: effectiveData.suggestedClimbs,
    }),
    [effectiveData.queue, effectiveData.suggestedClimbs],
  );

  const effectiveSearch: SearchDataType = useMemo(
    () => ({
      climbSearchParams: effectiveData.climbSearchParams,
      climbSearchResults: effectiveData.climbSearchResults,
      totalSearchResultCount: effectiveData.totalSearchResultCount,
      hasMoreResults: effectiveData.hasMoreResults,
      isFetchingClimbs: effectiveData.isFetchingClimbs,
      isFetchingNextPage: effectiveData.isFetchingNextPage,
      hasDoneFirstFetch: effectiveData.hasDoneFirstFetch,
      parsedParams: effectiveData.parsedParams,
    }),
    [
      effectiveData.climbSearchParams,
      effectiveData.climbSearchResults,
      effectiveData.totalSearchResultCount,
      effectiveData.hasMoreResults,
      effectiveData.isFetchingClimbs,
      effectiveData.isFetchingNextPage,
      effectiveData.hasDoneFirstFetch,
      effectiveData.parsedParams,
    ],
  );

  const effectiveSession: SessionDataType = useMemo(
    () => ({
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
    }),
    [
      effectiveData.viewOnlyMode,
      effectiveData.isSessionActive,
      effectiveData.sessionId,
      effectiveData.sessionSummary,
      effectiveData.sessionGoal,
      effectiveData.connectionState,
      effectiveData.canMutate,
      effectiveData.isDisconnected,
      effectiveData.users,
      effectiveData.clientId,
      effectiveData.isLeader,
      effectiveData.isBackendMode,
      effectiveData.hasConnected,
      effectiveData.connectionError,
    ],
  );

  // Renamed locals so jsx-handler-names sees on*-prefixed identifiers being
  // passed to the on*-prefixed props on LiveActivityBridge below.
  // Use effectiveActions.setCurrentClimbQueueItem so widget taps route through
  // the injected GraphQLQueueProvider when on a board route. The adapter's
  // version writes to local state (no-op in party mode) and would silently
  // drop widget navigation during an active sesh.
  const onSetCurrentClimb = effectiveActions.setCurrentClimbQueueItem;
  const onWidgetNavigate = effectiveActions.dispatchWidgetNavigation;

  return (
    <QueueBridgeSetterContext.Provider value={setters}>
      <QueueBridgeBoardInfoContext.Provider value={boardInfo}>
        <QueueActionsContext.Provider value={effectiveActions}>
          <QueueDataContext.Provider value={effectiveData}>
            <QueueContext.Provider value={effectiveContext}>
              <CurrentClimbContext.Provider value={effectiveCurrentClimb}>
                <CurrentClimbUuidContext.Provider value={effectiveCurrentClimbUuid}>
                  <QueueListContext.Provider value={effectiveQueueList}>
                    <SearchContext.Provider value={effectiveSearch}>
                      <SessionContext.Provider value={effectiveSession}>
                        {/* Sync queue state to iOS Live Activity (code-split, no-op on non-iOS).
                            Use effectiveData/effectiveBoardDetails so the Live Activity reflects
                            the live party queue while on a board route (injected mode), not the
                            adapter's local view (which is a no-op in party mode). */}
                        <LiveActivityBridge
                          queue={effectiveData.queue}
                          currentClimbQueueItem={effectiveData.currentClimbQueueItem}
                          boardDetails={effectiveBoardDetails}
                          sessionId={effectiveData.sessionId}
                          isSessionActive={effectiveData.isSessionActive}
                          onSetCurrentClimb={onSetCurrentClimb}
                          onWidgetNavigate={onWidgetNavigate}
                        />
                        {children}
                      </SessionContext.Provider>
                    </SearchContext.Provider>
                  </QueueListContext.Provider>
                </CurrentClimbUuidContext.Provider>
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

type QueueBridgeInjectorProps = {
  boardDetails: BoardDetails;
  angle: Angle;
};

export function QueueBridgeInjector({ boardDetails, angle }: QueueBridgeInjectorProps) {
  const { inject, updateContext, clear } = useContext(QueueBridgeSetterContext);
  const pathname = usePathname();
  const baseBoardPath = useMemo(() => getBaseBoardPath(pathname), [pathname]);

  // Read the board route's split contexts from GraphQLQueueProvider
  const queueContext = useContext(QueueContext);
  const queueActions = useContext(QueueActionsContext);
  const queueData = useContext(QueueDataContext);

  // Track whether we've done the initial injection
  const hasInjectedRef = useRef(false);

  // Keep latest base board path in a ref so mount/unmount cleanup can read it
  // without forcing the setup/cleanup effect to rerun on pathname changes.
  const baseBoardPathRef = useRef(baseBoardPath);
  baseBoardPathRef.current = baseBoardPath;

  // Initial injection: set board details + context on mount
  useLayoutEffect(() => {
    if (queueContext && queueActions && queueData) {
      inject(queueContext, queueActions, queueData, boardDetails, angle, baseBoardPathRef.current);
      hasInjectedRef.current = true;
    }
    // Only clean up on unmount (navigating away from board route)
    return () => {
      hasInjectedRef.current = false;
      clear();
    };
    // Only re-run when board details or angle change (navigation between boards)
    // and not when pathname changes during transition off the board route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardDetails, angle, inject, clear]);

  // Update the context ref whenever any of the queue context values change.
  // Also handles deferred injection if contexts were null during the useLayoutEffect.
  useEffect(() => {
    if (!queueContext || !queueActions || !queueData) return;
    if (hasInjectedRef.current) {
      updateContext(queueContext, queueActions, queueData);
    } else {
      inject(queueContext, queueActions, queueData, boardDetails, angle, baseBoardPath);
      hasInjectedRef.current = true;
    }
  }, [queueContext, queueActions, queueData, updateContext, inject, boardDetails, angle, baseBoardPath]);

  return null;
}
