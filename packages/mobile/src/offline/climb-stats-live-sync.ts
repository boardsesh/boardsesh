// The mobile consumer of the live climb-stat stream (issue #5227): SQLite
// write-through plus a coalesced, gated refresh of the local-first climb list.
//
// The layout-wide `climbStatsUpdated` channel is global — one event per graded
// climb on the layout, from anyone on any wall — so the cost per event has to
// stay tiny and the list refresh has to be rare. Three things keep it that way:
//
//   - Writes are gated before any SQL: the app must be foregrounded and not
//     signing out, and the event's layout must have an opted-in offline scope.
//     A phone with no downloads does no work at all.
//   - Rows are written at EVERY angle (a later angle switch reads fresh values
//     for free), but only the browsed angle and size can arm a refresh — that
//     is the part that costs a list re-read.
//   - Refreshes coalesce on a 2 s trailing timer with a 6 s ceiling, and each
//     cached query is invalidated only when this event could actually change
//     it: the climb is already on a loaded page, or the query filters/sorts on
//     stats. A name-sorted, unfiltered list never re-reads because a stranger
//     logged a send.
//
// Network-served lists get nothing extra here. Their rows already show live
// values through the in-memory stats store, and membership catches up on the
// next natural refetch — a global stream must never trigger multi-page network
// refetches.

import type { QueryClient } from '@tanstack/react-query';
import { isSizeScopedBoard } from '@boardsesh/board-config';
import {
  invalidateKeysForTable,
  writeClimbStatsEvent,
  type ClimbStatsWriteThroughInput,
  type OfflineBoardScope,
  type OfflineDatabase,
} from '@boardsesh/offline-sync';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';

/** Quiet period after the last applied write before the list is refreshed. */
export const CLIMB_STATS_INVALIDATE_TRAILING_MS = 2_000;
/** Ceiling on that wait, so a continuous stream still refreshes on a schedule. */
export const CLIMB_STATS_INVALIDATE_MAX_WAIT_MS = 6_000;

/** The `['climb', variables]` root, whose predicate matches on the climb uuid. */
const CLIMB_DETAIL_KEY_ROOT = 'climb';

/**
 * Search fields whose value depends on a climb's stats. A change to any of them
 * can move a climb into or out of the result set, so a cached query carrying
 * one must re-read even if the climb is not on a loaded page.
 */
const STATS_DEPENDENT_FILTERS = [
  'minGrade',
  'maxGrade',
  'minAscents',
  'minRating',
  'gradeAccuracy',
  'onlyBenchmarks',
  'projectsOnly',
] as const satisfies ReadonlyArray<keyof ClimbSearchInput>;

/** Sorts whose ORDER BY reads a stats column, so positions can move. */
const STATS_DEPENDENT_SORTS: ReadonlySet<string> = new Set(['ascents', 'difficulty', 'quality', 'popular']);

/**
 * Does this search read climb stats?
 *
 * A field counts as set unless it is absent or an explicitly disabled toggle.
 * Numeric zero counts: `minGrade: 0` is a real bound, and over-invalidating a
 * local SQLite re-read is much cheaper than showing a climb the wrong grade.
 */
export function isStatsDependentSearch(input: Partial<ClimbSearchInput>): boolean {
  for (const field of STATS_DEPENDENT_FILTERS) {
    const value = input[field];
    if (value !== undefined && value !== null && value !== false) return true;
  }
  return typeof input.sortBy === 'string' && STATS_DEPENDENT_SORTS.has(input.sortBy);
}

type CachedClimbPage = { searchClimbs?: { climbs?: unknown } };

function pageHoldsAnyClimb(page: unknown, climbUuids: ReadonlySet<string>): boolean {
  if (page === null || typeof page !== 'object') return false;
  const climbs = (page as CachedClimbPage).searchClimbs?.climbs;
  if (!Array.isArray(climbs)) return false;
  return climbs.some((climb) => {
    const uuid = (climb as { uuid?: unknown } | null)?.uuid;
    return typeof uuid === 'string' && climbUuids.has(uuid);
  });
}

