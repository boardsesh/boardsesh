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
// three-way prompt warns first whenever the queue has items after the current:
// start the playlist (destructive), add it behind what's queued, or back out.
//
// The same additive landing is available on its own, without a row tap, through
// `addToQueue.append` — the playlist-detail "Add to queue" row.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  usePlaylistClimbActivation,
  fetchPlaylistSuggestionClimbs,
  isAbortError,
  PLAYLIST_SUGGESTION_REFRESH_PAGE_SIZE,
} from '@boardsesh/playlists-react';
import {
  createPlaylistSuggestionSource,
  getQueueBoardKey,
  MAX_SYNCED_QUEUE_ITEMS,
  type Climb,
  type ClimbQueueItem,
} from '@boardsesh/queue';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { canAddClimbToBoard } from '@boardsesh/board-config';
import { useActiveClimbUuid, usePlaylistSuggestionSource, useQueueActions } from '../../providers/queue-provider';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useQueueSnackbar } from '../../providers/queue-snackbar-provider';
import { useChoose } from '../../providers/dialog-provider';
import { useToast } from '../../providers/toast-provider';
import { useActiveBoard } from '../graphql/use-active-board';
import { climbToQueueItem } from '../climb-to-queue-item';
import { reportHandledError } from '../error-reporting';
import { track } from '../analytics';
import { toSchemaClimb } from '../climb-types';
import { getPlaylistRenderBoardTarget } from './playlist-climb-render-board';
import type { PlaylistRenderBoard } from './use-playlist-render-board';

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
  /** Logged when the async suggestion refresh fails (non-abort). */
  refreshErrorMessage: string;
  /** Replace the user's queue with the playlist order instead of suggestion-fallback navigation. */
  replaceQueueOnActivate?: boolean;
};

export type PlaylistAddToQueueState = {
  /**
   * Append every board-scoped climb in this playlist behind the live queue.
   *
   * **Undefined when there is no active board.** The board-scoped fetch is built
   * from the active board, so with none it returns an empty list and the climber
   * would be told "nothing here for your board yet" when the truth is "you
   * haven't picked a board". Absent instead, so the row simply isn't rendered.
   */
  append?: () => void;
  isAppending: boolean;
};

