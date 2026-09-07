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
//     for free), and every applied write joins the pending refresh batch. What
//     each cached query does with that batch is decided per query, at flush
//     time, against the query's own filters — so an angle or board switch
//     inside the coalescing window refreshes the list the user ended up on.
//   - Refreshes coalesce on a 2 s trailing timer with a 6 s ceiling, and each
//     cached query is invalidated only when the batch could actually change it:
//     the climb is already on a loaded page, or the query filters/sorts on
//     stats. A name-sorted list only re-reads for a climb it is already
//     showing; a stranger's send on a climb it has never listed changes nothing.
//
// Two source gates keep the network out of it. A query whose scope this device
// never downloaded is served over HTTP, and so is a query on a downloaded scope
// whose filters SQLite cannot express (hold-state, zone, beta videos, drafts).
// Neither may be invalidated: their rows already show live values through the
// in-memory stats store, membership catches up on the next natural refetch, and
// a global stream must never trigger multi-page network refetches.
//
// Nothing here is load-bearing for correctness. The rows are written before any
// of this runs, and the next pull brings the same values down again.

import type { Query, QueryClient } from '@tanstack/react-query';
import { isSizeScopedBoard } from '@boardsesh/board-config';
import {
  invalidateKeysForTable,
  offlineBoardKey,
  writeClimbStatsEvents,
  type ClimbStatsWriteThroughInput,
  type OfflineBoardScope,
  type OfflineDatabase,
} from '@boardsesh/offline-sync';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';

import { isOfflineSearchSupported } from '../db/queries/search-climbs-local';

/** Quiet period after the last applied write before the list is refreshed. */
export const CLIMB_STATS_INVALIDATE_TRAILING_MS = 2_000;
/** Ceiling on that wait, so a continuous stream still refreshes on a schedule. */
export const CLIMB_STATS_INVALIDATE_MAX_WAIT_MS = 6_000;

/** The `['climb', variables]` root, whose predicate matches on the climb uuid. */
const CLIMB_DETAIL_KEY_ROOT = 'climb';
/** The count root, where the ORDER BY is irrelevant — a sort cannot move a total. */
const CLIMB_COUNT_KEY_ROOT = 'searchClimbsCount';

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
  // The stream never writes `benchmark_difficulty`, so a benchmarks filter
  // cannot actually change on one of these events today. Kept as
  // future-proofing; it costs one local re-read when the filter is on.
  'onlyBenchmarks',
  'projectsOnly',
] as const satisfies ReadonlyArray<keyof ClimbSearchInput>;

/** Sorts whose ORDER BY reads a stats column, so positions can move. */
const STATS_DEPENDENT_SORTS: ReadonlySet<string> = new Set(['ascents', 'difficulty', 'quality', 'popular']);

/**
 * The one sort whose key spans angles: `popular` orders by
 * `SUM(ascensionist_count)` over EVERY angle of the climb (see
 * `search-climbs-local.ts` `sortColumnSql`), so a send logged at 25° reorders a
 * list browsing 40°. Every other stats column is read at the browsed angle only.
 */
const CROSS_ANGLE_SORT = 'popular';

/**
 * Does this search read climb stats?
 *
 * A field counts as set unless it is absent or an explicitly disabled toggle.
 * Zero counts too, though nothing reaches this with a zero today —
 * `toClimbSearchInput` only sets these fields when they are non-null, and the
 * local SQL truthy-gates them — so the rule costs at most one extra local
 * re-read if that ever changes.
 *
 * `sortMatters` is false for the count root: `searchClimbsCount` returns a
 * total, and no ORDER BY can change one. Since the default sort is `ascents`
 * (`DEFAULT_CLIMB_FILTER_STATE`), leaving it in would make every filter-sheet
 * preview count re-run over the whole catalogue on every flush.
 */
export function isStatsDependentSearch(input: Partial<ClimbSearchInput>, sortMatters = true): boolean {
  for (const field of STATS_DEPENDENT_FILTERS) {
    const value = input[field];
    if (value !== undefined && value !== null && value !== false) return true;
  }
  return sortMatters && typeof input.sortBy === 'string' && STATS_DEPENDENT_SORTS.has(input.sortBy);
}

