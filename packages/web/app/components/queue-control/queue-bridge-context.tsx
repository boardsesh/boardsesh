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
import { getBaseBoardPath } from '@/app/lib/url-utils';
import { DEFAULT_SEARCH_PARAMS } from '@/app/lib/url-utils';
import type { BoardDetails, Angle, Climb, SearchRequestPagination } from '@/app/lib/types';
import type { ClimbQueueItem } from './types';
import { usePathname } from 'next/navigation';
import dynamic from 'next/dynamic';
import { getBoardDetailsForPlaylist, getDefaultAngleForBoard } from '@/app/lib/board-config-for-playlist';
import { boardConfigFromDetails, boardConfigToBaseBoardPath } from '@/app/lib/board-config';
import type { BoardConfig } from '@boardsesh/shared-schema';
import { useSnackbar } from '../providers/snackbar-provider';
import { useQueueAddConfirm, type AddOutcome } from './queue-add-confirm-context';
import { useRouter } from 'next/navigation';

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
function deriveSeedStateFromClimb(
  climb: Climb,
): { boardDetails: BoardDetails; baseBoardPath: string; boardConfig: BoardConfig } | null {
  if (!climb.boardType || climb.layoutId == null) return null;
  const details = getBoardDetailsForPlaylist(climb.boardType, climb.layoutId);
  if (!details) return null;
  const setIds = details.set_ids.join(',');
  const baseBoardPath =
    details.board_name === 'moonboard'
      ? `/moonboard/${details.layout_id}/${setIds}`
      : `/${details.board_name}/${details.layout_id}/${details.size_id}/${setIds}`;
  const seedAngle = climb.angle ?? getDefaultAngleForBoard(details.board_name);
  const boardConfig = boardConfigFromDetails(details, seedAngle);
  return { boardDetails: details, baseBoardPath, boardConfig };
}

// -------------------------------------------------------------------
// Board info context (for the root-level bottom bar to know what board is active)
// -------------------------------------------------------------------

interface QueueBridgeBoardInfo {
  boardDetails: BoardDetails | null;
  angle: Angle;
  hasActiveQueue: boolean;
  /**
   * True once the persistent session has finished restoring from IndexedDB
   * (or immediately when a board-route injector is active). Consumers that
   * want to read `hasActiveQueue`/`boardDetails` on mount must wait for this
   * flag — otherwise they race the async restore and see stale defaults.
   */
  isHydrated: boolean;
}

