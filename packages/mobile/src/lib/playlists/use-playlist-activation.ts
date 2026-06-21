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

import { useCallback, useMemo, useRef } from 'react';
import { usePlaylistClimbActivation, fetchPlaylistSuggestionClimbs } from '@boardsesh/playlists-react';
import { createPlaylistSuggestionSource, getQueueBoardKey, type Climb, type ClimbQueueItem } from '@boardsesh/queue';
import { useActiveClimbUuid, usePlaylistSuggestionSource, useQueueActions } from '../../providers/queue-provider';
import { useDrawerHost } from '../../providers/drawer-host-provider';
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
};

/** Returns an `activate(climb)` callback to wire onto a climb row tap. */
export function usePlaylistActivation({
  sourceId,
  allClimbs,
  fetchPage,
  viewOnlyBoard,
  refreshErrorMessage,
}: UsePlaylistActivationOptions): (climb: Climb) => Promise<void> {
  const { setCurrentClimb, setPlaylistSuggestionSource, refreshPlaylistSuggestionSource } = useQueueActions();
  const { openPlayDrawer } = useDrawerHost();
  const activeBoard = useActiveBoard().data ?? null;

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

  // Open the drawer immediately, then let the shared hook commit the climb. The
  // open and the synchronous setCurrentClimb dispatch land in the same React
  // batch, so the drawer (rendering from currentClimbQueueItem) paints the
  // activated climb on the first frame. `committedExternally` tells the drawer
  // the caller already dispatched, so it doesn't re-commit or treat this as a
  // preview.
  return useCallback(
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
    [activate, allClimbs, openPlayDrawer, sourceId, viewOnlyBoard],
  );
}
