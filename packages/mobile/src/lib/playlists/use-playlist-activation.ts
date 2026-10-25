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
// Playlists, For You lists and setter pages pass `honorPlaylistLoadSetting`. A tap
// on them plays from the list like any other list tap, unless the climber turned
// on "Tapping a playlist loads it into my queue" (F4, #6667). Then the tap (or
// the Play button) replaces the whole queue with the list (tapped climb active)
// so previous/next walk the circuit; with Light the board when I tap a climb
// off, a row tap is still a preview. Because a replace clears any future queue
// items, a three-way prompt warns first whenever the queue has items after the
// current: start the playlist (destructive), add it behind what's queued and
// play from it, or back out to a preview of the tapped climb.
//
// The same additive landing is available on its own, without a row tap, through
// `addToQueue.queue` — the playlist-detail Play next / Play last rows, which put
// the whole list at the top or the bottom of Up next (#6772).

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  usePlaylistClimbActivation,
  drainPlaylistPages,
  fetchPlaylistSuggestionClimbs,
  fetchPlaylistTrackPage,
  isAbortError,
  MAX_PLAYLIST_QUEUE_REPLACE_PAGES,
  PLAYLIST_SUGGESTION_REFRESH_PAGE_SIZE,
  type ActivationTrackLoad,
  type PlaylistDrainResult,
  type PlaylistDrainStopReason,
} from '@boardsesh/playlists-react';
import { isTransportNetworkError } from '@boardsesh/offline-sync/error-classification';
import { parseRateLimitError } from '@boardsesh/graphql-client';
import {
  createPlaylistSuggestionSource,
  preparePlaylistClimbs,
  getQueueBoardKey,
  MAX_SYNCED_QUEUE_ITEMS,
  clampQueueWindow,
  type Climb,
  type ClimbQueueItem,
  type QueueAddPlacement,
} from '@boardsesh/queue';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { canAddClimbToBoard } from '@boardsesh/board-config';
import { useQueueActions } from '../../providers/queue-provider';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useQueueSnackbar } from '../../providers/queue-snackbar-provider';
import { useChoose } from '../../providers/dialog-provider';
import { useToast } from '../../providers/toast-provider';
import { useActiveBoard } from '../graphql/use-active-board';
import { climbToQueueItem } from '../climb-to-queue-item';
import { reportHandledError } from '../error-reporting';
import { track } from '../analytics';
import { toSchemaClimb } from '../climb-types';
import { getPrivacyRevocationGeneration, subscribeToPrivacyRevocations } from '../privacy/privacy-cache';
import type { LoadedListTrackLoader } from './loaded-list-pages';
import { getSetting } from '../../settings/hooks';
import { getPlaylistRenderBoardTarget } from './playlist-climb-render-board';
import { registerPendingTrackLoader, registerTrackPageLoader, type TrackPageLoader } from './track-pager';
import { sourceIdForReports } from './playlist-view';
import type { ReadyBoardArtSnapshot } from '../board-render/ready-board-art';
import type { PlaylistRenderBoard } from './use-playlist-render-board';
import type { BoardConfig } from '../../providers/drawer-host-provider';

/** Which board-scoped fetch a canary report came from. */
type EmptyBoardFetchOp = 'replace-queue-empty' | 'append-queue-empty';

// Playlists whose board-scoped fetch has already been reported as empty this app
// session. `reportHandledError` has no dedup or rate limit of its own, and a
// climber poking at a broken playlist re-taps rows freely, so without this one
// bad playlist could ship hundreds of identical events.
//
// Keyed on `<op>|<sourceId>`, not the sourceId alone: the replace path and the
// append path fetch the same list through different call sites, and a single
// shared key would let whichever fired first silently swallow the other's
// canary for the rest of the session.
const reportedEmptyBoardFetches = new Set<string>();

// Which page failures the drain should try again, injected so the shared package
// keeps no dependency on `@boardsesh/offline-sync` (web does not have it).
// `isTransportNetworkError` is deliberately narrow — it matches the runtime's
// own hardcoded transport strings and errno codes, never a programmer bug — so a
// deterministic server verdict still fails on the first attempt.
const PLAYLIST_DRAIN_RETRY_POLICY = {
  isRetryable: isTransportNetworkError,
  parseRetryAfterSeconds: (error: unknown) => parseRateLimitError(error)?.retryAfterSeconds ?? null,
} as const;

/**
 * Clear the once-per-session canary bookkeeping. Test-only: the Set above is
 * module state that outlives an individual test, so without this a case that
 * reuses a sourceId would see zero reports and pass for the wrong reason.
 */
export function _resetEmptyBoardFetchReportsForTests(): void {
  reportedEmptyBoardFetches.clear();
}

/**
 * How many of the loaded climbs the active board could actually render.
 *
 * The canary below compares the board-scoped fetch against THIS, not against the
 * raw loaded count. The playlist detail list runs the resolver in all-boards mode
 * on purpose, so `allClimbs` also carries climbs on other board types, other
 * layouts, and climbs whose holds don't exist on the active size — a board-scoped
 * fetch dropping every one of those is correct behaviour, not a defect, and
 * reporting it would bury the signal the canary exists to give.
 *
 * `canAddClimbToBoard` is the same predicate the playlist rows use to decide
 * whether to dim a climb as incompatible, so "the list showed it as climbable
 * here" and "the board-scoped query should have returned it" stay in agreement.
 * Hold sets included: `getPlaylistRenderBoardTarget` hands the wall's `set_ids`
 * to the predicate, which is what keeps it matching the backend's
 * `required_set_ids <@ selected sets` containment on MoonBoard — whose render
 * data covers the whole grid whichever add-on sets are actually bolted on.
 */
function countClimbsThisBoardCanRender(climbs: Climb[], board: PlaylistRenderBoard): number {
  const target = getPlaylistRenderBoardTarget(board);
  let count = 0;
  for (const climb of climbs) {
    if (canAddClimbToBoard(climb, target).ok) count += 1;
  }
  return count;
}

/** A single page of the suggestion-refresh fetch. */
export type PlaylistActivationPage = {
  climbs: Climb[];
  hasMore: boolean;
  /**
   * How many climbs the list holds, when the query reports it. Counted by the
   * same query the pages come from, so it is the right total for the track.
   */
  totalCount?: number;
};

/** The board a page or count is fetched for. */
type ActivationFetchBoard = { boardName: string; layoutId: number; sizeId: number; setIds: string; angle: number };

/** Accept every climb: previews keep every loaded row, as they always have. */
const acceptEveryClimb = () => true;

/**
 * How long a list's count may run past its climbs. The count is asked for
 * beside the pages and only feeds the header's "4 of 23", so a slow one must
 * not hold up the track or the queue: once the climbs are in, it gets this
 * long, and after that the player names the list without a count.
 */
export const TRACK_COUNT_GRACE_MS = 1000;