/** One applied write, as the refresh stage needs it. */
export type FlushedClimbStat = {
  boardType: string;
  layoutId: number;
  climbUuid: string;
  angle: number;
  /** From the write's own pre-read, so the size gate needs no second query. */
  compatibleSizeIds: number[] | null;
};

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

function loadedPagesHoldAny(cachedData: unknown, climbUuids: ReadonlySet<string>): boolean {
  if (cachedData === null || typeof cachedData !== 'object') return false;
  const pages = (cachedData as { pages?: unknown }).pages;
  if (Array.isArray(pages)) return pages.some((page) => pageHoldsAnyClimb(page, climbUuids));
  return pageHoldsAnyClimb(cachedData, climbUuids);
}

/** The offline scope a cached search reads from, or null if the key is not a search input. */
export function searchInputScope(input: unknown): OfflineBoardScope | null {
  if (input === null || typeof input !== 'object') return null;
  const { boardName, layoutId, sizeId } = input as Partial<ClimbSearchInput>;
  if (typeof boardName !== 'string' || typeof layoutId !== 'number' || typeof sizeId !== 'number') return null;
  return { boardType: boardName, layoutId, sizeId };
}

/**
 * Can this batch of applied writes change what this cached query renders?
 *
 * Decided per query rather than against one "armed" board, because the user can
 * switch angle, size or board inside the 2 s window and the list they end up on
 * is the one that has to be right.
 *
 * An entry has to clear the size gate first — a climb that does not fit the
 * browsed size is not in this list's result set at any angle. Then, at the
 * query's own angle, either the query reads stats (membership and order can
 * move for a climb it has never shown) or it is already showing the climb.
 * At any OTHER angle only the cross-angle `popular` sort can be affected.
 *
 * `cachedData` is the RAW query data, before any `select` — the infinite list
 * caches `{ pages: [{ searchClimbs: { climbs } }] }`, the single-page list
 * `{ searchClimbs: { climbs } }`, and the count neither.
 */
export function canStreamChangeList(
  root: string,
  input: unknown,
  cachedData: unknown,
  batch: readonly FlushedClimbStat[],
): boolean {
  if (input === null || typeof input !== 'object') return false;
  const search = input as Partial<ClimbSearchInput>;
  const sortMatters = root !== CLIMB_COUNT_KEY_ROOT;
  const statsDependent = isStatsDependentSearch(search, sortMatters);
  const sizeScoped = typeof search.boardName === 'string' && isSizeScopedBoard(search.boardName);

  // Climbs that clear the size and angle gates but need the loaded pages
  // checked. Collected first so the pages are walked once, not once per entry.
  const onPageCandidates = new Set<string>();
  for (const entry of batch) {
    // A climb belongs to exactly one board and layout, so an event from another
    // one cannot be in this list's result set at any angle.
    if (search.boardName !== entry.boardType || search.layoutId !== entry.layoutId) continue;
    if (sizeScoped && !(entry.compatibleSizeIds?.includes(search.sizeId as number) ?? false)) continue;
    if (search.angle !== entry.angle) {
      if (sortMatters && search.sortBy === CROSS_ANGLE_SORT) return true;
      continue;
    }
    if (statsDependent) return true;
    onPageCandidates.add(entry.climbUuid);
  }
  if (onPageCandidates.size === 0) return false;
  return loadedPagesHoldAny(cachedData, onPageCandidates);
}

/**
 * The `['climb', variables]` detail query. Its variables always carry an angle
 * (`GetClimbQueryVariables`), but the angle check is conditional so a future
 * angle-less variant still matches on the uuid rather than silently never
 * refreshing.
 */
export function climbDetailMatchesBatch(variables: unknown, batch: readonly FlushedClimbStat[]): boolean {
  if (variables === null || typeof variables !== 'object') return false;
  const { climbUuid, angle } = variables as { climbUuid?: unknown; angle?: unknown };
  if (typeof climbUuid !== 'string') return false;
  return batch.some((entry) => entry.climbUuid === climbUuid && (typeof angle !== 'number' || entry.angle === angle));
}

