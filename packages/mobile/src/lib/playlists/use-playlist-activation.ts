// Bridges the shared `usePlaylistClimbActivation` hook to mobile's queue
// provider + drawer host. Both the playlist-detail and smart-playlist-detail
// screens call this with their own source id and per-page climb fetcher; the
// only difference between them is which GraphQL query backs the suggestion
// refresh, so that fetcher is injected.
//
// Active-board activation is two-phase (see the shared hook): it synchronously
// activates the tapped climb with a suggestion source built from the loaded
// climbs, opens the play drawer, then asynchronously fetches the full ordered
// board climb list and swaps in a richer suggestion source so swiping through
// the play drawer walks the whole playlist. Wrong-board playlists use a
// view-only drawer path so they can be inspected without mutating the queue.
//
// Playlist-detail screens additionally opt into `replaceQueueOnActivate`: a tap
// replaces the whole queue with the playlist order (tapped climb active) so
// previous/next walk the circuit. Because that clears any future queue items, a
// confirmation sheet warns first whenever the queue has items after the current.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  usePlaylistClimbActivation,
  fetchPlaylistSuggestionClimbs,
  isAbortError,
  PLAYLIST_SUGGESTION_REFRESH_PAGE_SIZE,
} from '@boardsesh/playlists-react';
import { createPlaylistSuggestionSource, getQueueBoardKey, type Climb, type ClimbQueueItem } from '@boardsesh/queue';
import { useActiveClimbUuid, usePlaylistSuggestionSource, useQueueActions } from '../../providers/queue-provider';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useToast } from '../../providers/toast-provider';
import { useActiveBoard } from '../graphql/use-active-board';
import { climbToQueueItem } from '../climb-to-queue-item';
import { reportHandledError } from '../error-reporting';
import { toSchemaClimb } from '../climb-types';
import type { PlaylistRenderBoard } from './use-playlist-render-board';

/** A single page of the suggestion-refresh fetch. */
export type PlaylistActivationPage = {
  climbs: Climb[];
  hasMore: boolean;
};

/** Return a board config for view-only drawer preview, or null to activate normally. */
type ViewOnlyBoardResolver = (climb: Climb) => PlaylistRenderBoard | null;

export type UsePlaylistActivationOptions = {
  /** Stable suggestion-source id (e.g. `playlist:<uuid>` or `smart:<type>:<userId>`). */
  sourceId: string;
  /** All currently-loaded climbs, used to seed the initial suggestion source. */
  allClimbs: Climb[];
  /**
   * Fetch one page of the ordered board climb list for the suggestion refresh.
   * Receives the activated board (boardName/layoutId/sizeId/setIds/angle so the
   * caller can build the right query input) plus the page cursor.
   */
  fetchPage: (args: {
    page: number;
    pageSize: number;
    board: { boardName: string; layoutId: number; sizeId: number; setIds: string; angle: number };
    signal: AbortSignal;
  }) => Promise<PlaylistActivationPage>;
  /**
   * When set, the tap is view-only: open the drawer against this board config
   * and keep playlist navigation local to the drawer without mutating the active
   * queue. A resolver can return the specific board for the tapped row, or null
   * when that row should activate normally.
   */
  viewOnlyBoard?: PlaylistRenderBoard | ViewOnlyBoardResolver | null;
  /** Logged when the async suggestion refresh fails (non-abort). */
  refreshErrorMessage: string;
  /** Replace the user's queue with the playlist order instead of suggestion-fallback navigation. */
  replaceQueueOnActivate?: boolean;
};

type PendingQueueReplacement = {
  climb: Climb;
  futureQueueCount: number;
  loadedClimbs?: Climb[];
  previewQueueItem?: ClimbQueueItem | null;
};

