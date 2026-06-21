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
  CurrentClimbContext,
  CurrentClimbUuidContext,
  QueueListContext,
  SearchContext,
  SessionContext,
  type GraphQLQueueContextType,
  type GraphQLQueueActionsType,
} from '../graphql-queue/QueueContext';
import type { CurrentClimbDataType, QueueListDataType, SearchDataType, SessionDataType } from '../graphql-queue/types';
import { usePersistentSession } from '../persistent-session';
import { usePartyProfile } from '../party-manager/party-profile-context';
import { getBaseBoardPath, extractAngleFromPathname, DEFAULT_SEARCH_PARAMS } from '@/app/lib/url-utils';
import type { BoardDetails, Angle, Climb, SearchRequestPagination } from '@/app/lib/types';
import type { ClimbQueueItem, QueueItemUser, PlaylistSuggestionSource, SetCurrentClimbOptions } from './types';
import { usePathname } from 'next/navigation';
import dynamic from 'next/dynamic';
import { canAddClimbToBoard } from '@/app/lib/board-compatibility';
import { getBoardDetailsForPlaylist } from '@/app/lib/board-config-for-playlist';
import { useSnackbar } from '../providers/snackbar-provider';
import { queueAddErrorMessage } from '../board-lock/queue-add-error-messages';
import { QueueBridgeBoardInfoContext, type QueueBridgeBoardInfo } from './queue-bridge-board-info-context';
import { dispatchOpenPlayDrawer } from './play-drawer-event';
import type { SetActiveClimbSource } from '../graphql-queue/set-active-climb-event';
import { track } from '@/app/lib/analytics';
import {
  getPlaylistSuggestedClimbs,
  insertQueueItemAfterCurrent,
  isPlaylistPeekQueueItemUuid,
  playlistSuggestionSourceMatches,
  pruneSuggestedQueueItemsAfterCurrent,
} from './playlist-suggestions';
import { findNextQueueItemWithSuggestions } from '@boardsesh/play-view';
import type {
  ClimbQueue as SharedClimbQueue,
  ClimbQueueItem as SharedClimbQueueItem,
  PlaylistSuggestionSource as SharedPlaylistSuggestionSource,
} from '@boardsesh/queue';

const LiveActivityBridge = dynamic(() => import('@/app/lib/live-activity/live-activity-bridge'), {
  ssr: false,
});