export type ClimbStatsLiveSyncOptions = {
  /** Null until migrations publish the handle, and again after a hot reload. */
  getDb: () => OfflineDatabase | null;
  queryClient: QueryClient;
  isScopeDownloaded: (db: OfflineDatabase, scope: OfflineBoardScope) => Promise<boolean>;
  /** Mobile: backgrounded or signing out. Both mean "do not touch SQLite". */
  shouldSkipWrites: () => boolean;
  hasEnabledScopeForLayout: (boardType: string, layoutId: number) => boolean;
  /** Test seam. */
  writeEvents?: typeof writeClimbStatsEvents;
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
  const writeEvents = options.writeEvents ?? writeClimbStatsEvents;

  // Latest-wins per (board, climb, angle): a burst of recomputes for one climb
  // collapses to a single write of the newest payload, and the revision gate in
  // the SQL makes any ordering surprise a no-op rather than a regression.
  const pendingEvents = new Map<string, ClimbStatsWriteThroughInput>();
  const flushedStats = new Map<string, FlushedClimbStat>();

  let draining = false;
  let disposed = false;
  let hasReportedError = false;
  let cancelTrailing: (() => void) | null = null;
  let cancelMaxWait: (() => void) | null = null;

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

  function armMaxWait(): void {
    if (disposed || cancelMaxWait) return;
    cancelMaxWait = scheduleTask(() => {
      cancelMaxWait = null;
      void flush();
    }, CLIMB_STATS_INVALIDATE_MAX_WAIT_MS);
  }

  function armFlush(event: ClimbStatsWriteThroughInput, compatibleSizeIds: number[] | null): void {
    flushedStats.set(pendingKey(event), {
      boardType: event.boardType,
      layoutId: event.layoutId,
      climbUuid: event.climbUuid,
      angle: event.angle,
      compatibleSizeIds,
    });
    armMaxWait();
    cancelTrailing?.();
    cancelTrailing = scheduleTask(() => {
      cancelTrailing = null;
      void flush();
    }, CLIMB_STATS_INVALIDATE_TRAILING_MS);
  }

  /**
   * Probe each distinct offline scope that is actually cached — typically one,
   * the board being browsed. A scope the device never downloaded is served over
   * the network, and must not be invalidated by a stream event.
   */
  async function downloadedScopes(
    db: OfflineDatabase,
    listRoots: readonly (readonly string[])[],
  ): Promise<Map<string, boolean>> {
    const downloaded = new Map<string, boolean>();
    const cache = options.queryClient.getQueryCache();
    for (const root of listRoots) {
      for (const query of cache.findAll({ queryKey: root })) {
        const scope = searchInputScope(query.queryKey[1]);
        if (!scope) continue;
        const scopeKey = offlineBoardKey(scope);
        if (downloaded.has(scopeKey)) continue;
        downloaded.set(scopeKey, await options.isScopeDownloaded(db, scope));
      }
    }
    return downloaded;
  }

  async function invalidateForBatch(db: OfflineDatabase, batch: readonly FlushedClimbStat[]): Promise<void> {
    // The shared table → key map, never a local copy: a key added there for
    // board_climb_stats has to reach this consumer too.
    const roots = invalidateKeysForTable('board_climb_stats') ?? [];
    const listRoots = roots.filter((root) => root[0] !== CLIMB_DETAIL_KEY_ROOT);
    const downloaded = await downloadedScopes(db, listRoots);
    if (disposed) return;

    for (const root of roots) {
      if (root[0] === CLIMB_DETAIL_KEY_ROOT) {
        void options.queryClient.invalidateQueries({
          queryKey: root,
          predicate: (query: Query) => climbDetailMatchesBatch(query.queryKey[1], batch),
        });
        continue;
      }
      void options.queryClient.invalidateQueries({
        queryKey: root,
        predicate: (query: Query) => {
          const input = query.queryKey[1];
          const scope = searchInputScope(input);
          if (!scope || downloaded.get(offlineBoardKey(scope)) !== true) return false;
          // Downloaded scope, but these filters need tables we do not sync, so
          // the query is served over HTTP even here. Refreshing it would refetch
          // every loaded page over the network on every flush.
          if (!isOfflineSearchSupported(input as ClimbSearchInput)) return false;
          return canStreamChangeList(String(root[0]), input, query.state.data, batch);
        },
      });
    }
  }

  async function flush(): Promise<void> {
    cancelTimers();
    if (disposed || flushedStats.size === 0) return;

    // Transient gates BEFORE the batch is consumed. A flush landing during a
    // momentary background, or before migrations publish the handle, keeps its
    // batch and re-arms the ceiling; clearing here would lose the refresh for
    // good, because nothing re-arms until a new event arrives.
    if (options.shouldSkipWrites()) {
      armMaxWait();
      return;
    }
    const db = options.getDb();
    if (!db) {
      armMaxWait();
      return;
    }

    const batch = [...flushedStats.values()];
    flushedStats.clear();

    try {
      // The catch is mandatory, not defensive dressing: this runs from a timer
      // through `void flush()`, so a rejection here would surface as an
      // unhandled rejection and be reported as a crash. `isBoardDownloadedLocally`
      // really does throw when the handle closes underneath it — a hot reload,
      // or a sign-out wipe landing after the `shouldSkipWrites()` check above.
      // Dropping the batch is correct: the next pull refreshes the same rows.
      await invalidateForBatch(db, batch);
    } catch (error) {
      reportFirstError(error);
    }
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (!disposed) {
        // Re-checked every iteration, not just at handleEvent: a burst queued
        // while foregrounded must stop the instant the app backgrounds or
        // sign-out starts, which is what every other SQLite writer in the
        // engine does. The unwritten events stay in `pendingEvents`; the next
        // `handleEvent` re-drains them under this same gate.
        if (options.shouldSkipWrites()) break;
        if (pendingEvents.size === 0) break;

        const keys = [...pendingEvents.keys()];
        const events = keys.map((key) => pendingEvents.get(key) as ClimbStatsWriteThroughInput);
        pendingEvents.clear();

        const db = options.getDb();
        if (!db) {
          // The handle is null for up to ~30 s during startup migrations, and
          // again for a moment after a hot reload. Discarding here would lose
          // every event of that window; keep them for the next handleEvent.
          requeue(keys, events);
          break;
        }

        let results;
        try {
          results = await writeEvents(db, events);
        } catch (error) {
          // A broken database is worth one report per session, not one per
          // event on a chatty layout channel. Contention never lands here —
          // writeClimbStatsEvents returns `lock_lost` for it.
          reportFirstError(error);
          continue;
        }
        if (disposed) break;

        // Contention means another writer holds the file (a VACUUM or a
        // snapshot import can hold it for 5-20 s). Retrying immediately would
        // pay the full lock wait again per pass, so keep the events and stop;
        // the next event on the stream re-drains them.
        let lostLock = false;
        for (const [index, result] of results.entries()) {
          if (result.status === 'lock_lost') {
            lostLock = true;
            continue;
          }
          if (result.status !== 'applied') continue;
          armFlush(events[index], result.compatibleSizeIds);
        }
        if (lostLock) {
          requeue(
            keys.filter((_key, index) => results[index]?.status === 'lock_lost'),
            events.filter((_event, index) => results[index]?.status === 'lock_lost'),
          );
          break;
        }
      }
    } finally {
      draining = false;
    }
  }

  /** Put unwritten events back, unless a newer payload already replaced the key. */
  function requeue(keys: readonly string[], events: readonly ClimbStatsWriteThroughInput[]): void {
    for (const [index, key] of keys.entries()) {
      if (pendingEvents.has(key)) continue;
      pendingEvents.set(key, events[index]);
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
      flushedStats.clear();
    },
  };
}