/** What `pending` resolved to, or undefined if it took longer than `ms`. */
function settledWithin<Value>(pending: Promise<Value | undefined>, ms: number): Promise<Value | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    void pending.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

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
    board: ActivationFetchBoard;
    signal: AbortSignal;
  }) => Promise<PlaylistActivationPage>;
  /**
   * For a screen whose `fetchPage` reads state that a later tap can change
   * (search reads its frozen basis, which every row tap re-captures): return a
   * `fetchPage` bound to the list as it is now. A track's page loader keeps
   * that one, so its later pages walk the list it was built from. Omit it when
   * `fetchPage` already pages one fixed list.
   */
  snapshotFetchPage?: () => UsePlaylistActivationOptions['fetchPage'];
  /**
   * What the player calls this list while it walks it: "From {label} · 4 of 23"
   * (issue #6664). Already translated. Omit it and the player names nothing.
   */
  label?: string;
  /**
   * Count the list `fetchPage` pages, for a query whose pages carry no total
   * (search). Must count exactly that list, or the player's "4 of 23" is wrong.
   * Asked once per tap, alongside the first page; a failure only costs the count.
   */
  fetchTotal?: (args: { board: ActivationFetchBoard; signal: AbortSignal }) => Promise<number>;
  /**
   * When set, the tap is view-only: open the drawer against this board config
   * and keep playlist navigation local to the drawer without mutating the active
   * queue. A resolver can return the specific board for the tapped row, or null
   * when that row should activate normally.
   */
  viewOnlyBoard?: PlaylistRenderBoard | ViewOnlyBoardResolver | null;
  /**
   * When true, a tap is view-only on the ACTIVE board: the drawer opens on the
   * tapped climb with this list seeded as its swipe track, and the queue is not
   * touched until the climber puts a climb up from the commit row.
   *
   * Same landing as `viewOnlyBoard`, different reason — that one is "this climb
   * is on a board you're not on", this one is "there are other climbers in this
   * session, so a row tap must not take their wall". Read live at tap time, so a
   * crew forming or breaking up between render and tap is honoured.
   */
  previewOnly?: boolean;
  /**
   * The board config the player draws a tapped climb on when it stays on the
   * active board: a tick's own size and angle, so a send logged at 45° opens at
   * 45° as it always has. Handed to the drawer, which only keeps it when it
   * differs from the active board. Return null to draw on the active board.
   * A climb on another board model goes through `viewOnlyBoard` instead.
   */
  drawerBoardFor?: (climb: Climb) => BoardConfig | null;
  /**
   * The loaded rows are the list itself, from its first row (a logbook, a
   * session's ticks, a profile's climbs), and `fetchPage` pages that same list.
   * A tap then plays from the rows on screen without asking the server for the
   * list again, and the track carries on past them while `hasMoreRows` says
   * there is more: through `snapshotListLoader` from the first climb past the
   * rows when it is set, otherwise through `fetchPage` from the page the rows
   * end in.
   */
  loadedRowsAreTheList?: boolean;
  /** With `loadedRowsAreTheList`: the list has rows past the ones loaded. */
  hasMoreRows?: boolean;
  /**
   * With `loadedRowsAreTheList`: a loader bound to the list on screen now. A
   * track then walks the list by position instead of by `fetchPage`'s pages:
   * each request starts at the first climb not yet served and loads only a few
   * of the screen's pages, so a list whose pages add few climbs (a logbook of
   * projects) is never loaded in one go, and a short request skips nothing.
   */
  snapshotListLoader?: () => LoadedListTrackLoader;
  /**
   * The loaded rows are this list's own pages, from the top, for the board a
   * preview carries on with (search: the same frozen search on the active
   * board). A preview's track then asks for the page after the rows instead of
   * re-reading the ones it already has from the first page. Leave it off when
   * the rows come from a different query (a playlist's all-boards rows).
   */
  loadedRowsArePages?: boolean;
  /** Logged when the async suggestion refresh fails (non-abort). */
  refreshErrorMessage: string;
  /**
   * A playlist-kind list (a playlist, For You, a setter's page): with the
   * climber's "Tapping a playlist loads it into my queue" setting on, a tap
   * replaces the queue with the list instead of playing from it. The setting is
   * read at the tap. Off (the default), the tap plays from the list. Either way
   * "Light the board when I tap a climb" off makes a row tap a preview; the
   * Play button (`deliberate`) still plays or loads the list.
   */
  honorPlaylistLoadSetting?: boolean;
};

export type PlaylistAddToQueueState = {
  /**
   * Put every board-scoped climb in this playlist into Up next, in list order:
   * at the top for `'next'` (Play next), at the bottom for `'end'` (Play last).
   *
   * **Undefined when there is no active board.** The board-scoped fetch is built
   * from the active board, so with none it returns an empty list and the climber
   * would be told "nothing here for your board yet" when the truth is "you
   * haven't picked a board". Absent instead, so the rows simply aren't rendered.
   */
  queue?: (placement: QueueAddPlacement) => void;
  /** Which placement is in flight, or null. One list lands at a time. */
  pendingPlacement: QueueAddPlacement | null;
};

export type PlaylistActivationOptions = {
  /**
   * A deliberate play, not a row tap: the list header's Play button. "Light the board
   * when I tap a climb" is about row taps, so it does not turn this
   * into a preview. The crew rule still does.
   */
  deliberate?: boolean;
};

export type PlaylistActivationResult = {
  /** Callback to wire onto a climb row tap, or with `deliberate` the Play button. */
  activate: (climb: Climb, readyBoardArt?: ReadyBoardArtSnapshot, options?: PlaylistActivationOptions) => Promise<void>;
  /** Bulk additive queueing for the detail screen's Play next / Play last rows. */
  addToQueue: PlaylistAddToQueueState;
};

/** What the climber picked in the replace-or-append prompt. */
type QueueForkDecision = 'replace' | 'append' | 'cancel';