// Bridge web's queue types to the shared `findNextQueueItemWithSuggestions`
// across the documented type seam (see ./types): web's ClimbQueueItem / Climb /
// PlaylistSuggestionSource are structurally compatible with — but not identical
// to — their @boardsesh/queue counterparts (web's Climb is wider). Centralizing
// the `as unknown as` casts here keeps the call site clean and mirrors the same
// boundary casting in ./playlist-suggestions.
function findNextQueueItemAcrossSeam(
  queue: ClimbQueueItem[],
  anchor: ClimbQueueItem | null,
  source: PlaylistSuggestionSource | null,
): ClimbQueueItem | null {
  return findNextQueueItemWithSuggestions(
    queue as unknown as SharedClimbQueue,
    anchor as unknown as SharedClimbQueueItem | null,
    source as unknown as SharedPlaylistSuggestionSource | null,
  ) as unknown as ClimbQueueItem | null;
}

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
    bd: BoardDetails,
    angle: Angle,
    baseBoardPath: string,
    boardUuid: string | null,
  ) => void;
  updateContext: (ctx: GraphQLQueueContextType, actions: GraphQLQueueActionsType) => void;
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
  boardDetails: BoardDetails | null;
  angle: Angle;
  hasResolvedAngle: boolean;
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
  // NOTE: the main QueueContext keeps `playlistSuggestionSource` inside the
  // queue reducer (so `INITIAL_QUEUE_DATA` / `UPDATE_QUEUE` clear it for free).
  // The bridge stores it in component state because the bridge doesn't own a
  // reducer — full-queue replacement paths in the bridge (FullSync, peer
  // replace) must remember to call `setPlaylistSuggestionSourceState(null)`
  // explicitly. If you add a new full-queue reset path to the bridge, plumb
  // the clear through here too.
  const [playlistSuggestionSource, setPlaylistSuggestionSourceState] = useState<PlaylistSuggestionSource | null>(null);

  const isParty = !!ps.activeSession;
  const queue = isParty ? ps.queue : ps.localQueue;
  const currentClimbQueueItem = isParty ? ps.currentClimbQueueItem : ps.localCurrentClimbQueueItem;
  const boardDetails = isParty ? ps.activeSession!.boardDetails : ps.localBoardDetails;

  // Read angle live from the URL when the user is on a board route. The
  // session's `parsedParams.angle` is parsed from `Session.boardPath` at
  // activate-time and doesn't follow subsequent URL changes — using it
  // directly was making the angle revert to whatever the session started
  // with whenever `useDrawerUrlSync` rewrote the URL (see queue-control-bar
  // pivot — group-session feedback fix). Off-board surfaces (home, /you,
  // /playlists) get no route angle, so they still fall through to the
  // session angle (party) or the current local climb's angle (solo).
  //
  // `resolvedAngle` is null when nothing in the chain produced a value —
  // distinct from numeric 0 (a real angle on vertical-board configs).
  // `angle` keeps the existing `Angle` (number) contract for consumers
  // that pass it down to components needing a numeric prop; we only
  // surface the null vs 0 distinction through `hasResolvedAngle`, which
  // `useEffectiveAngle` (the log paths) gates on. This keeps the bridge
  // type backward-compatible across the 8+ existing consumers.
  const pathnameForAngle = usePathname();
  const routeAngle = extractAngleFromPathname(pathnameForAngle ?? '');
  const resolvedAngle: Angle | null = isParty
    ? (routeAngle ?? ps.activeSession!.parsedParams.angle)
    : (routeAngle ?? ps.localCurrentClimbQueueItem?.climb?.angle ?? null);
  const hasResolvedAngle = resolvedAngle != null;
  const angle: Angle = resolvedAngle ?? 0;

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
    playlistSuggestionSource,
  });
  latestRef.current = {
    queue,
    currentClimbQueueItem,
    boardDetails,
    baseBoardPath,
    ps,
    showMessage,
    currentUserInfo,
    playlistSuggestionSource,
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

  // Bridge-mode nav delegates to the shared @boardsesh/play-view helper
  // (`findNextQueueItemWithSuggestions`) so web's off-board swipe path stays in
  // lockstep with mobile, which already uses that helper. The helper is
  // queue-first and, once the queue is exhausted, re-walks the playlist from
  // the CURRENT climb's position in the source — re-activating a playlist
  // climb starts a fresh pass instead of jumping to the first un-queued climb.
  //
  // `from`: pass `options.from ?? current` as the helper's
  // currentClimbQueueItem. This reproduces the old anchor selection
  // (anchor = the `from` item when supplied, else the current wall climb).
  // The web↔shared type-seam casts live in `findNextQueueItemAcrossSeam`.
  const getNextClimbQueueItem = useCallback((options?: { from?: ClimbQueueItem | null }): ClimbQueueItem | null => {
    const { queue, currentClimbQueueItem: current, playlistSuggestionSource } = latestRef.current;
    const anchor = options?.from ?? current;
    return findNextQueueItemAcrossSeam(queue, anchor, playlistSuggestionSource);
  }, []);

  const getPreviousClimbQueueItem = useCallback((options?: { from?: ClimbQueueItem | null }): ClimbQueueItem | null => {
    const { queue, currentClimbQueueItem: current } = latestRef.current;
    const anchorUuid = options?.from ? options.from.uuid : current?.uuid;
    const idx = queue.findIndex(({ uuid }) => uuid === anchorUuid);
    return idx > 0 ? queue[idx - 1] : null;
  }, []);

  const setCurrentClimbQueueItem = useCallback(
    (item: ClimbQueueItem) => {
      const { queue, currentClimbQueueItem: current, ps, boardDetails, baseBoardPath } = latestRef.current;
      const queueItem = isPlaylistPeekQueueItemUuid(item.uuid)
        ? { ...buildQueueItem(item.climb), suggested: item.suggested }
        : item;
      const alreadyInQueue = queue.some((q) => q.uuid === item.uuid);
      const fireSetActive = (source: SetActiveClimbSource) => {
        if (!queueItem.climb) return;
        track('Set Active Climb', {
          climbUuid: queueItem.climb.uuid,
          boardType: queueItem.climb.boardType ?? null,
          layoutId: queueItem.climb.layoutId ?? null,
          source,
        });
      };
      if (ps.activeSession) {
        // Don't bail on the "already current" optimistic state in party mode —
        // a peer may have moved the current climb away and our local view
        // hasn't caught up yet. Always re-send so the server reconciles.
        const correlationId = ps.clientId ? `${ps.clientId}-${++correlationCounterRef.current}` : undefined;
        ps.setCurrentClimb(queueItem, queueItem.suggested, correlationId).catch((err: unknown) => {
          console.error('Failed to set current climb queue item:', err);
        });
        fireSetActive('bridge.setCurrentClimbQueueItem.party');
        return;
      }
      if (alreadyInQueue && current?.uuid === queueItem.uuid) return;
      if (!boardDetails) return;
      const newQueue = alreadyInQueue ? queue : [...queue, queueItem];
      ps.setLocalQueueState(newQueue, queueItem, baseBoardPath, boardDetails);
      fireSetActive('bridge.setCurrentClimbQueueItem.solo');
    },
    [buildQueueItem],
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
    async (climb: Climb, options: SetCurrentClimbOptions): Promise<ClimbQueueItem | null> => {
      const {
        queue,
        currentClimbQueueItem: current,
        ps,
        boardDetails,
        baseBoardPath,
        playlistSuggestionSource: previousPlaylistSuggestionSource,
      } = latestRef.current;
      if (!validateClimbForQueue(climb)) return null;
      const nextPlaylistSuggestionSource = options.playlistSuggestionSource;
      const rollbackPlaylistSuggestionSource = () => {
        setPlaylistSuggestionSourceState(previousPlaylistSuggestionSource);
      };
      setPlaylistSuggestionSourceState(nextPlaylistSuggestionSource);
      track('Set Active Climb', {
        climbUuid: climb.uuid,
        boardType: climb.boardType ?? null,
        layoutId: climb.layoutId ?? null,
        source: 'bridge.setCurrentClimb' satisfies SetActiveClimbSource,
      });
      if (ps.activeSession) {
        const correlationId = ps.clientId ? `${ps.clientId}-${++correlationCounterRef.current}` : undefined;
        // If the climb is already in the queue, reuse the existing item
        // instead of adding a duplicate. This mirrors the natural behavior
        // expected by users tapping a logbook/session-view climb that's
        // already queued from another peer or earlier in the sesh.
        const existing = queue.find((q) => q.climb?.uuid === climb.uuid);
        if (existing) {
          try {
            if (nextPlaylistSuggestionSource) {
              await ps.setQueue(pruneSuggestedQueueItemsAfterCurrent(queue, existing), existing);
            } else {
              await ps.setCurrentClimb(existing, false, correlationId);
            }
            return existing;
          } catch (err: unknown) {
            console.error('Failed to set current climb:', err);
            rollbackPlaylistSuggestionSource();
            return null;
          }
        }
        const newItem = buildQueueItem(climb);
        const currentIdx = current ? queue.findIndex((q) => q.uuid === current.uuid) : -1;
        const position = currentIdx === -1 ? undefined : currentIdx + 1;
        if (nextPlaylistSuggestionSource) {
          const queueWithNewItem = insertQueueItemAfterCurrent(queue, current, newItem);
          const prunedQueue = pruneSuggestedQueueItemsAfterCurrent(queueWithNewItem, newItem);
          try {
            await ps.setQueue(prunedQueue, newItem);
            return newItem;
          } catch (err: unknown) {
            console.error('Failed to replace queue before setting playlist current:', err);
            rollbackPlaylistSuggestionSource();
            return null;
          }
        }
        // Split the awaits so a partial failure is observable: addQueueItem
        // adds the item to the shared queue, then setCurrentClimb activates
        // it. If addQueueItem fails, nothing landed on the server. If
        // setCurrentClimb fails after addQueueItem succeeded, the item is
        // queued but not active — return null so the caller (e.g.
        // SessionDetailContent.navigateToClimb) doesn't navigate to a climb
        // the board never actually got told to display.
        try {
          await ps.addQueueItem(newItem, position);
        } catch (err: unknown) {
          console.error('Failed to add queue item before setting current:', err);
          rollbackPlaylistSuggestionSource();
          return null;
        }
        try {
          // Sequential awaits over a single graphql-ws connection preserve
          // FIFO ordering, so the server processes the add before the
          // setCurrentClimb that references it. This mirrors
          // GraphQLQueueProvider.setCurrentClimb.
          await ps.setCurrentClimb(newItem, false, correlationId);
          return newItem;
        } catch (err: unknown) {
          console.error('Failed to set current climb after queue add:', err);
          rollbackPlaylistSuggestionSource();
          return null;
        }
      }
      const newItem = buildQueueItem(climb);
      if (!boardDetails) {
        // Cold-start path: no active board yet. Seed local state from the
        // climb's own board config so the queue bar begins showing.
        const seed = deriveSeedStateFromClimb(climb);
        if (!seed) {
          rollbackPlaylistSuggestionSource();
          return null;
        }
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
      const nextQueue = nextPlaylistSuggestionSource
        ? pruneSuggestedQueueItemsAfterCurrent(newQueue, newItem)
        : newQueue;
      ps.setLocalQueueState(nextQueue, newItem, baseBoardPath, boardDetails);
      return newItem;
    },
    [validateClimbForQueue, buildQueueItem],
  );

  // Bridge-mode browse helper. Always-live model: every participant broadcasts
  // via setCurrentClimb so the wall climb changes for everyone, then opens the
  // drawer. Mirrors QueueContext.previewClimbFromBrowse.
  const previewClimbFromBrowse = useCallback(
    (climb: Climb) => {
      void setCurrentClimb(climb, { playlistSuggestionSource: null });
      dispatchOpenPlayDrawer();
    },
    [setCurrentClimb],
  );

  // Bridge-mode wall-disconnect report. Tells the session this client's own
  // BLE link dropped so every member's wall-confirmed lightbulb clears.
  // Best-effort; no-op in solo or while disconnected. Mirrors
  // QueueContext.reportWallDisconnect.
  const reportWallDisconnect = useCallback(async (): Promise<void> => {
    const { ps } = latestRef.current;
    if (!ps.activeSession) return;
    if (!ps.hasConnected) return;
    try {
      await ps.reportWallDisconnect();
    } catch (err: unknown) {
      console.error('Failed to report wall disconnect:', err);
    }
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

  const setPlaylistSuggestionSource = useCallback((source: PlaylistSuggestionSource | null) => {
    setPlaylistSuggestionSourceState(source);
  }, []);

  const refreshPlaylistSuggestionSource = useCallback((source: PlaylistSuggestionSource) => {
    setPlaylistSuggestionSourceState((current) =>
      playlistSuggestionSourceMatches(current, source) ? source : current,
    );
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
      previewClimbFromBrowse,
      setCurrentClimbQueueItem,
      setPlaylistSuggestionSource,
      refreshPlaylistSuggestionSource,
      replaceQueueItem,
      setClimbSearchParams: noopSetClimbSearchParams,
      setCountSearchParams: noopSetClimbSearchParams,
      mirrorClimb,
      fetchMoreClimbs: noop,
      getNextClimbQueueItem,
      getPreviousClimbQueueItem,
      setQueue,
      reportWallDisconnect,
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
      previewClimbFromBrowse,
      setCurrentClimbQueueItem,
      setPlaylistSuggestionSource,
      refreshPlaylistSuggestionSource,
      replaceQueueItem,
      noopSetClimbSearchParams,
      mirrorClimb,
      noop,
      getNextClimbQueueItem,
      getPreviousClimbQueueItem,
      setQueue,
      reportWallDisconnect,
      stableDeactivateSession,
      noopStartSession,
      noopJoinSession,
    ],
  );

  const context: GraphQLQueueContextType = useMemo(
    () => ({
      ...actionsValue,
      queue,
      currentClimbQueueItem,
      currentClimb: currentClimbQueueItem?.climb ?? null,
      climbSearchParams: DEFAULT_SEARCH_PARAMS,
      climbSearchResults: null,
      suggestedClimbs: getPlaylistSuggestedClimbs(playlistSuggestionSource, queue),
      playlistSuggestionSource,
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
      isPersistentSessionActive: isParty,
      sessionId: ps.activeSession?.sessionId ?? null,
      sessionSummary: null,
      sessionGoal: ps.session?.goal ?? null,
      users: isParty ? ps.users : [],
      clientId: ps.clientId,
      participantId: ps.participantId,
      isLeader: ps.isLeader,
      // Read the wall-lit indicator from the root persistent-session provider
      // (always mounted), so the off-board persistent bar/drawer lightbulb stays
      // correct even though this bridge has no session-event subscription of its
      // own. Solo (not a party) is never lit.
      wallConfirmed: isParty ? ps.isSessionWallLit : false,
      lastConnectedBoardSerial: isParty ? (ps.session?.lastConnectedBoardSerial ?? null) : null,
      isBackendMode: true,
      hasConnected: ps.hasConnected,
      connectionError: ps.error,
      isDisconnected: false,
    }),
    [
      actionsValue,
      queue,
      currentClimbQueueItem,
      playlistSuggestionSource,
      parsedParams,
      isParty,
      ps.hasConnected,
      ps.activeSession?.sessionId,
      ps.session?.goal,
      ps.session?.lastConnectedBoardSerial,
      ps.users,
      ps.clientId,
      ps.participantId,
      ps.isLeader,
      ps.isSessionWallLit,
      ps.error,
    ],
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
    boardDetails,
    angle,
    hasResolvedAngle,
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
  // Saved-board UUID from a `/b/{slug}` injector (null for non-saved board routes).
  const [injectedBoardUuid, setInjectedBoardUuid] = useState<string | null>(null);

  // Injected values stored in refs to avoid cleanup/setup cycles. The combined
  // context now carries every data field, so the separate `injectedDataRef`
  // that lived here before is gone — `injectedContextRef` is the single
  // source. The two version counters below are still needed (they drive the
  // `effectiveContext` / `effectiveActions` useMemo dep arrays).
  const injectedContextRef = useRef<GraphQLQueueContextType | null>(null);
  const injectedActionsRef = useRef<GraphQLQueueActionsType | null>(null);
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

  const effectiveBoardDetails = isInjected ? injectedBoardDetails : adapter.boardDetails;
  // Only board-route injectors carry a saved-board UUID; the solo/session
  // adapter path has none.
  const effectiveBoardUuid = isInjected ? injectedBoardUuid : null;
  const effectiveAngle = isInjected ? injectedAngle : adapter.angle;
  // The injector path passes a fully-resolved angle from the board route
  // segment, so injected => resolved by definition.
  const effectiveHasResolvedAngle = isInjected ? true : adapter.hasResolvedAngle;
  const effectiveHasActiveQueue = isInjected
    ? true // If injected, a board route is active — always show bar
    : adapter.hasActiveQueue;
  // When a board route injector is active we already know board state
  // synchronously; otherwise mirror the persistent session's restore flag.
  const effectiveIsHydrated = isInjected ? true : adapter.isHydrated;

  const boardInfo = useMemo<QueueBridgeBoardInfo>(
    () => ({
      boardDetails: effectiveBoardDetails,
      boardUuid: effectiveBoardUuid,
      angle: effectiveAngle,
      hasResolvedAngle: effectiveHasResolvedAngle,
      hasActiveQueue: effectiveHasActiveQueue,
      isHydrated: effectiveIsHydrated,
    }),
    [
      effectiveBoardDetails,
      effectiveBoardUuid,
      effectiveAngle,
      effectiveHasResolvedAngle,
      effectiveHasActiveQueue,
      effectiveIsHydrated,
    ],
  );

  const inject = useCallback(
    (
      ctx: GraphQLQueueContextType,
      actions: GraphQLQueueActionsType,
      bd: BoardDetails,
      a: Angle,
      baseBoardPath: string,
      bu: string | null,
    ) => {
      injectedContextRef.current = ctx;
      injectedActionsRef.current = actions;
      injectedBoardDetailsRef.current = bd;
      injectedBaseBoardPathRef.current = baseBoardPath;
      setInjectedBoardDetails(bd);
      setInjectedAngle(a);
      setInjectedBoardUuid(bu);
      setIsInjected(true);
      setActionsVersion((v) => v + 1);
      setDataVersion((v) => v + 1);
    },
    [],
  );

  const updateContext = useCallback((ctx: GraphQLQueueContextType, actions: GraphQLQueueActionsType) => {
    const actionsChanged = actions !== injectedActionsRef.current;
    const dataChanged = ctx !== injectedContextRef.current;
    injectedContextRef.current = ctx;
    injectedActionsRef.current = actions;
    // Bump data version when the combined context reference changes — that's
    // the data signal now that the separate data context is gone.
    if (dataChanged) {
      setDataVersion((v) => v + 1);
    }
    // Only bump actions version when the actions object identity actually changed.
    // GraphQLQueueProvider's actionsValue uses latestRef with empty deps, so this
    // almost never changes — keeping QueueActionsContext stable for consumers.
    if (actionsChanged) {
      setActionsVersion((v) => v + 1);
    }
  }, []);

  const clear = useCallback(() => {
    // Before clearing: sync the last injected queue state to the persistent
    // session's local queue so the adapter has up-to-date data when it takes
    // over. In party mode this is a no-op (setLocalQueueState guards on
    // activeSession).
    const lastCtx = injectedContextRef.current;
    const bd = injectedBoardDetailsRef.current;
    const bbp = injectedBaseBoardPathRef.current;
    if (lastCtx && bd && bbp) {
      adapterSyncRef.current(lastCtx.queue, lastCtx.currentClimbQueueItem, bbp, bd);
    }

    injectedContextRef.current = null;
    injectedActionsRef.current = null;
    injectedBoardDetailsRef.current = null;
    injectedBaseBoardPathRef.current = '';
    setIsInjected(false);
    setInjectedBoardDetails(null);
    setInjectedAngle(0);
    setInjectedBoardUuid(null);
    setActionsVersion((v) => v + 1);
    setDataVersion((v) => v + 1);
  }, []);

  const setters = useMemo<QueueBridgeSetters>(() => ({ inject, updateContext, clear }), [inject, updateContext, clear]);

  // Derive fine-grained context values from the effective context (which is
  // the combined GraphQLQueueContextType — actions + data fields).
  const effectiveCurrentClimb: CurrentClimbDataType = useMemo(
    () => ({
      currentClimbQueueItem: effectiveContext.currentClimbQueueItem,
      currentClimb: effectiveContext.currentClimb,
    }),
    [effectiveContext.currentClimbQueueItem, effectiveContext.currentClimb],
  );
  const effectiveCurrentClimbUuid = effectiveContext.currentClimbQueueItem?.uuid ?? null;

  const effectiveQueueList: QueueListDataType = useMemo(
    () => ({
      queue: effectiveContext.queue,
      suggestedClimbs: effectiveContext.suggestedClimbs,
    }),
    [effectiveContext.queue, effectiveContext.suggestedClimbs],
  );

  const effectiveSearch: SearchDataType = useMemo(
    () => ({
      climbSearchParams: effectiveContext.climbSearchParams,
      climbSearchResults: effectiveContext.climbSearchResults,
      totalSearchResultCount: effectiveContext.totalSearchResultCount,
      hasMoreResults: effectiveContext.hasMoreResults,
      isFetchingClimbs: effectiveContext.isFetchingClimbs,
      isFetchingNextPage: effectiveContext.isFetchingNextPage,
      hasDoneFirstFetch: effectiveContext.hasDoneFirstFetch,
      parsedParams: effectiveContext.parsedParams,
    }),
    [
      effectiveContext.climbSearchParams,
      effectiveContext.climbSearchResults,
      effectiveContext.totalSearchResultCount,
      effectiveContext.hasMoreResults,
      effectiveContext.isFetchingClimbs,
      effectiveContext.isFetchingNextPage,
      effectiveContext.hasDoneFirstFetch,
      effectiveContext.parsedParams,
    ],
  );

  const effectiveSession: SessionDataType = useMemo(
    () => ({
      viewOnlyMode: effectiveContext.viewOnlyMode,
      isSessionActive: effectiveContext.isSessionActive,
      isPersistentSessionActive: effectiveContext.isPersistentSessionActive,
      sessionId: effectiveContext.sessionId,
      sessionSummary: effectiveContext.sessionSummary,
      sessionGoal: effectiveContext.sessionGoal,
      connectionState: effectiveContext.connectionState,
      canMutate: effectiveContext.canMutate,
      isDisconnected: effectiveContext.isDisconnected,
      users: effectiveContext.users ?? [],
      clientId: effectiveContext.clientId ?? null,
      participantId: effectiveContext.participantId ?? null,
      isLeader: effectiveContext.isLeader ?? false,
      wallConfirmed: effectiveContext.wallConfirmed ?? false,
      lastConnectedBoardSerial: effectiveContext.lastConnectedBoardSerial ?? null,
      isBackendMode: effectiveContext.isBackendMode ?? false,
      hasConnected: effectiveContext.hasConnected ?? false,
      connectionError: effectiveContext.connectionError ?? null,
    }),
    [
      effectiveContext.viewOnlyMode,
      effectiveContext.isSessionActive,
      effectiveContext.isPersistentSessionActive,
      effectiveContext.sessionId,
      effectiveContext.sessionSummary,
      effectiveContext.sessionGoal,
      effectiveContext.connectionState,
      effectiveContext.canMutate,
      effectiveContext.isDisconnected,
      effectiveContext.users,
      effectiveContext.clientId,
      effectiveContext.participantId,
      effectiveContext.isLeader,
      effectiveContext.wallConfirmed,
      effectiveContext.lastConnectedBoardSerial,
      effectiveContext.isBackendMode,
      effectiveContext.hasConnected,
      effectiveContext.connectionError,
    ],
  );

  // Renamed locals so jsx-handler-names sees on*-prefixed identifiers being
  // passed to the on*-prefixed props on LiveActivityBridge below.
  const onSetCurrentClimb = effectiveActions.setCurrentClimbQueueItem;
  // Off-board (adapter-mode) sessions don't populate dispatchWidgetNavigation
  // in actionsValue above. The LiveActivityBridge handler degrades to
  // `onSetCurrentClimb` (the adapter's setCurrentClimbQueueItem) which still
  // sends the server mutation via `ps.setCurrentClimb` in party mode, so the
  // server broadcasts CurrentClimbChanged, the WebSocket subscription updates
  // adapter state, and BluetoothAutoSender writes to the wall. Once a board
  // route mounts and injects its own actions, this picks up the real
  // dispatcher from GraphQLQueueProvider and the optimistic update keeps the
  // local reducer ahead of the server echo.
  const onWidgetNavigate = effectiveActions.dispatchWidgetNavigation;

  return (
    <QueueBridgeSetterContext.Provider value={setters}>
      <QueueBridgeBoardInfoContext.Provider value={boardInfo}>
        <QueueActionsContext.Provider value={effectiveActions}>
          <QueueContext.Provider value={effectiveContext}>
            <CurrentClimbContext.Provider value={effectiveCurrentClimb}>
              <CurrentClimbUuidContext.Provider value={effectiveCurrentClimbUuid}>
                <QueueListContext.Provider value={effectiveQueueList}>
                  <SearchContext.Provider value={effectiveSearch}>
                    <SessionContext.Provider value={effectiveSession}>
                      {/* Sync queue state to iOS Live Activity (code-split, no-op on non-iOS).
                          Use effectiveContext so the Live Activity reflects the live party
                          queue while on a board route (injected mode), not the adapter's
                          local view (which is a no-op in party mode). */}
                      <LiveActivityBridge
                        queue={effectiveContext.queue}
                        currentClimbQueueItem={effectiveContext.currentClimbQueueItem}
                        boardDetails={effectiveBoardDetails}
                        sessionId={effectiveContext.sessionId}
                        isSessionActive={effectiveContext.isSessionActive}
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
  /** Saved-board UUID on `/b/{slug}` routes so the root BluetoothProvider can
   * link a paired serial to the saved board. Omitted on standard board routes. */
  boardUuid?: string | null;
};

export function QueueBridgeInjector({ boardDetails, angle, boardUuid = null }: QueueBridgeInjectorProps) {
  const { inject, updateContext, clear } = useContext(QueueBridgeSetterContext);
  const pathname = usePathname();
  const baseBoardPath = useMemo(() => getBaseBoardPath(pathname), [pathname]);

  // Read the board route's split contexts from GraphQLQueueProvider
  const queueContext = useContext(QueueContext);
  const queueActions = useContext(QueueActionsContext);

  // Track whether we've done the initial injection
  const hasInjectedRef = useRef(false);

  // Keep latest base board path in a ref so mount/unmount cleanup can read it
  // without forcing the setup/cleanup effect to rerun on pathname changes.
  const baseBoardPathRef = useRef(baseBoardPath);
  baseBoardPathRef.current = baseBoardPath;

  // Same ref trick for boardUuid so the layout effect doesn't re-run on it.
  const boardUuidRef = useRef(boardUuid);
  boardUuidRef.current = boardUuid;

  // Initial injection: set board details + context on mount
  useLayoutEffect(() => {
    if (queueContext && queueActions) {
      inject(queueContext, queueActions, boardDetails, angle, baseBoardPathRef.current, boardUuidRef.current);
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
    if (!queueContext || !queueActions) return;
    if (hasInjectedRef.current) {
      // updateContext only refreshes the queue context/actions. Board identity
      // (boardDetails/angle/boardUuid) is owned by the layout effect's inject,
      // which re-fires on route change — so a boardUuid change can't (and
      // shouldn't) propagate from here. Read it from the ref on the deferred
      // path below so it isn't a misleading no-op dependency of this effect.
      updateContext(queueContext, queueActions);
    } else {
      inject(queueContext, queueActions, boardDetails, angle, baseBoardPath, boardUuidRef.current);
      hasInjectedRef.current = true;
    }
  }, [queueContext, queueActions, updateContext, inject, boardDetails, angle, baseBoardPath]);

  return null;
}