/**
 * Can these flushed climbs change what this cached query renders?
 *
 * Two independent reasons, either of which is enough. The climb is already on a
 * loaded page, so its values (and its position under a stats sort) can move; or
 * the query filters/sorts on stats, so membership and order can change even for
 * a climb the list has never shown.
 *
 * `cachedData` is the RAW query data, before any `select` — the infinite list
 * caches `{ pages: [{ searchClimbs: { climbs } }] }`, the single-page list
 * `{ searchClimbs: { climbs } }`, and the count neither.
 */
export function canStreamChangeList(
  input: unknown,
  cachedData: unknown,
  climbUuids: ReadonlySet<string>,
): boolean {
  if (cachedData !== null && typeof cachedData === 'object') {
    const pages = (cachedData as { pages?: unknown }).pages;
    if (Array.isArray(pages)) {
      if (pages.some((page) => pageHoldsAnyClimb(page, climbUuids))) return true;
    } else if (pageHoldsAnyClimb(cachedData, climbUuids)) {
      return true;
    }
  }
  if (input === null || typeof input !== 'object') return false;
  return isStatsDependentSearch(input as Partial<ClimbSearchInput>);
}

/** The board the user is browsing, as the climb list and count read it. */
export type ClimbStatsLiveSyncBoard = {
  boardType: string;
  layoutId: number;
  sizeId: number;
  angle: number;
};

export type ClimbStatsLiveSyncOptions = {
  /** Null until migrations publish the handle, and again after a hot reload. */
  getDb: () => OfflineDatabase | null;
  queryClient: QueryClient;
  /** Resolved at call time — the user can switch boards mid-flush. */
  getActiveBoard: () => ClimbStatsLiveSyncBoard | null;
  isScopeDownloaded: (db: OfflineDatabase, scope: OfflineBoardScope) => Promise<boolean>;
  /** Mobile: backgrounded or signing out. Both mean "do not touch SQLite". */
  shouldSkipWrites: () => boolean;
  hasEnabledScopeForLayout: (boardType: string, layoutId: number) => boolean;
  /** Test seam. */
  writeEvent?: typeof writeClimbStatsEvent;
  /** Test seam; defaults to setTimeout. */
  scheduleTask?: (callback: () => void, delayMs: number) => () => void;
  /** Called once per instance, for the first non-contention write failure. */
  onError?: (error: unknown) => void;
};

export type ClimbStatsLiveSync = {
  handleEvent: (event: ClimbStatsWriteThroughInput) => void;
  dispose: () => void;
};

function defaultScheduleTask(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
}

function pendingKey(event: ClimbStatsWriteThroughInput): string {
  return `${event.boardType}|${event.climbUuid}|${event.angle}`;
}