/** The five ways a bulk append can end, as reported to `PlaylistQueued`. */
type PlaylistQueuedOutcome = 'added' | 'addedPartial' | 'queueFull' | 'nothingToAdd' | 'failed';

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
  snapshotFetchPage,
  label,
  fetchTotal,
  viewOnlyBoard,
  previewOnly = false,
  drawerBoardFor,
  loadedRowsAreTheList = false,
  hasMoreRows = false,
  snapshotListLoader,
  loadedRowsArePages = false,
  refreshErrorMessage,
  honorPlaylistLoadSetting = false,
}: UsePlaylistActivationOptions): PlaylistActivationResult {
  const {
    setCurrentClimb,
    setPlaylistSuggestionSource,
    refreshPlaylistSuggestionSource,
    setQueue,
    getQueueSnapshot,
    appendQueueItems,
  } = useQueueActions();
  const { openPlayDrawer } = useDrawerHost();
  const { showQueueAddedSnackbar } = useQueueSnackbar();
  const { showToast } = useToast();
  const choose = useChoose();
  const { t } = useTranslation('playlists');
  const activeBoard = useActiveBoard().data ?? null;
  // Error reports name the playlist without its view: the view can carry a typed
  // name search, and the canary stays once per playlist rather than per sort.
  const reportSourceId = sourceIdForReports(sourceId);
  // Bumped at credential boundaries (sign-in, sign-out). Work started for one
  // account checks it after every await, so a late page, prompt answer or
  // callback cannot write that account's playlist into the next one's queue.
  const privacyGeneration = useSyncExternalStore(
    subscribeToPrivacyRevocations,
    getPrivacyRevocationGeneration,
    getPrivacyRevocationGeneration,
  );
  const loadedClimbsByUuid = useMemo(() => {
    const climbsByUuid = new Map<string, Climb>();
    for (const climb of allClimbs) {
      if (!climbsByUuid.has(climb.uuid)) climbsByUuid.set(climb.uuid, climb);
    }
    return climbsByUuid;
  }, [allClimbs]);
  const preparedPreviewClimbs = useMemo(() => preparePlaylistClimbs(allClimbs), [allClimbs]);

  const replacementAbortRef = useRef<AbortController | null>(null);
  const appendAbortRef = useRef<AbortController | null>(null);
  const [pendingPlacement, setPendingPlacement] = useState<QueueAddPlacement | null>(null);
  // Re-entrancy guard read synchronously: `pendingPlacement` only lands after a
  // render, so two taps inside one frame would both pass a state check and fire
  // two fetches (and two adds).
  const isAppendingRef = useRef(false);

  // Mirrored, not a dependency: `previewOnly` tracks whether anyone else is in
  // the session, and threading it through the callback's deps would churn the
  // identity of every climb row's onPress the moment a crew forms — for a value
  // the callback only needs at tap time.
  const previewOnlyRef = useRef(previewOnly);
  previewOnlyRef.current = previewOnly;
  // Same reason: a list that pages in flips this on every page.
  const hasMoreRowsRef = useRef(hasMoreRows);
  hasMoreRowsRef.current = hasMoreRows;

  // The climbs the screen has loaded, mirrored into a ref so the empty-fetch
  // canary below can read them without putting `allClimbs` in
  // `replaceQueueWithPlaylist`'s deps — that array's identity changes on every
  // page-in and would churn the whole activation callback chain.
  const loadedClimbsRef = useRef(allClimbs);
  loadedClimbsRef.current = allClimbs;

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
        if (privacyGeneration !== getPrivacyRevocationGeneration()) return null;
        const pendingItem = pendingQueueItemRef.current;
        pendingQueueItemRef.current = null;
        // The tapped climb is already the active climb (re-tapped from a list
        // whose suggestions don't yet follow it). Don't re-append it — that would
        // duplicate it in the queue and reset the pass. Just point the suggestion
        // source at the tapped list so the drawer's next/previous follow it; the
        // shared hook's async refresh then upgrades that source in place. Return a
        // non-null item so the hook treats activation as succeeded.
        if (getQueueSnapshot().currentClimbQueueItem?.climb.uuid === climb.uuid) {
          setPlaylistSuggestionSource(options?.playlistSuggestionSource ?? null);
          // Browse-origin: built here only as a fallback (no pinned item survived
          // to this dispatch), so flag it suggested like every other list tap —
          // the reducer's suggested-after-current prune drops it once the
          // climber opens a climb from a different list.
          return pendingItem ?? climbToQueueItem(toSchemaClimb(climb), { suggested: true });
        }
        const item =
          pendingItem && pendingItem.climb.uuid === climb.uuid
            ? pendingItem
            : // Same fallback case as above: no pinned item, so this tap is
              // flagged browse-origin too.
              climbToQueueItem(toSchemaClimb(climb), { suggested: true });
        // Commit synchronously: the drawer now renders from currentClimbQueueItem
        // (no preview render-ahead), so this dispatch must land in the same batch
        // as the open — under startTransition it would defer and the drawer would
        // paint a stale first frame.
        setCurrentClimb(item, options);
        return item;
      },
      refreshPlaylistSuggestionSource: (source: Parameters<typeof refreshPlaylistSuggestionSource>[0]) => {
        if (privacyGeneration !== getPrivacyRevocationGeneration()) return false;
        return refreshPlaylistSuggestionSource(source);
      },
    }),
    [
      getQueueSnapshot,
      setCurrentClimb,
      setPlaylistSuggestionSource,
      refreshPlaylistSuggestionSource,
      privacyGeneration,
    ],
  );

  // Built once per active board, not per climb: `canAddClimbToBoard` caches its
  // valid-hold-id Set against the target OBJECT, so a fresh target per call
  // would rebuild that Set for every climb in the feed.
  const activeBoardTarget = useMemo(
    () =>
      activeBoard
        ? getPlaylistRenderBoardTarget({
            boardName: activeBoard.boardType,
            layoutId: activeBoard.layoutId,
            sizeId: activeBoard.sizeId,
            setIds: activeBoard.setIds,
            angle: activeBoard.angle,
          })
        : null,
    [activeBoard],
  );

  const activationTarget = useMemo(() => {
    if (!activeBoard || !activeBoardTarget) return null;
    return {
      boardKey: getQueueBoardKey({
        board_name: activeBoard.boardType,
        layout_id: activeBoard.layoutId,
        size_id: activeBoard.sizeId,
        set_ids: activeBoard.setIds,
      }),
      boardName: activeBoard.boardType,
      angle: activeBoard.angle,
      // Keep climbs this board cannot draw out of the swipe order. The
      // playlist-detail screens run the resolver in all-boards mode on
      // purpose, so `allClimbs` — which seeds the synchronous source before
      // the board-scoped refresh lands — carries other board types, other
      // layouts and climbs whose holds don't exist on this size.
      //
      // `canAddClimbToBoard`, not identity matching: identity can't see the
      // two cases that render plausibly while lighting the wrong holds —
      // Woods numbers each size's holds from its own origin (so an 8x10
      // climb's ids all exist on a 12x12 as different holds) and MoonBoard's
      // render data covers the whole grid whichever add-on sets are bolted
      // on. It is the same predicate the playlist rows dim on and the row
      // render board resolves through, so what you see, what you swipe to and
      // what lights up stay one answer. Missing hold data fails open.
      isClimbable: (candidate: Climb) => canAddClimbToBoard(candidate, activeBoardTarget).ok,
    };
  }, [activeBoard, activeBoardTarget]);
  const resolveTarget = useCallback((_climb: Climb) => activationTarget, [activationTarget]);
  const preparedCompatibleClimbs = useMemo(
    () => (activationTarget ? preparePlaylistClimbs(allClimbs, activationTarget.isClimbable) : undefined),
    [allClimbs, activationTarget],
  );

  // The list's count, when the screen has a separate query for it. Never fails
  // the track: without it the player names the list and leaves the count off.
  const fetchTotalSafely = useCallback(
    async (board: ActivationFetchBoard, signal: AbortSignal): Promise<number | undefined> => {
      if (!fetchTotal) return undefined;
      try {
        const total = await fetchTotal({ board, signal });
        return Number.isInteger(total) && total >= 0 ? total : undefined;
      } catch (error) {
        if (!signal.aborted && !isAbortError(error)) console.warn('Counting the swipe track failed:', error);
        return undefined;
      }
    },
    [fetchTotal],
  );

  /**
   * A page loader for one track, registered with the player's pager so the track
   * keeps going past what is loaded (issue #6664). Pages are run through the
   * track's own filter; `filteredOut` tells the track its count no longer fits.
   */
  const registerPageLoader = useCallback(
    (board: ActivationFetchBoard, isClimbable: (climb: Climb) => boolean): string => {
      // Bound now, at the tap that built the track, not when a page is asked for.
      const listLoader = snapshotListLoader?.();
      if (listLoader) {
        // By position: the continuation's `nextPage` is the list position to
        // start at, so each "page" is one climb wide.
        return registerTrackPageLoader(async (offset, signal) => {
          const load = await listLoader({ offset, count: PLAYLIST_SUGGESTION_REFRESH_PAGE_SIZE, signal });
          const climbs = load.climbs.filter(isClimbable);
          return {
            page: offset,
            pageSize: 1,
            climbs,
            filteredOut: climbs.length !== load.climbs.length,
            nextPage: load.nextOffset,
          };
        });
      }
      const trackFetchPage = snapshotFetchPage?.() ?? fetchPage;
      const loadPage: TrackPageLoader = async (page, signal) => {
        const load = await fetchPlaylistTrackPage({
          page,
          signal,
          fetchPage: ({ page: pageIndex, pageSize, signal: pageSignal }) =>
            trackFetchPage({ page: pageIndex, pageSize, board, signal: pageSignal }),
          ...PLAYLIST_DRAIN_RETRY_POLICY,
        });
        const climbs = load.climbs.filter(isClimbable);
        return {
          page,
          pageSize: PLAYLIST_SUGGESTION_REFRESH_PAGE_SIZE,
          climbs,
          // Either breaks the one-for-one mapping a count needs.
          filteredOut: climbs.length !== load.climbs.length || load.cappedBeforeListEnd,
          nextPage: load.nextPage,
          ...(load.totalCount === undefined ? {} : { total: load.totalCount }),
        };
      };
      return registerTrackPageLoader(loadPage);
    },
    [fetchPage, snapshotFetchPage, snapshotListLoader],
  );

  /** Where a track over the loaded rows carries on: past the last loaded climb. */
  const continuationAfterLoadedRows = useCallback(
    (loadedClimbCount: number) =>
      snapshotListLoader ? loadedClimbCount : Math.floor(loadedClimbCount / PLAYLIST_SUGGESTION_REFRESH_PAGE_SIZE),
    [snapshotListLoader],
  );

  const fetchClimbsForBoard = useCallback(
    async ({
      activatedClimbUuid,
      signal,
      target,
    }: {
      activatedClimbUuid: string;
      signal: AbortSignal;
      target: { isClimbable: (climb: Climb) => boolean };
    }): Promise<ActivationTrackLoad> => {
      if (!activeBoard) return { climbs: [] };
      const board = {
        boardName: activeBoard.boardType,
        layoutId: activeBoard.layoutId,
        sizeId: activeBoard.sizeId,
        setIds: activeBoard.setIds,
        angle: activeBoard.angle,
      };
      // The rows on screen are the list from its top, so the first load is
      // already in hand: play from them, and page on from where they end.
      if (loadedRowsAreTheList) {
        const loadedClimbs = loadedClimbsRef.current;
        return {
          climbs: loadedClimbs,
          ...(hasMoreRowsRef.current
            ? {
                continuation: {
                  loaderId: registerPageLoader(board, target.isClimbable),
                  nextPage: continuationAfterLoadedRows(loadedClimbs.length),
                },
              }
            : {}),
        };
      }
      const countedTotal = fetchTotalSafely(board, signal);
      const load = await fetchPlaylistSuggestionClimbs({
        activatedClimbUuid,
        signal,
        fetchPage: ({ page, pageSize, signal: pageSignal }) => fetchPage({ page, pageSize, board, signal: pageSignal }),
        ...PLAYLIST_DRAIN_RETRY_POLICY,
      });
      const total =
        load.droppedDuplicates || signal.aborted
          ? undefined
          : (load.total ?? (await settledWithin(countedTotal, TRACK_COUNT_GRACE_MS)));
      return {
        climbs: load.climbs,
        ...(total === undefined ? {} : { total }),
        ...(load.nextPage === null
          ? {}
          : {
              continuation: {
                loaderId: registerPageLoader(board, target.isClimbable),
                nextPage: load.nextPage,
              },
            }),
      };
    },
    [activeBoard, continuationAfterLoadedRows, fetchPage, fetchTotalSafely, loadedRowsAreTheList, registerPageLoader],
  );

  const fetchAllClimbsForBoard = useCallback(
    async ({ signal, limit }: { signal: AbortSignal; limit?: number }): Promise<PlaylistDrainResult> => {
      if (!activeBoard) return { climbs: [], stopReason: 'complete', pagesFetched: 0 };
      const board = {
        boardName: activeBoard.boardType,
        layoutId: activeBoard.layoutId,
        sizeId: activeBoard.sizeId,
        setIds: activeBoard.setIds,
        angle: activeBoard.angle,
      };
      let drainedCount = 0;
      const drainResult = await drainPlaylistPages({
        signal,
        pageSize: PLAYLIST_SUGGESTION_REFRESH_PAGE_SIZE,
        maxPages: MAX_PLAYLIST_QUEUE_REPLACE_PAGES,
        fetchPage: ({ page, pageSize, signal: pageSignal }) => fetchPage({ page, pageSize, board, signal: pageSignal }),
        ...(limit === undefined
          ? {}
          : {
              stopAfterPage: (newClimbs: Climb[]) => {
                drainedCount += newClimbs.length;
                return drainedCount >= limit;
              },
            }),
        ...PLAYLIST_DRAIN_RETRY_POLICY,
      });
      return limit === undefined ? drainResult : { ...drainResult, climbs: drainResult.climbs.slice(0, limit) };
    },
    [activeBoard, fetchPage],
  );

  /**
   * Canary. A board-scoped fetch that comes back empty for a playlist the detail
   * list has already rendered climbable rows for degrades into something
   * perfectly plausible — a one-item queue on the replace path, a "nothing here"
   * toast on the append path — with no error anywhere, which is exactly how
   * #3891's MoonBoard size filter stayed invisible for months. Sentry-only, once
   * per playlist per op per session, so the next instance of that class pages us
   * instead of a user. Gated on climbs this board CAN render, so a playlist full
   * of off-board climbs (legitimately empty here) stays silent.
   */
  const reportEmptyBoardFetchOnce = useCallback(
    (op: EmptyBoardFetchOp) => {
      if (!activeBoard) return;
      const reportKey = `${op}|${reportSourceId}`;
      if (reportedEmptyBoardFetches.has(reportKey)) return;
      const renderableCount = countClimbsThisBoardCanRender(loadedClimbsRef.current, {
        boardName: activeBoard.boardType,
        layoutId: activeBoard.layoutId,
        sizeId: activeBoard.sizeId,
        setIds: activeBoard.setIds,
        angle: activeBoard.angle,
      });
      if (renderableCount === 0) return;
      reportedEmptyBoardFetches.add(reportKey);
      reportHandledError(new Error('Playlist board-scoped fetch returned no climbs'), {
        tags: { source: 'playlist', op },
        extra: { sourceId: reportSourceId, renderableCount, loadedCount: loadedClimbsRef.current.length },
      });
    },
    [activeBoard, reportSourceId],
  );

  useEffect(() => {
    const unsubscribe = subscribeToPrivacyRevocations(() => {
      replacementAbortRef.current?.abort();
      appendAbortRef.current?.abort();
      pendingQueueItemRef.current = null;
      loadedClimbsRef.current = [];
    });
    return () => {
      unsubscribe();
      replacementAbortRef.current?.abort();
      appendAbortRef.current?.abort();
    };
  }, []);

  // The first track is the rows on screen while the rest of the list loads.
  // Marked as still loading, so the player doesn't call the last row the end.
  const pendingContinuation = useCallback(
    (refreshSettled: Promise<boolean>) => ({ loaderId: registerPendingTrackLoader(refreshSettled), nextPage: 0 }),
    [],
  );

  const activate = usePlaylistClimbActivation({
    queueApi,
    sourceId,
    allClimbs,
    preparedClimbs: preparedCompatibleClimbs,
    resolveTarget,
    fetchClimbsForBoard,
    label,
    pendingContinuation,
    // onActivated is intentionally omitted — the drawer is opened in the
    // returned callback BEFORE activate() runs, so the BottomSheet animation
    // starts on the same frame as the tap with no state-update work in between.
    refreshErrorMessage,
  });

  /**
   * The three-way fork behind a destructive playlist start: keep the queue and
   * start the playlist anyway, add the playlist behind what's already queued, or
   * back out. Raised through `useChoose()` — the same imperative prompt the
   * cross-board queue-add gate uses — so it renders as a native iOS action sheet
   * on Liquid Glass and an M3 dialog on Material, both of which already handle
   * three long localised labels and the 44 dp tap-target floor.
   *
   * Loops on `replace` when the queue grew while the prompt was open, so the
   * climber never clears items they haven't seen counted.
   */
  const promptQueueFork = useCallback(
    async (futureQueueCount: number): Promise<QueueForkDecision> => {
      if (privacyGeneration !== getPrivacyRevocationGeneration()) return 'cancel';
      let warnedCount = futureQueueCount;
      for (;;) {
        const picked = await choose<QueueForkDecision>({
          title: t('detail.queueReplace.title'),
          message: t('detail.queueReplace.message', { count: warnedCount }),
          options: [
            // Destructive first: the climber tapped play, and we don't hijack
            // that tap by demoting what they asked for.
            { value: 'replace', label: t('detail.queueReplace.confirm'), destructive: true },
            { value: 'append', label: t('detail.queueReplace.addInstead') },
            { value: 'cancel', label: t('detail.queueReplace.cancel'), cancel: true },
          ],
          cancelValue: 'cancel',
        });
        if (privacyGeneration !== getPrivacyRevocationGeneration()) return 'cancel';
        if (picked !== 'replace') return picked;
        const { queue, currentClimbQueueItem } = getQueueSnapshot();
        const latestFutureQueueCount = countFutureQueueItems(queue, currentClimbQueueItem);
        if (latestFutureQueueCount <= warnedCount) return 'replace';
        warnedCount = latestFutureQueueCount;
      }
    },
    [choose, getQueueSnapshot, t, privacyGeneration],
  );

  /**
   * Put every board-scoped climb in this playlist into Up next, in list order:
   * at the bottom (`placement: 'end'`, Play last) or at the top, right behind
   * the climb on the wall (`'next'`, Play next). Nothing is cleared and the
   * current climb never moves, so there is no confirmation on the way in, only
   * a count and the placement on the way out. Both placements share the cap
   * and every outcome toast: what differs is where the batch lands.
   *
   * `loadedClimbs` short-circuits the fetch for the replace prompt's Play last
   * branch, which already has the board-scoped list in hand.
   */
  const queuePlaylistClimbs = useCallback(
    async ({
      loadedClimbs,
      drainStopReason: loadedDrainStopReason,
      entryPoint,
      placement = 'end',
      excludeClimbUuid,
    }: {
      loadedClimbs?: Climb[];
      drainStopReason?: PlaylistDrainStopReason;
      entryPoint: 'listHeader' | 'replacePrompt';
      /** Where the list lands in Up next. The replace prompt only offers `'end'`. */
      placement?: QueueAddPlacement;
      /**
       * A climb of this list that is going into the queue by another way (the
       * prompt plays the tapped climb after the current one). It is left out of
       * the batch so it is queued once, and counted as landed.
       */
      excludeClimbUuid?: string;
    }) => {
      if (!activeBoard || privacyGeneration !== getPrivacyRevocationGeneration()) return;
      if (isAppendingRef.current) {
        // The row swallows its own press while appending (and shows a spinner),
        // so reaching this from `listHeader` means a double tap inside one frame
        // — nothing to say. From the prompt it is a deliberate pick that would
        // otherwise do nothing at all, so say what is already happening: the
        // in-flight append is landing this same playlist.
        if (entryPoint === 'replacePrompt') showToast(t('detail.addToQueue.alreadyAdding'), 'info');
        return;
      }
      isAppendingRef.current = true;
      const abortController = new AbortController();
      appendAbortRef.current = abortController;
      setPendingPlacement(placement);
      // Every outcome is instrumented, including the two that return before an
      // append is even attempted — otherwise `queueFull` (the branch that
      // actually fires when the queue is at the cap) and `nothingToAdd` would be
      // unmeasurable, and the counts alone couldn't tell them apart.
      const trackQueued = (outcome: PlaylistQueuedOutcome, fetchedCount: number, appendedCount: number) => {
        track(SHARED_EVENTS.PlaylistQueued, {
          // `sourceId` is `playlist:<uuid>` or `smart:<type>:<userId>`. Only the
          // prefix is safe to ship — the smart form carries a user id — and an
          // explicit test keeps the property to the union `events.ts` documents
          // instead of whatever a future id format happens to start with.
          sourceKind: sourceId.startsWith('smart:') ? 'smart' : 'playlist',
          entryPoint,
          placement,
          outcome,
          fetchedCount,
          appendedCount,
          boardName: activeBoard.boardType,
          layoutId: activeBoard.layoutId,
          angle: activeBoard.angle,
        });
      };

      try {
        const remainingCapacity = MAX_SYNCED_QUEUE_ITEMS - getQueueSnapshot().queue.length;
        if (remainingCapacity <= 0) {
          trackQueued('queueFull', 0, 0);
          showToast(t('detail.addToQueue.queueFull', { max: MAX_SYNCED_QUEUE_ITEMS }), 'error');
          return;
        }
        let fetchedClimbs = loadedClimbs;
        let drainStopReason = loadedDrainStopReason ?? null;
        let pagesFetched = 0;
        if (!fetchedClimbs) {
          const drainResult = await fetchAllClimbsForBoard({
            signal: abortController.signal,
            limit: remainingCapacity,
          });
          fetchedClimbs = drainResult.climbs;
          drainStopReason = drainResult.stopReason;
          pagesFetched = drainResult.pagesFetched;
          if (drainStopReason === 'page-cap' || drainStopReason === 'no-progress') {
            reportHandledError(new Error(`Playlist drain stopped early: ${drainStopReason}`), {
              tags: { source: 'playlist', op: `append-queue-${drainStopReason}` },
              extra: { sourceId: reportSourceId, pagesFetched, climbCount: fetchedClimbs.length },
            });
          }
        }
        if (abortController.signal.aborted || privacyGeneration !== getPrivacyRevocationGeneration()) return;

        if (fetchedClimbs.length === 0 && (drainStopReason === null || drainStopReason === 'complete')) {
          reportEmptyBoardFetchOnce('append-queue-empty');
        }
        // An excluded climb was queued before the append, so an empty list still
        // has something to confirm.
        if (fetchedClimbs.length === 0 && !excludeClimbUuid) {
          trackQueued('nothingToAdd', 0, 0);
          showToast(t('detail.addToQueue.nothingToAdd'), 'info');
          return;
        }

        // A whole-list Play next from the header puts the list right behind the
        // climb on the wall. When that climb is on the list, a second copy of it
        // would be the first thing up next, so it stays out and counts as
        // landed, the same as the prompt's excluded climb.
        const isHeaderPlayNext = entryPoint === 'listHeader' && placement === 'next';
        const wallClimbUuid = isHeaderPlayNext ? getQueueSnapshot().currentClimbQueueItem?.climb?.uuid : undefined;
        const skippedClimbUuid =
          excludeClimbUuid ??
          (wallClimbUuid && fetchedClimbs.some((climb) => climb.uuid === wallClimbUuid) ? wallClimbUuid : undefined);

        // Dedupe by uuid before building queue items: paging an ordered list that
        // is being edited underneath can hand the same climb back on two pages.
        // Same rule `buildPlaylistQueue` applies to the replace path.
        const seenClimbUuids = new Set<string>();
        const queueItems: ClimbQueueItem[] = [];
        for (const climb of fetchedClimbs) {
          if (seenClimbUuids.has(climb.uuid)) continue;
          seenClimbUuids.add(climb.uuid);
          if (climb.uuid === skippedClimbUuid) continue;
          queueItems.push(climbToQueueItem(toSchemaClimb(climb)));
        }

        // The skipped climb is in the queue already, so it counts as landed,
        // even when the list no longer holds it (it was removed between the tap
        // and the fetch). Otherwise a full batch would read as `queueFull`.
        const excludedCount = skippedClimbUuid ? 1 : 0;
        // The append keeps the bare call: `'end'` is the provider's default.
        const batchAppendedCount =
          queueItems.length === 0
            ? 0
            : placement === 'next'
              ? appendQueueItems(queueItems, { placement: 'next' })
              : appendQueueItems(queueItems);
        // Walking this list's track, swipes would keep peeking the list from the
        // wall climb on, and the copies just placed at the head of Up next would
        // only play after the end card. Drop the track so swipes walk the queue,
        // which now holds the list in order. The prompt's Play last does the
        // same. Only this list's track: a climber on another list keeps theirs.
        if (
          isHeaderPlayNext &&
          batchAppendedCount > 0 &&
          getQueueSnapshot().playlistSuggestionSource?.playlistUuid === sourceId
        ) {
          setPlaylistSuggestionSource(null);
        }
        const listCount = queueItems.length + excludedCount;
        const appendedCount = batchAppendedCount + excludedCount;
        trackQueued(
          appendedCount === 0 ? 'queueFull' : appendedCount < listCount ? 'addedPartial' : 'added',
          listCount,
          appendedCount,
        );

        // Nothing fit: the queue was already at the wire cap. That is an error
        // outcome with nothing to open, so it takes the toast, not the snackbar.
        if (appendedCount === 0) {
          showToast(t('detail.addToQueue.queueFull', { max: MAX_SYNCED_QUEUE_ITEMS }), 'error');
          return;
        }

        // Climbs landed in the queue, so this is the queue-added snackbar — the
        // one confirmation in the app whose "Open" takes you to the result —
        // fired ONCE for the whole batch (the bulk append bypasses
        // `commitQueueAdd`, which is what fires it for a single add).
        //
        // The count is what actually landed, not what was fetched, so a batch
        // clamped at the wire cap confirms the honest number. The kind names
        // where it landed: "Playing next" or "Playing last".
        showQueueAddedSnackbar({ kind: placement === 'next' ? 'playNext' : 'added', count: appendedCount });
      } catch (error) {
        if (
          abortController.signal.aborted ||
          privacyGeneration !== getPrivacyRevocationGeneration() ||
          isAbortError(error)
        )
          return;
        console.error('Playlist queue append failed:', error);
        reportHandledError(error, { tags: { source: 'playlist', op: 'append-queue' } });
        trackQueued('failed', 0, 0);
        showToast(t('detail.addToQueue.failed'), 'error');
      } finally {
        if (appendAbortRef.current === abortController) {
          appendAbortRef.current = null;
        }
        isAppendingRef.current = false;
        setPendingPlacement(null);
      }
    },
    [
      activeBoard,
      appendQueueItems,
      fetchAllClimbsForBoard,
      getQueueSnapshot,
      reportEmptyBoardFetchOnce,
      setPlaylistSuggestionSource,
      showQueueAddedSnackbar,
      showToast,
      sourceId,
      reportSourceId,
      t,
      privacyGeneration,
    ],
  );

  const replaceQueueWithPlaylist = useCallback(
    async (
      climb: Climb,
      options: {
        allowClearingManualFuture?: boolean;
        previewQueueItem?: ClimbQueueItem | null;
        /**
         * Told how it ended, once: true when the loaded playlist's track is in
         * place, false for every other ending (failed, cancelled, skipped).
         */
        onSettled?: (trackReplaced: boolean) => void;
      } = {},
    ) => {
      if (privacyGeneration !== getPrivacyRevocationGeneration()) {
        options.onSettled?.(false);
        return;
      }
      replacementAbortRef.current?.abort();
      const abortController = new AbortController();
      replacementAbortRef.current = abortController;
      // The climb the climber is on as the load starts: the seeded tap's item, or
      // whatever was current when they confirmed the prompt. Compared after the
      // load to tell "still here" from "moved on while it loaded" (#6670).
      const currentAtStartUuid =
        options.previewQueueItem?.uuid ?? getQueueSnapshot().currentClimbQueueItem?.uuid ?? null;
      let trackReplaced = false;
      // Read by the catch block so a failed drain reports how far it got.
      let drainStopReason: PlaylistDrainStopReason | null = null;
      let drainPagesFetched = 0;
      try {
        const drainBoard = activeBoard
          ? {
              boardName: activeBoard.boardType,
              layoutId: activeBoard.layoutId,
              sizeId: activeBoard.sizeId,
              setIds: activeBoard.setIds,
              angle: activeBoard.angle,
            }
          : null;
        const countedTotal: Promise<number | undefined> = drainBoard
          ? fetchTotalSafely(drainBoard, abortController.signal)
          : Promise.resolve(undefined);
        // The whole list, up to MAX_PLAYLIST_QUEUE_REPLACE_PAGES: the track
        // below is built from all of it. Only the queue is windowed (#6673).
        const drainResult = await fetchAllClimbsForBoard({ signal: abortController.signal });
        const climbs = drainResult.climbs;
        drainStopReason = drainResult.stopReason;
        drainPagesFetched = drainResult.pagesFetched;
        const listTotal =
          drainResult.droppedDuplicates || abortController.signal.aborted
            ? undefined
            : (drainResult.totalCount ?? (await settledWithin(countedTotal, TRACK_COUNT_GRACE_MS)));
        if (abortController.signal.aborted || privacyGeneration !== getPrivacyRevocationGeneration()) return;
        if (drainStopReason === 'page-cap' || drainStopReason === 'no-progress') {
          reportHandledError(new Error(`Playlist drain stopped early: ${drainStopReason}`), {
            tags: { source: 'playlist', op: `replace-queue-${drainStopReason}` },
            extra: { sourceId: reportSourceId, pagesFetched: drainPagesFetched, climbCount: climbs.length },
          });
        }
        if (climbs.length === 0 && drainStopReason === 'complete') {
          reportEmptyBoardFetchOnce('replace-queue-empty');
        }
        // Re-check live queue state after the async load: new future items may
        // have landed while the ordered list streamed in, and replacement still
        // clears them — so fork instead of clearing silently. Skipped once the
        // user has already answered the fork (allowClearingManualFuture).
        const { queue: latestQueue, currentClimbQueueItem: latestCurrent } = getQueueSnapshot();
        const latestFutureQueueCount = countFutureQueueItems(latestQueue, latestCurrent);
        if (!options.allowClearingManualFuture && latestFutureQueueCount > 0) {
          const decision = await promptQueueFork(latestFutureQueueCount);
          // The prompt is modal, so nothing in the UI can abort underneath it —
          // but an unmount can, and the old sheet flow could not reach this at
          // all. Don't replace a queue on behalf of a screen that is gone.
          if (abortController.signal.aborted || privacyGeneration !== getPrivacyRevocationGeneration()) return;
          if (decision === 'cancel') return;
          if (decision === 'append') {
            // The board-scoped list is already in hand — no second round trip.
            // A seeded tap already put the tapped climb in the queue, so while
            // that item is still there the batch leaves the climb out and
            // counts it as landed, the same as the first prompt's Play last.
            const seedItemUuid = options.previewQueueItem?.uuid;
            const { queue: queueAtAnswer, playlistSuggestionSource: trackAtAnswer } = getQueueSnapshot();
            const seedStillQueued =
              seedItemUuid !== undefined && queueAtAnswer.some(({ uuid }) => uuid === seedItemUuid);
            // The seed's track walks the list, and the list now sits behind the
            // climbs that landed during the load, not beside the seed. Swipes
            // would queue a second copy of each list climb, so they walk the
            // queue instead, as after the first prompt's Play last. Only this
            // list's track: a climber who moved to another list keeps theirs.
            if (trackAtAnswer?.playlistUuid === sourceId) setPlaylistSuggestionSource(null);
            await queuePlaylistClimbs({
              loadedClimbs: climbs,
              drainStopReason,
              entryPoint: 'replacePrompt',
              excludeClimbUuid: seedStillQueued ? climb.uuid : undefined,
            });
            return;
          }
        }
        // The climber may have moved while the list loaded (#6670): swiped on
        // from the tapped climb, or left for another list. Replacing around the
        // tapped climb would snap them back to it.
        //
        // Still on this list (a swipe along its track, or a queue entry that is
        // one of its climbs): load the whole playlist around the climb they are
        // on. The queue, the track and the screen then agree, the replace still
        // does what "Start playlist" said, and nothing on screen or on the wall
        // moves. Anywhere else they picked something after the tap, and the
        // replace would undo it, so it is skipped.
        const { currentClimbQueueItem: liveCurrent, playlistSuggestionSource: liveTrack } = getQueueSnapshot();
        let landingClimb = climb;
        let landingItem = options.previewQueueItem;
        if ((liveCurrent?.uuid ?? null) !== currentAtStartUuid) {
          const liveClimbUuid = liveCurrent?.climb.uuid;
          const liveClimbInList = liveClimbUuid ? climbs.find(({ uuid }) => uuid === liveClimbUuid) : undefined;
          if (!liveCurrent || !liveClimbInList || (liveTrack && liveTrack.playlistUuid !== sourceId)) return;
          landingClimb = liveClimbInList;
          landingItem = liveCurrent;
        }
        // The circuit IS the queue now, and the player still plays from the
        // playlist: the queue and the track are the same climbs in the same
        // order, both only the ones this board can draw (#6664). A list fetched
        // by board name alone (the smart lists) also carries other layouts and
        // sizes. Queued, they sat between the list's climbs where the track
        // (and the provider's board filter) left them out, so a swipe could not
        // find the next climb beside the current one and queued a copy of it.
        // The climb the climber is on stays wherever it is.
        const isClimbableHere = activationTarget?.isClimbable;
        const boardClimbs = isClimbableHere
          ? climbs.filter((candidate) => candidate.uuid === landingClimb.uuid || isClimbableHere(candidate))
          : climbs;
        // At most MAX_SYNCED_QUEUE_ITEMS of them (#6673): `Mutation.setQueue`
        // throws on a longer payload. The window keeps the climb the climber is
        // on and the climbs after it, filling from before it near the list's end.
        const { queue: playlistQueue, currentItem } = buildPlaylistQueue(boardClimbs, landingClimb, landingItem);
        const queue = clampQueueWindow(playlistQueue, playlistQueue.indexOf(currentItem));
        setQueue(queue, currentItem);
        // Cut short by the window: say what fit. A count of the whole list only
        // when it is known.
        if (queue.length < playlistQueue.length) {
          const knownTotal = drainStopReason === 'complete' ? playlistQueue.length : listTotal;
          showToast(
            knownTotal !== undefined && knownTotal > queue.length
              ? t('detail.queueReplace.trimmed', {
                  loaded: queue.length,
                  total: knownTotal,
                  max: MAX_SYNCED_QUEUE_ITEMS,
                })
              : t('detail.queueReplace.trimmedUnknownTotal', { loaded: queue.length, max: MAX_SYNCED_QUEUE_ITEMS }),
            'info',
          );
        }
        // Named after the list (#6664). It replaces whatever track came before,
        // so a climb that sits in both an older list and this playlist cannot
        // steer swipes into the older one. Built from the whole list with the
        // same filter, so a count that the filter makes wrong is dropped.
        //
        // Only from a climb this board can draw. The provider masks the track
        // down to this board and re-anchors a current climb the mask drops at
        // the head of what is left, so the first swipe would walk from the
        // list's first climb and queue a copy of every climb before the tapped
        // one. Without a track the swipes walk the queue, which holds the same
        // climbs in the same order.
        //
        // The track is the drained list, not the queue window: on a list longer
        // than the queue it keeps its own count and runs past the window (#6673).
        const track =
          activationTarget && activationTarget.isClimbable(landingClimb)
            ? createPlaylistSuggestionSource({
                playlistUuid: sourceId,
                activatedClimb: landingClimb,
                climbs,
                boardKey: activationTarget.boardKey,
                isClimbable: activationTarget.isClimbable,
                label,
                total: listTotal,
              })
            : null;
        setPlaylistSuggestionSource(track);
        trackReplaced = track !== null;
        // The activate path already opened the drawer (committedExternally) on the
        // seed queue; the confirm path opens it now that the climb is current.
        if (!options.previewQueueItem) {
          openPlayDrawer(toSchemaClimb(landingClimb), { committedExternally: true });
        }
      } catch (error) {
        // Ask the signal, not the error's `name` — see the drain's own catch.
        // A runtime whose abort does not carry `name: 'AbortError'` would
        // otherwise toast the climber for a cancellation they requested.
        if (
          abortController.signal.aborted ||
          privacyGeneration !== getPrivacyRevocationGeneration() ||
          isAbortError(error)
        )
          return;
        console.error('Playlist queue replacement failed:', error);
        reportHandledError(error, {
          tags: { source: 'playlist', op: 'replace-queue' },
          extra: { sourceId: reportSourceId, reason: drainStopReason ?? 'error', pagesFetched: drainPagesFetched },
        });
        showToast(t('detail.queueReplace.loadFailed'), 'error');
      } finally {
        if (replacementAbortRef.current === abortController) {
          replacementAbortRef.current = null;
        }
        options.onSettled?.(trackReplaced);
      }
    },
    [
      activeBoard,
      activationTarget,
      queuePlaylistClimbs,
      fetchAllClimbsForBoard,
      fetchTotalSafely,
      getQueueSnapshot,
      label,
      openPlayDrawer,
      promptQueueFork,
      reportEmptyBoardFetchOnce,
      setPlaylistSuggestionSource,
      setQueue,
      showToast,
      sourceId,
      reportSourceId,
      t,
      privacyGeneration,
    ],
  );

  /**
   * How a preview's track keeps going past the loaded rows. A preview opens on
   * the rows the screen already shows. Where their paging does not line up with
   * the track's pages, it asks from the first page and keeps only climbs it has
   * not got: the rows on screen stay in place and nothing is skipped. Where it
   * does (`loadedRowsArePages`), it starts at the page the rows end in, so it
   * doesn't fetch, one by one, pages that add nothing. Every loaded row is
   * kept, as previews always have.
   */
  const previewContinuation = useCallback(
    (board: ActivationFetchBoard) => {
      // A list whose rows are the whole of it has nothing more to load.
      if (loadedRowsAreTheList && !hasMoreRowsRef.current) return undefined;
      return {
        loaderId: registerPageLoader(board, acceptEveryClimb),
        nextPage:
          loadedRowsArePages || loadedRowsAreTheList ? continuationAfterLoadedRows(loadedClimbsRef.current.length) : 0,
      };
    },
    [continuationAfterLoadedRows, registerPageLoader, loadedRowsArePages, loadedRowsAreTheList],
  );

  // Open the drawer immediately, then let the shared hook commit the climb. The
  // open and the synchronous setCurrentClimb dispatch land in the same React
  // batch, so the drawer (rendering from currentClimbQueueItem) paints the
  // activated climb on the first frame. `committedExternally` tells the drawer
  // the caller already dispatched, so it doesn't re-commit or treat this as a
  // preview.
  const activatePlaylistClimb = useCallback(
    (requestedClimb: Climb, tappedBoardArt?: ReadyBoardArtSnapshot, activationOptions?: PlaylistActivationOptions) => {
      if (privacyGeneration !== getPrivacyRevocationGeneration()) return Promise.resolve();
      // Row adapters may clone a climb. Prefer the loaded projection over
      // details retained by a menu or native gesture callback. Not when it is
      // the same climb at another angle or the other way round (mirrored): a
      // logbook holds a climb once per angle and orientation it was sent in,
      // the track keeps the first, and the row the climber tapped is the one
      // they mean.
      const loadedClimb = loadedClimbsByUuid.get(requestedClimb.uuid);
      const climb =
        loadedClimb &&
        loadedClimb.angle === requestedClimb.angle &&
        Boolean(loadedClimb.mirrored) === Boolean(requestedClimb.mirrored)
          ? loadedClimb
          : requestedClimb;
      const schemaClimb = toSchemaClimb(climb);
      const readyBoardArt =
        tappedBoardArt?.climbUuid === climb.uuid && tappedBoardArt.frames === climb.frames ? tappedBoardArt : undefined;

      const drawerBoard = drawerBoardFor?.(climb) ?? null;
      const openingArtOptions = {
        ...(readyBoardArt ? { readyBoardArt } : {}),
        ...(drawerBoard ? { boardConfig: drawerBoard } : {}),
      };

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
          preparedClimbs: preparedPreviewClimbs,
          boardKey: getQueueBoardKey({
            board_name: viewOnlyBoardConfig.boardName,
            layout_id: viewOnlyBoardConfig.layoutId,
            size_id: viewOnlyBoardConfig.sizeId,
            set_ids: viewOnlyBoardConfig.setIds,
          }),
          label,
          continuation: previewContinuation(viewOnlyBoardConfig),
        });
        openPlayDrawer(schemaClimb, {
          ...openingArtOptions,
          // After the opening options: the wrong board always wins.
          boardConfig: viewOnlyBoardConfig,
          previewQueueItem: item,
          playlistSuggestionSource: previewSuggestionSource,
        });
        return Promise.resolve();
      }

      // Browse-only tap on the ACTIVE board. Same landing as the wrong-board
      // branch above — drawer opens on the tapped climb, queue untouched — with
      // two differences: no board override (this climb is on the board the
      // climber is standing at), and the suggestion source is keyed to the
      // ACTIVE board so the drawer's swipes walk this list instead of the queue.
      const openListPreview = () => {
        const target = resolveTarget(climb);
        openPlayDrawer(schemaClimb, {
          ...openingArtOptions,
          previewQueueItem: climbToQueueItem(schemaClimb),
          // A null target or no active board degrades to a trackless preview:
          // the tapped climb still shows, and swipes have nothing to walk (its
          // queue item is fresh, so it is not in the queue), the same fallback
          // the wrong-board branch above has. A
          // climber with the setting off and no board picked can land here:
          // with no wall to light, a preview is all a tap can be.
          playlistSuggestionSource:
            target && activeBoard
              ? createPlaylistSuggestionSource({
                  playlistUuid: sourceId,
                  activatedClimb: climb,
                  climbs: allClimbs,
                  preparedClimbs: preparedPreviewClimbs,
                  boardKey: target.boardKey,
                  label,
                  continuation: previewContinuation({
                    boardName: activeBoard.boardType,
                    layoutId: activeBoard.layoutId,
                    sizeId: activeBoard.sizeId,
                    setIds: activeBoard.setIds,
                    angle: activeBoard.angle,
                  }),
                })
              : null,
        });
      };

      // The prompt's Play last: the list goes in behind what is queued, and
      // the tapped climb plays after the current climb, as a queued climb (not
      // flagged `suggested`). It plays from the queue, with no track: the queue
      // is now [current, tapped, what was queued, the rest of the list], and a
      // track of the list would walk from the tapped climb straight to the next
      // list climb, which is not beside it in the queue. Each swipe then queued
      // a copy of a climb the batch already holds. A commit without a track
      // also prunes nothing, so what the climber chose to keep stays queued.
      // Done here, not through `activate`, which commits with a track and loads
      // a fuller one the player would never use.
      const playFromQueue = (): Promise<void> => {
        if (getQueueSnapshot().currentClimbQueueItem?.climb.uuid !== climb.uuid) {
          pendingQueueItemRef.current = climbToQueueItem(schemaClimb);
        }
        openPlayDrawer(schemaClimb, { ...openingArtOptions, committedExternally: true });
        return queueApi
          .setCurrentClimb(climb, { playlistSuggestionSource: null })
          .then(() => undefined)
          .catch((error: unknown) => {
            console.error('Playlist climb activation failed:', error);
            reportHandledError(error, { tags: { source: 'playlist', op: 'activate-climb' } });
          });
      };

      // Play from the list: the tapped climb becomes current with this list as
      // the player's track, inserted after the current climb. The queue's other
      // entries, History included, stay where they are.
      const playFromList = (): Promise<void> => {
        // The list does not subscribe to current-climb or source changes. Read
        // both live at the tap; the commit adapter reads again before dispatch.
        const { currentClimbQueueItem, playlistSuggestionSource: source } = getQueueSnapshot();
        const isAlreadyActive = currentClimbQueueItem?.climb.uuid === climb.uuid;
        const suggestionsAlreadyFollowThisList =
          source?.playlistUuid === sourceId && source?.activatedClimbUuid === climb.uuid;

        // Pure reopen: the tapped climb is already active AND the drawer's
        // next/previous already follow THIS list anchored on it. Re-activating
        // would duplicate it in the queue and pointlessly rebuild the same source,
        // so just reopen — the drawer renders from currentClimbQueueItem
        // (committedExternally), which already points at this climb.
        if (isAlreadyActive && suggestionsAlreadyFollowThisList) {
          openPlayDrawer(schemaClimb, { ...openingArtOptions, committedExternally: true });
          return Promise.resolve();
        }

        // Otherwise activate. Pin a fresh queue item only for a genuinely new
        // activation, so the drawer's nav anchor and the appended queue entry share
        // one uuid. When the climb is already active (tapped from a different list),
        // queueApi refreshes the suggestion source in place instead of appending, so
        // there's nothing to pin — and pinning a stale item could be reused on the
        // next tap. The drawer opens first (same frame as the tap), then the shared
        // activation builds the suggestion source.
        //
        // Flagged `suggested: true`: a climb opened by tapping a list row is
        // browse-origin, so the reducer's suggested-after-current prune (see
        // packages/shared/queue/src/playlist-suggestions.ts) drops it once the
        // climber opens a climb from a different list — leftovers from an earlier
        // list/board never survive into a new one. Deliberate adds via
        // `addToQueue` stay unflagged and survive. `suggested` round-trips over
        // the wire (packages/shared/queue-react/src/queue-item-input.ts) but the
        // prune itself never reaches the server, so the queue provider runs it
        // solo-only (`pruneSuggestedAfterCurrent`); in a party session the crew's
        // queue stays as the room holds it and list-first swipes do the work.
        if (!isAlreadyActive) {
          pendingQueueItemRef.current = climbToQueueItem(schemaClimb, { suggested: true });
        }
        openPlayDrawer(schemaClimb, { ...openingArtOptions, committedExternally: true });
        return activate(climb).catch((error: unknown) => {
          console.error('Playlist climb activation failed:', error);
          reportHandledError(error, { tags: { source: 'playlist', op: 'activate-climb' } });
        });
      };

      // Read at the tap, so the callback does not change identity when the
      // climber flips it. Only lists that opted in can load into the queue.
      const tapLoadsQueue = honorPlaylistLoadSetting && getSetting('playlistTapLoadsQueue');

      // Two reasons to preview, either one enough: there are other climbers in
      // the session (`previewOnly`), so a tap must not take their wall; or the
      // climber turned off "Light the board when I tap a climb" (issue #6665:
      // every list reads it, not only search). The setting is read here, at the
      // tap, so the callback does not change identity when it flips.
      //
      // Light on tap is about row taps: the Play button (`deliberate`) skips it.
      // It wins over "Tapping a playlist loads it into my queue" for a row tap,
      // since a replace lights the wall too; with both on, the Play button is
      // how a climber loads the list without lighting from a tap.
      //
      // Ordered ahead of the replace deliberately: replacing a crew's whole
      // queue is the loudest write in the app, and a row tap must never be it.
      if (previewOnlyRef.current || (!activationOptions?.deliberate && !getSetting('lightOnClimbTap'))) {
        openListPreview();
        return Promise.resolve();
      }

      // "Tapping a playlist loads it into my queue" (F4, #6667): swap the whole
      // queue for the list order so previous/next walk the circuit. Replacement
      // clears future queue items, so warn first when any exist; otherwise seed
      // the queue with the tapped climb (committed, so the drawer renders it
      // immediately) and expand to the full ordered list once it loads.
      if (tapLoadsQueue) {
        const target = resolveTarget(climb);
        if (target) {
          const { queue, currentClimbQueueItem } = getQueueSnapshot();
          const futureQueueCount = countFutureQueueItems(queue, currentClimbQueueItem);
          if (futureQueueCount > 0) {
            replacementAbortRef.current?.abort();
            // Ask before the fetch so the climber isn't waiting on a network
            // round trip to be told what we're about to destroy.
            return promptQueueFork(futureQueueCount).then((decision) => {
              // The prompt answers `cancel` for an account change too: nothing
              // opens for an account that has gone.
              if (privacyGeneration !== getPrivacyRevocationGeneration()) return;
              // Backing out still shows the climb they tapped, as a preview that
              // walks the list. The queue stays as it was.
              if (decision === 'cancel') {
                openListPreview();
                return;
              }
              // The list goes in behind what is queued (#4731), and the tapped
              // climb plays next, from the queue. It goes in once, after the
              // current climb, so the batch leaves it out, and nothing already
              // queued is pruned.
              if (decision === 'append') {
                return Promise.all([
                  playFromQueue(),
                  queuePlaylistClimbs({ entryPoint: 'replacePrompt', excludeClimbUuid: climb.uuid }),
                ]).then(() => undefined);
              }
              return replaceQueueWithPlaylist(climb, { allowClearingManualFuture: true });
            });
          }
          const item = climbToQueueItem(schemaClimb);
          setQueue([item], item);
          // The detail screen already has an ordered playlist window in memory.
          // Seed it as the player's swipe track before opening the drawer, so
          // previous/next and board swipes work on its first frame without
          // pretending those browsable neighbours are queued climbs.
          //
          // A one-item queue with a null track made navigation depend entirely on
          // the follow-up network drain. A slow, cancelled, or stuck refresh
          // therefore left both arrow buttons disabled indefinitely even though
          // the adjacent rows were already visible on the playlist screen.
          //
          // The rest of the playlist is still loading, so the seed says so: the
          // player holds the end card back at the last row on screen until the
          // load lands (#6664).
          let settleLoad: (trackReplaced: boolean) => void = () => {};
          const loadSettled = new Promise<boolean>((resolve) => {
            settleLoad = resolve;
          });
          setPlaylistSuggestionSource(
            createPlaylistSuggestionSource({
              playlistUuid: sourceId,
              activatedClimb: climb,
              climbs: loadedClimbsRef.current,
              preparedClimbs: preparedCompatibleClimbs,
              boardKey: target.boardKey,
              isClimbable: target.isClimbable,
              label,
              continuation: pendingContinuation(loadSettled),
            }),
          );
          openPlayDrawer(schemaClimb, { ...openingArtOptions, committedExternally: true });
          return replaceQueueWithPlaylist(climb, { previewQueueItem: item, onSettled: settleLoad });
        }
      }

      return playFromList();
    },
    [
      activate,
      activeBoard,
      allClimbs,
      label,
      loadedClimbsByUuid,
      pendingContinuation,
      previewContinuation,
      preparedPreviewClimbs,
      preparedCompatibleClimbs,
      queuePlaylistClimbs,
      getQueueSnapshot,
      openPlayDrawer,
      promptQueueFork,
      queueApi,
      honorPlaylistLoadSetting,
      replaceQueueWithPlaylist,
      resolveTarget,
      setQueue,
      sourceId,
      viewOnlyBoard,
      drawerBoardFor,
      privacyGeneration,
    ],
  );

  // `queue` is withheld (undefined) without an active board so the detail view's
  // render gate collapses "no board picked" into "no rows" instead of shipping
  // controls that can only ever answer "nothing here for your board yet".
  const queueFromListHeader = useCallback(
    (placement: QueueAddPlacement) => {
      void queuePlaylistClimbs({ entryPoint: 'listHeader', placement });
    },
    [queuePlaylistClimbs],
  );

  return useMemo(
    () => ({
      activate: activatePlaylistClimb,
      addToQueue: { queue: activeBoard ? queueFromListHeader : undefined, pendingPlacement },
    }),
    [activatePlaylistClimb, activeBoard, queueFromListHeader, pendingPlacement],
  );
}