const QueueBridgeBoardInfoContext = createContext<QueueBridgeBoardInfo>({
  boardDetails: null,
  angle: 0,
  hasActiveQueue: false,
  isHydrated: false,
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
    baseBoardPath: string,
  ) => void;
  updateContext: (ctx: GraphQLQueueContextType, actions: GraphQLQueueActionsType, data: GraphQLQueueDataType) => void;
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
  isHydrated: boolean;
  syncFromInjected: (q: ClimbQueueItem[], current: ClimbQueueItem | null, boardPath: string, bd: BoardDetails) => void;
} {
  const ps = usePersistentSession();
  const { showMessage } = useSnackbar();
  const confirmApi = useQueueAddConfirm();
  const router = useRouter();

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
  const latestRef = useRef({
    queue,
    currentClimbQueueItem,
    boardDetails,
    baseBoardPath,
    ps,
    showMessage,
    confirmApi,
    router,
  });
  latestRef.current = {
    queue,
    currentClimbQueueItem,
    boardDetails,
    baseBoardPath,
    ps,
    showMessage,
    confirmApi,
    router,
  };

  // Placeholder kept for the `addToQueue` / `setCurrentClimb` signatures.
  // Cross-board / cross-layout rejection moved to the `QueueAddConfirmProvider`
  // gate, which surfaces a confirmation dialog instead of silently rejecting.
  // The imports for `canAddClimbToBoard` / `queueAddErrorMessage` are retained
  // because they're still referenced elsewhere in this file.
  const validateClimbForQueue = useCallback((_climb: Climb): boolean => true, []);

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

  const setCurrentClimbQueueItem = useCallback((item: ClimbQueueItem) => {
    const r = latestRef.current;
    if (!r.boardDetails) return;
    const alreadyInQueue = r.queue.some((q) => q.uuid === item.uuid);
    if (alreadyInQueue && r.currentClimbQueueItem?.uuid === item.uuid) return;
    const newQueue = alreadyInQueue ? r.queue : [...r.queue, item];
    r.ps.setLocalQueueState(newQueue, item, r.baseBoardPath, r.boardDetails);
  }, []);

  const addToQueue = useCallback(
    (climb: Climb) => {
      const r = latestRef.current;
      if (!validateClimbForQueue(climb)) return;
      if (!r.boardDetails) {
        // Cold-start path: no active board yet. Seed local state from the
        // climb's own board config so the queue bar begins showing.
        const seed = deriveSeedStateFromClimb(climb);
        if (!seed) return;
        const newItem: ClimbQueueItem = {
          climb: {
            ...climb,
            boardType: climb.boardType ?? seed.boardConfig.boardName,
            layoutId: climb.layoutId ?? seed.boardConfig.layoutId,
          },
          addedBy: null,
          uuid: uuidv4(),
          suggested: false,
          boardConfig: seed.boardConfig,
          boardId: null,
        };
        r.ps.setLocalQueueState([newItem], newItem, seed.baseBoardPath, seed.boardDetails);
        return;
      }
      const boardConfig = boardConfigFromDetails(
        r.boardDetails,
        r.currentClimbQueueItem?.climb?.angle ?? climb.angle ?? 0,
      );
      const newItem: ClimbQueueItem = {
        climb: {
          ...climb,
          boardType: climb.boardType ?? boardConfig.boardName,
          layoutId: climb.layoutId ?? boardConfig.layoutId,
        },
        addedBy: null,
        uuid: uuidv4(),
        suggested: false,
        boardConfig,
        boardId: null,
      };

      // Fire-and-forget gate: shows a confirmation dialog only if the incoming
      // config doesn't already match one of the accepted configs in the queue.
      (async () => {
        let outcome: AddOutcome = 'allow';
        if (r.confirmApi) {
          outcome = await r.confirmApi.gate(boardConfig, r.queue);
        }
        if (outcome === 'cancel') return;
        if (outcome === 'switch') {
          if (!r.boardDetails) return;
          r.ps.setLocalQueueState([newItem], newItem, r.baseBoardPath, r.boardDetails);
          try {
            r.router.push(`${boardConfigToBaseBoardPath(boardConfig)}/${boardConfig.angle}/list`);
          } catch {
            // Router unavailable — best-effort navigation.
          }
          return;
        }
        // 'allow' or 'add' — proceed with a normal append.
        if (!r.boardDetails) return;
        const newQueue = [...r.queue, newItem];
        const current = r.currentClimbQueueItem ?? newItem;
        r.ps.setLocalQueueState(newQueue, current, r.baseBoardPath, r.boardDetails);
      })();
    },
    [validateClimbForQueue],
  );

  const removeFromQueue = useCallback((item: ClimbQueueItem) => {
    const r = latestRef.current;
    if (!r.boardDetails) return;
    const newQueue = r.queue.filter((q) => q.uuid !== item.uuid);
    const newCurrent = r.currentClimbQueueItem?.uuid === item.uuid ? (newQueue[0] ?? null) : r.currentClimbQueueItem;
    r.ps.setLocalQueueState(newQueue, newCurrent, r.baseBoardPath, r.boardDetails);
  }, []);

  const setQueue = useCallback((newQueue: ClimbQueueItem[]) => {
    const r = latestRef.current;
    if (!r.boardDetails) return;
    const newCurrent =
      newQueue.length === 0
        ? null
        : r.currentClimbQueueItem && newQueue.some((q) => q.uuid === r.currentClimbQueueItem!.uuid)
          ? r.currentClimbQueueItem
          : newQueue[0];
    r.ps.setLocalQueueState(newQueue, newCurrent, r.baseBoardPath, r.boardDetails);
  }, []);

  const mirrorClimb = useCallback(() => {
    const r = latestRef.current;
    if (!r.currentClimbQueueItem?.climb || !r.boardDetails) return;
    const mirrored = !r.currentClimbQueueItem.climb.mirrored;
    const updatedItem: ClimbQueueItem = {
      ...r.currentClimbQueueItem,
      climb: { ...r.currentClimbQueueItem.climb, mirrored },
    };
    const newQueue = r.queue.map((q) => (q.uuid === updatedItem.uuid ? updatedItem : q));
    r.ps.setLocalQueueState(newQueue, updatedItem, r.baseBoardPath, r.boardDetails);
  }, []);

  const setCurrentClimb = useCallback(
    async (climb: Climb): Promise<ClimbQueueItem | null> => {
      const r = latestRef.current;
      if (!validateClimbForQueue(climb)) return null;
      if (!r.boardDetails) {
        // Cold-start path: no active board yet. Seed local state from the
        // climb's own board config so the queue bar begins showing.
        const seed = deriveSeedStateFromClimb(climb);
        if (!seed) return null;
        const newItem: ClimbQueueItem = {
          climb: {
            ...climb,
            boardType: climb.boardType ?? seed.boardConfig.boardName,
            layoutId: climb.layoutId ?? seed.boardConfig.layoutId,
          },
          addedBy: null,
          uuid: uuidv4(),
          suggested: false,
          boardConfig: seed.boardConfig,
          boardId: null,
        };
        r.ps.setLocalQueueState([newItem], newItem, seed.baseBoardPath, seed.boardDetails);
        return newItem;
      }
      const boardConfig = boardConfigFromDetails(
        r.boardDetails,
        r.currentClimbQueueItem?.climb?.angle ?? climb.angle ?? 0,
      );

      // Gate up front so no optimistic flash if the user ultimately cancels.
      let outcome: AddOutcome = 'allow';
      if (r.confirmApi) {
        outcome = await r.confirmApi.gate(boardConfig, r.queue);
      }
      if (outcome === 'cancel') return null;

      const newItem: ClimbQueueItem = {
        climb: {
          ...climb,
          boardType: climb.boardType ?? boardConfig.boardName,
          layoutId: climb.layoutId ?? boardConfig.layoutId,
        },
        addedBy: null,
        uuid: uuidv4(),
        suggested: false,
        boardConfig,
        boardId: null,
      };

      if (outcome === 'switch') {
        if (!r.boardDetails) return newItem;
        r.ps.setLocalQueueState([newItem], newItem, r.baseBoardPath, r.boardDetails);
        try {
          r.router.push(`${boardConfigToBaseBoardPath(boardConfig)}/${boardConfig.angle}/list`);
        } catch {
          // Router unavailable — best-effort navigation.
        }
        return newItem;
      }

      const currentIdx = r.currentClimbQueueItem
        ? r.queue.findIndex((q) => q.uuid === r.currentClimbQueueItem!.uuid)
        : -1;
      const newQueue = [...r.queue];
      if (currentIdx >= 0) {
        newQueue.splice(currentIdx + 1, 0, newItem);
      } else {
        newQueue.push(newItem);
      }
      r.ps.setLocalQueueState(newQueue, newItem, r.baseBoardPath, r.boardDetails);
      return newItem;
    },
    [validateClimbForQueue],
  );

  // Bridge-mode replace: mirrors the local-state update with a new climb while
  // preserving the queue-item uuid and existing addedBy attribution. The
  // bridge context has no network path, so this is a pure local mutation.
  const replaceQueueItem = useCallback((queueItemUuid: string, climb: Climb) => {
    const r = latestRef.current;
    if (!r.boardDetails) return;
    const existing = r.queue.find((q) => q.uuid === queueItemUuid);
    if (!existing) return;
    const updated: ClimbQueueItem = {
      ...existing,
      climb,
    };
    const newQueue = r.queue.map((q) => (q.uuid === queueItemUuid ? updated : q));
    const nextCurrent = r.currentClimbQueueItem?.uuid === queueItemUuid ? updated : r.currentClimbQueueItem;
    r.ps.setLocalQueueState(newQueue, nextCurrent, r.baseBoardPath, r.boardDetails);
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

  // Actions value is now stable — all callbacks use latestRef with empty deps
  const actionsValue: GraphQLQueueActionsType = useMemo(
    () => ({
      addToQueue,
      removeFromQueue,
      setCurrentClimb,
      setCurrentClimbQueueItem,
      replaceQueueItem,
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
      replaceQueueItem,
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
  const [actionsVersion, setActionsVersion] = useState(0);
  const [dataVersion, setDataVersion] = useState(0);

  const adapter = usePersistentSessionQueueAdapter();

  // Ref for adapter sync function — keeps clear() deps empty
  const adapterSyncRef = useRef(adapter.syncFromInjected);
  adapterSyncRef.current = adapter.syncFromInjected;

  // eslint-disable-next-line react-hooks/exhaustive-deps -- actionsVersion/dataVersion force re-read of refs
  const effectiveContext = useMemo(
    () => (isInjected && injectedContextRef.current ? injectedContextRef.current : adapter.context),
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
                        {/* Sync queue state to iOS Live Activity (code-split, no-op on non-iOS) */}
                        <LiveActivityBridge
                          queue={adapter.context.queue}
                          currentClimbQueueItem={adapter.context.currentClimbQueueItem}
                          boardDetails={adapter.boardDetails}
                          sessionId={adapter.context.sessionId}
                          isSessionActive={adapter.context.isSessionActive}
                          onSetCurrentClimb={adapter.context.setCurrentClimbQueueItem}
                          onWidgetNavigate={effectiveActions.dispatchWidgetNavigation}
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

interface QueueBridgeInjectorProps {
  boardDetails: BoardDetails;
  angle: Angle;
}

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