export type PlaylistQueueReplaceSheetState = {
  visible: boolean;
  futureQueueCount: number;
  isReplacing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export type PlaylistActivationResult = {
  /** Callback to wire onto a climb row tap. */
  activate: (climb: Climb) => Promise<void>;
  /** Props for PlaylistQueueReplaceSheet. */
  queueReplaceSheet: PlaylistQueueReplaceSheetState;
};

function countFutureQueueItems(queue: ClimbQueueItem[], currentClimbQueueItem: ClimbQueueItem | null): number {
  const currentIndex = currentClimbQueueItem
    ? queue.findIndex((queueItem) => queueItem.uuid === currentClimbQueueItem.uuid)
    : -1;
  const futureQueue = currentIndex >= 0 ? queue.slice(currentIndex + 1) : queue;
  // Count every future item, suggestion-origin included: a whole-queue
  // replacement clears them all, so the user must be warned about all of them.
  return futureQueue.length;
}

function buildPlaylistQueue(
  climbs: Climb[],
  activatedClimb: Climb,
  activatedQueueItem?: ClimbQueueItem | null,
): { queue: ClimbQueueItem[]; currentItem: ClimbQueueItem } {
  const queue: ClimbQueueItem[] = [];
  let currentItem: ClimbQueueItem | null = null;
  const reusableCurrentItem = activatedQueueItem?.climb.uuid === activatedClimb.uuid ? activatedQueueItem : null;
  const seen = new Set<string>();

  for (const climb of climbs) {
    if (seen.has(climb.uuid)) continue;
    seen.add(climb.uuid);
    const item =
      reusableCurrentItem && climb.uuid === activatedClimb.uuid
        ? reusableCurrentItem
        : climbToQueueItem(toSchemaClimb(climb));
    queue.push(item);
    if (climb.uuid === activatedClimb.uuid) currentItem = item;
  }

  if (currentItem) return { queue, currentItem };

  // The activated climb wasn't in the loaded list (or the list was empty) —
  // append it so the queue always contains and centres on the tapped climb.
  const appended = reusableCurrentItem ?? climbToQueueItem(toSchemaClimb(activatedClimb));
  queue.push(appended);
  return { queue, currentItem: appended };
}

/** Returns playlist activation controls to wire onto a climb row tap. */
export function usePlaylistActivation({
  sourceId,
  allClimbs,
  fetchPage,
  viewOnlyBoard,
  refreshErrorMessage,
  replaceQueueOnActivate = false,
}: UsePlaylistActivationOptions): PlaylistActivationResult {
  const { setCurrentClimb, setPlaylistSuggestionSource, refreshPlaylistSuggestionSource, setQueue, getQueueSnapshot } =
    useQueueActions();
  const { openPlayDrawer } = useDrawerHost();
  const { showToast } = useToast();
  const { t } = useTranslation('playlists');
  const activeBoard = useActiveBoard().data ?? null;

  const [pendingReplacement, setPendingReplacement] = useState<PendingQueueReplacement | null>(null);
  const [isReplacingQueue, setIsReplacingQueue] = useState(false);
  const replacementAbortRef = useRef<AbortController | null>(null);

  // Mirror the active climb uuid + the live suggestion source into refs so the
  // returned callback can decide how to handle a re-tap of the already-active
  // climb without taking a dependency on either (keeps the callback identity
  // stable). The source tells us whether the drawer's next/previous already
  // follow THIS list or some other one.
  const activeClimbUuid = useActiveClimbUuid();
  const activeClimbUuidRef = useRef(activeClimbUuid);
  activeClimbUuidRef.current = activeClimbUuid;
  const playlistSuggestionSource = usePlaylistSuggestionSource();
  const playlistSuggestionSourceRef = useRef(playlistSuggestionSource);
  playlistSuggestionSourceRef.current = playlistSuggestionSource;

  // The queue item the returned callback built for this tap. queueApi.setCurrentClimb
  // dispatches that exact instance so the drawer's navigation anchor and the queue
  // entry share one uuid — otherwise prev/remaining-count anchor on an orphan uuid
  // that's never in the queue. Single-use; the climb-uuid match guards against a
  // stale ref from an earlier tap whose activation never reached setCurrentClimb.
  const pendingQueueItemRef = useRef<ClimbQueueItem | null>(null);

  // The shared hook expects setCurrentClimb to return the activated item (so it
  // knows activation succeeded and can fire onActivated). Mobile's provider
  // method returns void, so wrap it: reuse the pinned queue item (or build one
  // for paths that bypassed the drawer pin), dispatch, and return the item.
  const queueApi = useMemo(
    () => ({
      setCurrentClimb: async (climb: Climb, options: Parameters<typeof setCurrentClimb>[1]) => {
        const pendingItem = pendingQueueItemRef.current;
        pendingQueueItemRef.current = null;
        // The tapped climb is already the active climb (re-tapped from a list
        // whose suggestions don't yet follow it). Don't re-append it — that would
        // duplicate it in the queue and reset the pass. Just point the suggestion
        // source at the tapped list so the drawer's next/previous follow it; the
        // shared hook's async refresh then upgrades that source in place. Return a
        // non-null item so the hook treats activation as succeeded.
        if (activeClimbUuidRef.current === climb.uuid) {
          setPlaylistSuggestionSource(options?.playlistSuggestionSource ?? null);
          return pendingItem ?? climbToQueueItem(toSchemaClimb(climb));
        }
        const item =
          pendingItem && pendingItem.climb.uuid === climb.uuid ? pendingItem : climbToQueueItem(toSchemaClimb(climb));
        // Commit synchronously: the drawer now renders from currentClimbQueueItem
        // (no preview render-ahead), so this dispatch must land in the same batch
        // as the open — under startTransition it would defer and the drawer would
        // paint a stale first frame.
        setCurrentClimb(item, options);
        return item;
      },
      refreshPlaylistSuggestionSource,
    }),
    [setCurrentClimb, setPlaylistSuggestionSource, refreshPlaylistSuggestionSource],
  );

  const resolveTarget = useCallback(
    (climb: Climb) => {
      void climb;
      if (!activeBoard) return null;
      return {
        boardKey: getQueueBoardKey({
          board_name: activeBoard.boardType,
          layout_id: activeBoard.layoutId,
          size_id: activeBoard.sizeId,
          set_ids: activeBoard.setIds,
        }),
        boardName: activeBoard.boardType,
        angle: activeBoard.angle,
        // Single active board on mobile — every loaded climb is climbable.
        isClimbable: () => true,
      };
    },
    [activeBoard],
  );

  const fetchClimbsForBoard = useCallback(
    async ({ activatedClimbUuid, signal }: { activatedClimbUuid: string; signal: AbortSignal }) => {
      if (!activeBoard) return [];
      const board = {
        boardName: activeBoard.boardType,
        layoutId: activeBoard.layoutId,
        sizeId: activeBoard.sizeId,
        setIds: activeBoard.setIds,
        angle: activeBoard.angle,
      };
      return fetchPlaylistSuggestionClimbs({
        activatedClimbUuid,
        signal,
        fetchPage: ({ page, pageSize, signal: pageSignal }) => fetchPage({ page, pageSize, board, signal: pageSignal }),
      });
    },
    [activeBoard, fetchPage],
  );

  const fetchAllClimbsForBoard = useCallback(
    async ({ signal }: { signal: AbortSignal }) => {
      if (!activeBoard) return [];
      const board = {
        boardName: activeBoard.boardType,
        layoutId: activeBoard.layoutId,
        sizeId: activeBoard.sizeId,
        setIds: activeBoard.setIds,
        angle: activeBoard.angle,
      };
      const climbs: Climb[] = [];
      let page = 0;
      let hasMore = true;

      while (hasMore && !signal.aborted) {
        const pageResult = await fetchPage({
          page,
          pageSize: PLAYLIST_SUGGESTION_REFRESH_PAGE_SIZE,
          board,
          signal,
        });
        climbs.push(...pageResult.climbs);
        hasMore = pageResult.hasMore;
        page += 1;
      }

      return climbs;
    },
    [activeBoard, fetchPage],
  );

  useEffect(() => {
    return () => {
      replacementAbortRef.current?.abort();
    };
  }, []);

  const activate = usePlaylistClimbActivation({
    queueApi,
    sourceId,
    allClimbs,
    resolveTarget,
    fetchClimbsForBoard,
    // onActivated is intentionally omitted — the drawer is opened in the
    // returned callback BEFORE activate() runs, so the BottomSheet animation
    // starts on the same frame as the tap with no state-update work in between.
    refreshErrorMessage,
  });

  const replaceQueueWithPlaylist = useCallback(
    async (
      climb: Climb,
      options: {
        allowClearingManualFuture?: boolean;
        loadedClimbs?: Climb[];
        previewQueueItem?: ClimbQueueItem | null;
      } = {},
    ) => {
      replacementAbortRef.current?.abort();
      const abortController = new AbortController();
      replacementAbortRef.current = abortController;
      setIsReplacingQueue(true);
      try {
        const climbs = options.loadedClimbs ?? (await fetchAllClimbsForBoard({ signal: abortController.signal }));
        if (abortController.signal.aborted) return;
        // Re-check live queue state after the async load: new future items may
        // have landed while the ordered list streamed in, and replacement still
        // clears them — so warn instead of clearing silently. Skipped once the
        // user has confirmed (allowClearingManualFuture).
        const { queue: latestQueue, currentClimbQueueItem: latestCurrent } = getQueueSnapshot();
        const latestFutureQueueCount = countFutureQueueItems(latestQueue, latestCurrent);
        if (!options.allowClearingManualFuture && latestFutureQueueCount > 0) {
          setPendingReplacement({
            climb,
            futureQueueCount: latestFutureQueueCount,
            loadedClimbs: climbs,
            previewQueueItem: options.previewQueueItem ?? null,
          });
          return;
        }
        const { queue, currentItem } = buildPlaylistQueue(climbs, climb, options.previewQueueItem);
        setQueue(queue, currentItem);
        // The activate path already opened the drawer (committedExternally) on the
        // seed queue; the confirm path opens it now that the climb is current.
        if (!options.previewQueueItem) {
          openPlayDrawer(toSchemaClimb(climb), { committedExternally: true });
        }
        setPendingReplacement(null);
      } catch (error) {
        if (isAbortError(error)) return;
        console.error('Playlist queue replacement failed:', error);
        reportHandledError(error, { tags: { source: 'playlist', op: 'replace-queue' } });
        showToast(t('detail.queueReplace.loadFailed'), 'error');
      } finally {
        if (replacementAbortRef.current === abortController) {
          replacementAbortRef.current = null;
        }
        setIsReplacingQueue(false);
      }
    },
    [fetchAllClimbsForBoard, getQueueSnapshot, openPlayDrawer, setQueue, showToast, t],
  );

  const cancelQueueReplacement = useCallback(() => {
    replacementAbortRef.current?.abort();
    setPendingReplacement(null);
    setIsReplacingQueue(false);
  }, []);

  const confirmQueueReplacement = useCallback(() => {
    if (!pendingReplacement || isReplacingQueue) return;
    // The queue can grow between opening the sheet and confirming. Re-read it and,
    // if more future items appeared, bump the warning count and require another
    // confirm so the user never clears items they haven't seen counted.
    const { queue, currentClimbQueueItem } = getQueueSnapshot();
    const latestFutureQueueCount = countFutureQueueItems(queue, currentClimbQueueItem);
    if (latestFutureQueueCount > pendingReplacement.futureQueueCount) {
      setPendingReplacement({ ...pendingReplacement, futureQueueCount: latestFutureQueueCount });
      return;
    }
    void replaceQueueWithPlaylist(pendingReplacement.climb, {
      allowClearingManualFuture: true,
      loadedClimbs: pendingReplacement.loadedClimbs,
      previewQueueItem: pendingReplacement.previewQueueItem,
    });
  }, [getQueueSnapshot, isReplacingQueue, pendingReplacement, replaceQueueWithPlaylist]);

  // Open the drawer immediately, then let the shared hook commit the climb. The
  // open and the synchronous setCurrentClimb dispatch land in the same React
  // batch, so the drawer (rendering from currentClimbQueueItem) paints the
  // activated climb on the first frame. `committedExternally` tells the drawer
  // the caller already dispatched, so it doesn't re-commit or treat this as a
  // preview.
  const activatePlaylistClimb = useCallback(
    (climb: Climb) => {
      const schemaClimb = toSchemaClimb(climb);

      // Wrong-board playlist climb: open a view-only drawer against the playlist's
      // board instead of mutating the active-board queue. The drawer navigates the
      // playlist locally (previewPlaylistSuggestionSource) until the user switches
      // boards, and the tapped climb's angle rides along on the override.
      const resolvedViewOnlyBoard = typeof viewOnlyBoard === 'function' ? viewOnlyBoard(climb) : viewOnlyBoard;

      if (resolvedViewOnlyBoard) {
        const item = climbToQueueItem(schemaClimb, { suggested: true });
        const viewOnlyBoardConfig = {
          ...resolvedViewOnlyBoard,
          angle: climb.angle,
        };
        const previewSuggestionSource = createPlaylistSuggestionSource({
          playlistUuid: sourceId,
          activatedClimb: climb,
          climbs: allClimbs,
          boardKey: getQueueBoardKey({
            board_name: viewOnlyBoardConfig.boardName,
            layout_id: viewOnlyBoardConfig.layoutId,
            size_id: viewOnlyBoardConfig.sizeId,
            set_ids: viewOnlyBoardConfig.setIds,
          }),
        });
        openPlayDrawer(schemaClimb, {
          boardConfig: viewOnlyBoardConfig,
          previewQueueItem: item,
          playlistSuggestionSource: previewSuggestionSource,
        });
        return Promise.resolve();
      }

      // Replace-on-activate (playlist/circuit detail): swap the whole queue for the
      // playlist order so previous/next walk the circuit. Replacement clears future
      // queue items, so warn first when any exist; otherwise seed the queue with the
      // tapped climb (committed, so the drawer renders it immediately) and expand to
      // the full ordered list once it loads.
      if (replaceQueueOnActivate) {
        const target = resolveTarget(climb);
        if (target) {
          const { queue, currentClimbQueueItem } = getQueueSnapshot();
          const futureQueueCount = countFutureQueueItems(queue, currentClimbQueueItem);
          if (futureQueueCount > 0) {
            replacementAbortRef.current?.abort();
            setPendingReplacement({ climb, futureQueueCount });
            return Promise.resolve();
          }
          const item = climbToQueueItem(schemaClimb);
          setQueue([item], item);
          openPlayDrawer(schemaClimb, { committedExternally: true });
          return replaceQueueWithPlaylist(climb, { previewQueueItem: item });
        }
      }

      const isAlreadyActive = activeClimbUuidRef.current === climb.uuid;
      const source = playlistSuggestionSourceRef.current;
      const suggestionsAlreadyFollowThisList =
        source?.playlistUuid === sourceId && source?.activatedClimbUuid === climb.uuid;

      // Pure reopen: the tapped climb is already active AND the drawer's
      // next/previous already follow THIS list anchored on it. Re-activating
      // would duplicate it in the queue and pointlessly rebuild the same source,
      // so just reopen — the drawer renders from currentClimbQueueItem
      // (committedExternally), which already points at this climb.
      if (isAlreadyActive && suggestionsAlreadyFollowThisList) {
        openPlayDrawer(schemaClimb, { committedExternally: true });
        return Promise.resolve();
      }

      // Otherwise activate. Pin a fresh queue item only for a genuinely new
      // activation, so the drawer's nav anchor and the appended queue entry share
      // one uuid. When the climb is already active (tapped from a different list),
      // queueApi refreshes the suggestion source in place instead of appending, so
      // there's nothing to pin — and pinning a stale item could be reused on the
      // next tap. The drawer opens first (same frame as the tap), then the shared
      // activation builds the suggestion source.
      if (!isAlreadyActive) {
        pendingQueueItemRef.current = climbToQueueItem(schemaClimb);
      }
      openPlayDrawer(schemaClimb, { committedExternally: true });
      return activate(climb).catch((error: unknown) => {
        console.error('Playlist climb activation failed:', error);
        reportHandledError(error, { tags: { source: 'playlist', op: 'activate-climb' } });
      });
    },
    [
      activate,
      allClimbs,
      getQueueSnapshot,
      openPlayDrawer,
      replaceQueueOnActivate,
      replaceQueueWithPlaylist,
      resolveTarget,
      setQueue,
      sourceId,
      viewOnlyBoard,
    ],
  );

  return useMemo(
    () => ({
      activate: activatePlaylistClimb,
      queueReplaceSheet: {
        visible: pendingReplacement !== null,
        futureQueueCount: pendingReplacement?.futureQueueCount ?? 0,
        isReplacing: isReplacingQueue,
        onCancel: cancelQueueReplacement,
        onConfirm: confirmQueueReplacement,
      },
    }),
    [activatePlaylistClimb, cancelQueueReplacement, confirmQueueReplacement, isReplacingQueue, pendingReplacement],
  );
}