export type PlaylistActivationResult = {
  /** Callback to wire onto a climb row tap. */
  activate: (climb: Climb) => Promise<void>;
  /** Bulk additive queueing for the detail screen's "Add to queue" row. */
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
  viewOnlyBoard,
  previewOnly = false,
  refreshErrorMessage,
  replaceQueueOnActivate = false,
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

  const replacementAbortRef = useRef<AbortController | null>(null);
  const appendAbortRef = useRef<AbortController | null>(null);
  const [isAppending, setIsAppending] = useState(false);
  // Re-entrancy guard read synchronously: `isAppending` only lands after a
  // render, so two taps inside one frame would both pass a state check and fire
  // two fetches (and two appends).
  const isAppendingRef = useRef(false);

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

  // Mirrored, not a dependency: `previewOnly` tracks whether anyone else is in
  // the session, and threading it through the callback's deps would churn the
  // identity of every climb row's onPress the moment a crew forms — for a value
  // the callback only needs at tap time.
  const previewOnlyRef = useRef(previewOnly);
  previewOnlyRef.current = previewOnly;

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
    async ({ signal, limit }: { signal: AbortSignal; limit?: number }) => {
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

      // `limit` stops the paging loop once the caller has all it can use — the
      // bulk append can only take the queue's remaining capacity, so a
      // 900-climb playlist shouldn't page nine times to throw eight pages away.
      // Replace passes none and stays unbounded.
      while (hasMore && !signal.aborted && (limit === undefined || climbs.length < limit)) {
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

      return limit === undefined ? climbs : climbs.slice(0, limit);
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
      const reportKey = `${op}|${sourceId}`;
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
        extra: { sourceId, renderableCount, loadedCount: loadedClimbsRef.current.length },
      });
    },
    [activeBoard, sourceId],
  );

  useEffect(() => {
    return () => {
      replacementAbortRef.current?.abort();
      appendAbortRef.current?.abort();
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
        if (picked !== 'replace') return picked;
        const { queue, currentClimbQueueItem } = getQueueSnapshot();
        const latestFutureQueueCount = countFutureQueueItems(queue, currentClimbQueueItem);
        if (latestFutureQueueCount <= warnedCount) return 'replace';
        warnedCount = latestFutureQueueCount;
      }
    },
    [choose, getQueueSnapshot, t],
  );

  /**
   * Append every board-scoped climb in this playlist behind the live queue.
   * Nothing is cleared and the current climb never moves, so there is no
   * confirmation on the way in — only a count on the way out.
   *
   * `loadedClimbs` short-circuits the fetch for the replace prompt's "add
   * instead" branch, which already has the board-scoped list in hand.
   */
  const appendClimbsToQueue = useCallback(
    async ({ loadedClimbs, entryPoint }: { loadedClimbs?: Climb[]; entryPoint: 'listHeader' | 'replacePrompt' }) => {
      if (!activeBoard) return;
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
      setIsAppending(true);
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
        const fetchedClimbs =
          loadedClimbs ?? (await fetchAllClimbsForBoard({ signal: abortController.signal, limit: remainingCapacity }));
        if (abortController.signal.aborted) return;

        if (fetchedClimbs.length === 0) {
          reportEmptyBoardFetchOnce('append-queue-empty');
          trackQueued('nothingToAdd', 0, 0);
          showToast(t('detail.addToQueue.nothingToAdd'), 'info');
          return;
        }

        // Dedupe by uuid before building queue items: paging an ordered list that
        // is being edited underneath can hand the same climb back on two pages.
        // Same rule `buildPlaylistQueue` applies to the replace path.
        const seenClimbUuids = new Set<string>();
        const queueItems: ClimbQueueItem[] = [];
        for (const climb of fetchedClimbs) {
          if (seenClimbUuids.has(climb.uuid)) continue;
          seenClimbUuids.add(climb.uuid);
          queueItems.push(climbToQueueItem(toSchemaClimb(climb)));
        }

        const appendedCount = appendQueueItems(queueItems);
        trackQueued(
          appendedCount === 0 ? 'queueFull' : appendedCount < queueItems.length ? 'addedPartial' : 'added',
          queueItems.length,
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
        // TODO(#4712): pass `{ kind: 'added', count: appendedCount }` once the
        // parametric `showQueueAddedSnackbar` from PR #4712 is on main; today's
        // signature takes no arguments and its copy is hardcoded singular, so a
        // 12-climb append currently confirms without the count. A partial append
        // (`appendedCount < queueItems.length`, only reachable at the 500-item
        // cap) is covered by the same call for the same reason.
        showQueueAddedSnackbar();
      } catch (error) {
        if (isAbortError(error)) return;
        console.error('Playlist queue append failed:', error);
        reportHandledError(error, { tags: { source: 'playlist', op: 'append-queue' } });
        trackQueued('failed', 0, 0);
        showToast(t('detail.addToQueue.failed'), 'error');
      } finally {
        if (appendAbortRef.current === abortController) {
          appendAbortRef.current = null;
        }
        isAppendingRef.current = false;
        setIsAppending(false);
      }
    },
    [
      activeBoard,
      appendQueueItems,
      fetchAllClimbsForBoard,
      getQueueSnapshot,
      reportEmptyBoardFetchOnce,
      showQueueAddedSnackbar,
      showToast,
      sourceId,
      t,
    ],
  );

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
      try {
        const climbs = options.loadedClimbs ?? (await fetchAllClimbsForBoard({ signal: abortController.signal }));
        if (abortController.signal.aborted) return;
        if (climbs.length === 0) reportEmptyBoardFetchOnce('replace-queue-empty');
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
          if (abortController.signal.aborted) return;
          if (decision === 'cancel') return;
          if (decision === 'append') {
            // The board-scoped list is already in hand — no second round trip.
            await appendClimbsToQueue({ loadedClimbs: climbs, entryPoint: 'replacePrompt' });
            return;
          }
        }
        const { queue, currentItem } = buildPlaylistQueue(climbs, climb, options.previewQueueItem);
        setQueue(queue, currentItem);
        // The activate path already opened the drawer (committedExternally) on the
        // seed queue; the confirm path opens it now that the climb is current.
        if (!options.previewQueueItem) {
          openPlayDrawer(toSchemaClimb(climb), { committedExternally: true });
        }
      } catch (error) {
        if (isAbortError(error)) return;
        console.error('Playlist queue replacement failed:', error);
        reportHandledError(error, { tags: { source: 'playlist', op: 'replace-queue' } });
        showToast(t('detail.queueReplace.loadFailed'), 'error');
      } finally {
        if (replacementAbortRef.current === abortController) {
          replacementAbortRef.current = null;
        }
      }
    },
    [
      appendClimbsToQueue,
      fetchAllClimbsForBoard,
      getQueueSnapshot,
      openPlayDrawer,
      promptQueueFork,
      reportEmptyBoardFetchOnce,
      setQueue,
      showToast,
      t,
    ],
  );

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

      // Browse-only tap on the ACTIVE board (a shared session). Same landing as
      // the wrong-board branch above — drawer opens on the tapped climb, queue
      // untouched — with two differences: no board override (this climb is on the
      // board the climber is standing at), and the suggestion source is keyed to
      // the ACTIVE board so the drawer's swipes walk this list instead of the
      // queue. Ordered ahead of `replaceQueueOnActivate` deliberately: replacing a
      // crew's whole queue is the loudest write in the app, and a row tap must
      // never be it.
      if (previewOnlyRef.current) {
        const target = resolveTarget(climb);
        openPlayDrawer(schemaClimb, {
          previewQueueItem: climbToQueueItem(schemaClimb),
          // A null target (no resolvable board) deliberately degrades to a
          // trackless preview: the tapped climb still shows, swipes just walk
          // the queue instead of this list — the same fallback the wrong-board
          // branch above has always had. It should be unreachable here (the
          // gate only fires in a shared session, where an active board
          // resolved), so degrading beats blocking the tap on a broken invariant.
          playlistSuggestionSource: target
            ? createPlaylistSuggestionSource({
                playlistUuid: sourceId,
                activatedClimb: climb,
                climbs: allClimbs,
                boardKey: target.boardKey,
              })
            : null,
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
            // Ask before the fetch so the climber isn't waiting on a network
            // round trip to be told what we're about to destroy.
            return promptQueueFork(futureQueueCount).then((decision) => {
              if (decision === 'cancel') return;
              if (decision === 'append') return appendClimbsToQueue({ entryPoint: 'replacePrompt' });
              return replaceQueueWithPlaylist(climb, { allowClearingManualFuture: true });
            });
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
      appendClimbsToQueue,
      getQueueSnapshot,
      openPlayDrawer,
      promptQueueFork,
      replaceQueueOnActivate,
      replaceQueueWithPlaylist,
      resolveTarget,
      setQueue,
      sourceId,
      viewOnlyBoard,
    ],
  );

  // `append` is withheld (undefined) without an active board so the detail view's
  // render gate collapses "no board picked" into "no row" instead of shipping a
  // control that can only ever answer "nothing here for your board yet".
  const append = useCallback(() => {
    void appendClimbsToQueue({ entryPoint: 'listHeader' });
  }, [appendClimbsToQueue]);

  return useMemo(
    () => ({
      activate: activatePlaylistClimb,
      addToQueue: { append: activeBoard ? append : undefined, isAppending },
    }),
    [activatePlaylistClimb, activeBoard, append, isAppending],
  );
}