export function createClimbStatsLiveSync(options: ClimbStatsLiveSyncOptions): ClimbStatsLiveSync {
  const scheduleTask = options.scheduleTask ?? defaultScheduleTask;
  const writeEvent = options.writeEvent ?? writeClimbStatsEvent;

  // Latest-wins per (board, climb, angle): a burst of recomputes for one climb
  // collapses to a single write of the newest payload, and the revision gate in
  // the SQL makes any ordering surprise a no-op rather than a regression.
  const pendingEvents = new Map<string, ClimbStatsWriteThroughInput>();
  const flushedClimbUuids = new Set<string>();

  let draining = false;
  let disposed = false;
  let hasReportedError = false;
  let cancelTrailing: (() => void) | null = null;
  let cancelMaxWait: (() => void) | null = null;
  let armedBoard: ClimbStatsLiveSyncBoard | null = null;

  function reportFirstError(error: unknown): void {
    if (hasReportedError) return;
    hasReportedError = true;
    options.onError?.(error);
  }

  function cancelTimers(): void {
    cancelTrailing?.();
    cancelTrailing = null;
    cancelMaxWait?.();
    cancelMaxWait = null;
  }

  function armFlush(board: ClimbStatsLiveSyncBoard, climbUuid: string): void {
    if (flushedClimbUuids.size === 0) {
      // Capture the board the first applied write belonged to. If the user
      // switches boards before the flush lands, the refresh is dropped rather
      // than applied to a list it never described.
      armedBoard = board;
      cancelMaxWait = scheduleTask(() => {
        cancelMaxWait = null;
        void flush();
      }, CLIMB_STATS_INVALIDATE_MAX_WAIT_MS);
    }
    flushedClimbUuids.add(climbUuid);
    cancelTrailing?.();
    cancelTrailing = scheduleTask(() => {
      cancelTrailing = null;
      void flush();
    }, CLIMB_STATS_INVALIDATE_TRAILING_MS);
  }

  function invalidateForClimbs(climbUuids: ReadonlySet<string>): void {
    // The shared table → key map, never a local copy: a key added there for
    // board_climb_stats has to reach this consumer too.
    for (const root of invalidateKeysForTable('board_climb_stats') ?? []) {
      if (root[0] === CLIMB_DETAIL_KEY_ROOT) {
        void options.queryClient.invalidateQueries({
          queryKey: root,
          predicate: (query) => {
            const variables = query.queryKey[1];
            const climbUuid = (variables as { climbUuid?: unknown } | null)?.climbUuid;
            return typeof climbUuid === 'string' && climbUuids.has(climbUuid);
          },
        });
        continue;
      }
      void options.queryClient.invalidateQueries({
        queryKey: root,
        predicate: (query) => canStreamChangeList(query.queryKey[1], query.state.data, climbUuids),
      });
    }
  }

  async function flush(): Promise<void> {
    cancelTimers();
    const board = armedBoard;
    const climbUuids = new Set(flushedClimbUuids);
    flushedClimbUuids.clear();
    armedBoard = null;

    if (disposed || !board || climbUuids.size === 0) return;
    if (options.shouldSkipWrites()) return;
    const db = options.getDb();
    if (!db) return;

    const currentBoard = options.getActiveBoard();
    if (
      !currentBoard ||
      currentBoard.boardType !== board.boardType ||
      currentBoard.layoutId !== board.layoutId ||
      currentBoard.sizeId !== board.sizeId ||
      currentBoard.angle !== board.angle
    ) {
      return;
    }

    // Only a downloaded scope reads from SQLite, so only a downloaded scope has
    // anything to gain from a re-read.
    const downloaded = await options.isScopeDownloaded(db, {
      boardType: board.boardType,
      layoutId: board.layoutId,
      sizeId: board.sizeId,
    });
    if (!downloaded || disposed) return;

    invalidateForClimbs(climbUuids);
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (!disposed) {
        const next = pendingEvents.entries().next();
        if (next.done) break;
        const [key, event] = next.value;
        pendingEvents.delete(key);

        const db = options.getDb();
        if (!db) continue;

        let result;
        try {
          result = await writeEvent(db, event);
        } catch (error) {
          // A broken database is worth one report per session, not one per
          // event on a chatty layout channel. Contention never lands here —
          // writeClimbStatsEvent returns `lock_lost` for it.
          reportFirstError(error);
          continue;
        }
        if (result.status !== 'applied') continue;

        const board = options.getActiveBoard();
        if (!board) continue;
        if (board.boardType !== event.boardType || board.layoutId !== event.layoutId) continue;
        // Other angles are written but never refresh the list: the browsed
        // angle is the only one on screen.
        if (board.angle !== event.angle) continue;
        if (isSizeScopedBoard(event.boardType) && !(result.compatibleSizeIds?.includes(board.sizeId) ?? false)) {
          continue;
        }

        armFlush(board, event.climbUuid);
      }
    } finally {
      draining = false;
    }
  }

  return {
    handleEvent(event) {
      if (disposed) return;
      if (options.shouldSkipWrites()) return;
      // The cheap pre-gate: a layout with no opted-in scope can never have a
      // local row worth writing, and this is the common case on the global
      // channel.
      if (!options.hasEnabledScopeForLayout(event.boardType, event.layoutId)) return;
      pendingEvents.set(pendingKey(event), event);
      void drain();
    },
    dispose() {
      disposed = true;
      cancelTimers();
      pendingEvents.clear();
      flushedClimbUuids.clear();
      armedBoard = null;
    },
  };
}
