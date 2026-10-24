// Every list opens a climb the same way (issue #6665). Search and the playlists
// already went through `usePlaylistActivation`; this is the same hook for lists
// whose rows each carry their own board: a logbook, a session's ticks, a
// profile's climbs, a session card's hardest send.
//
// What a tap does, by the hook's rules:
// - The row is on another board model than the one the climber is at (or none
//   is picked): a preview on the row's board, the list as its track.
// - A crew is here, or "Light problems when tapping the list" is off: a preview
//   on the active board, the list as its track. The wall stays where it is.
// - Otherwise the climb goes up, inserted after the current climb and flagged
//   `suggested` like every list play, with the list as its track.
//
// The tapped row is drawn on its own board config, so a tick opens at the
// angle it was climbed at, as it always has. The drawer only keeps that
// override when it differs from the active board, and swipes along the track
// keep it.

import { useCallback, useMemo, useRef } from 'react';
import type { Climb as SchemaClimb } from '@boardsesh/shared-schema';
import type { Climb } from '@boardsesh/queue';
import { useIsSharedSession } from '../../providers/queue-provider';
import type { BoardConfig } from '../../providers/drawer-host-provider';
import { useActiveBoard } from '../graphql/use-active-board';
import { boardLooselyMatches } from '../boards/board-matches';
import { toQueueClimb } from '../climb-types';
import { getSetting } from '../../settings/hooks';
import type { ReadyBoardArtSnapshot } from '../board-render/ready-board-art';
import { usePlaylistActivation } from './use-playlist-activation';
import { createLoadedListFetchPage, type LoadedList, type LoadedListSource } from './loaded-list-pages';

/** What a list row plays. */
export type BoardListRow = {
  /** The climb, or null when the row carries nothing to draw (no frames). */
  climb: SchemaClimb | null;
  /** The board the row was climbed or set on, at the row's angle. Null when unknown. */
  board: BoardConfig | null;
};

export type UseBoardListActivationOptions<Row> = {
  /** Names this list's track, e.g. `logbook:<userId>`. */
  sourceId: string;
  /** What the player calls the list: "From {label}". Already translated. */
  label: string;
  /** The rows on screen, from the list's first, in order. */
  rows: readonly Row[];
  /** Read a row. Keep it stable (a module-level function). */
  describeRow: (row: Row) => BoardListRow;
  /** The screen's query has rows past these. */
  hasMore?: boolean;
  /**
   * Load the screen's next page; resolves with every row loaded after it.
   * Rejects when the page fails. Omit it for a list that is all loaded.
   */
  loadMore?: () => Promise<{ rows: readonly Row[]; hasMore: boolean }>;
  /**
   * Which list is on screen (its filters and sort). A track built under one
   * key stops paging once the screen shows another.
   */
  listKey?: string;
  /**
   * Opens a row that has no climb or board to draw, through its own route.
   * `preview` says whether the tap should look rather than put the climb up.
   */
  openFallback?: (row: Row, options: { preview: boolean }) => void;
};

/** A tap on a row: the climb opens, playing from this list. */
export type BoardListOpen<Row> = (row: Row, readyBoardArt?: ReadyBoardArtSnapshot) => void;

function climbBoardKey(climb: { uuid: string; angle: number }): string {
  return `${climb.uuid}|${climb.angle}`;
}

function listFromRows<Row>(
  rows: readonly Row[],
  describeRow: (row: Row) => BoardListRow,
  hasMore: boolean,
): LoadedList {
  const climbs: Climb[] = [];
  const seenClimbUuids = new Set<string>();
  for (const row of rows) {
    const { climb } = describeRow(row);
    // A track holds a climb once: the first row of it, the most recent in a
    // logbook. The other rows of it are the same climb to swipe onto.
    if (!climb || seenClimbUuids.has(climb.uuid)) continue;
    seenClimbUuids.add(climb.uuid);
    climbs.push(toQueueClimb(climb));
  }
  return { climbs, hasMore, loadedRows: rows.length };
}

export function useBoardListActivation<Row>({
  sourceId,
  label,
  rows,
  describeRow,
  hasMore = false,
  loadMore,
  listKey = '',
  openFallback,
}: UseBoardListActivationOptions<Row>): BoardListOpen<Row> {
  const isSharedSession = useIsSharedSession();
  const activeBoard = useActiveBoard().data ?? null;

  const list = useMemo(() => listFromRows(rows, describeRow, hasMore), [rows, describeRow, hasMore]);
  const listRef = useRef(list);
  listRef.current = list;
  const listKeyRef = useRef(listKey);
  listKeyRef.current = listKey;
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;

  // Read through refs, so a page landing does not rebuild the track's loader.
  const listSource = useMemo<LoadedListSource>(
    () => ({
      read: () => listRef.current,
      loadMore: async () => {
        const load = loadMoreRef.current;
        if (!load) return listRef.current;
        const loaded = await load();
        return listFromRows(loaded.rows, describeRow, loaded.hasMore);
      },
    }),
    [describeRow],
  );
  const fetchPage = useMemo(() => createLoadedListFetchPage(listSource), [listSource]);
  // Bound at the tap: a track keeps paging the list it was built from.
  const snapshotFetchPage = useCallback(() => {
    const builtUnderKey = listKeyRef.current;
    return createLoadedListFetchPage(listSource, () => listKeyRef.current === builtUnderKey);
  }, [listSource]);

  // The board of the row being tapped, set just before the activation reads
  // it. Only the tapped climb is drawn on a row's own board; the hook asks for
  // nothing else.
  const tappedBoardRef = useRef<{ key: string; board: BoardConfig } | null>(null);
  const boardForTappedClimb = useCallback((climb: Climb): BoardConfig | null => {
    const tapped = tappedBoardRef.current;
    return tapped && tapped.key === climbBoardKey(climb) ? tapped.board : null;
  }, []);
  const viewOnlyBoard = useCallback(
    (climb: Climb): BoardConfig | null => {
      const board = boardForTappedClimb(climb);
      if (!board) return null;
      if (!activeBoard) return board;
      return boardLooselyMatches(board, { boardName: activeBoard.boardType, layoutId: activeBoard.layoutId })
        ? null
        : board;
    },
    [activeBoard, boardForTappedClimb],
  );

  const activation = usePlaylistActivation({
    sourceId,
    allClimbs: list.climbs,
    fetchPage,
    snapshotFetchPage,
    label,
    viewOnlyBoard,
    drawerBoardFor: boardForTappedClimb,
    previewOnly: isSharedSession,
    loadedRowsAreTheList: true,
    hasMoreRows: list.hasMore,
    refreshErrorMessage: 'Failed to build the list track:',
  });

  // A stable tap handler, so a memoised row keeps its props as pages land.
  const activateRef = useRef(activation.activate);
  activateRef.current = activation.activate;
  const isSharedSessionRef = useRef(isSharedSession);
  isSharedSessionRef.current = isSharedSession;
  const openFallbackRef = useRef(openFallback);
  openFallbackRef.current = openFallback;

  return useCallback(
    (row: Row, readyBoardArt?: ReadyBoardArtSnapshot) => {
      const { climb, board } = describeRow(row);
      if (!climb || !board) {
        openFallbackRef.current?.(row, {
          preview: isSharedSessionRef.current || !getSetting('lightOnClimbTap'),
        });
        return;
      }
      tappedBoardRef.current = { key: climbBoardKey(climb), board };
      void activateRef.current(toQueueClimb(climb), readyBoardArt);
    },
    [describeRow],
  );
}
