// The mobile consumer of the live climb-stat stream (issue #5227): SQLite
// write-through plus a coalesced, gated refresh of the local-first climb list.
//
// The layout-wide `climbStatsUpdated` channel is global — one event per graded
// climb on the layout, from anyone on any wall — so the cost per event has to
// stay tiny and the list refresh has to be rare. Four things keep it that way:
//
//   - Writes are gated before any SQL: the app must be foregrounded and not
//     signing out, and the event's layout must have an opted-in offline scope.
//     A phone with no downloads does no work at all.
//   - A revision this instance has already applied (or already found stale) is
//     dropped before it is queued, so the 120 s reconciliation read re-offering
//     ~700 unchanged angle rows costs nothing.
//   - Rows are written at EVERY angle (a later angle switch reads fresh values
//     for free), and every applied write joins the pending refresh batch. What
//     each cached query does with that batch is decided per query, at flush
//     time, against the query's own filters — so an angle or board switch
//     inside the coalescing window refreshes the list the user ended up on.
//   - Refreshes coalesce on a 2 s trailing timer with a 6 s ceiling, and each
//     cached query is invalidated only when the batch could actually change it.
//
// That last rule has two halves, and the split is the point. A stats-dependent
// FILTER (a grade range, minAscents, minRating…) changes MEMBERSHIP, so it
// invalidates even for a climb the list has never shown. A SORT only reorders,
// so a stats sort — `ascents`, the default, included — invalidates only when the
// climb is on a loaded page. Otherwise the ordinary Climbs tab would refetch
// every loaded page every few seconds because a stranger logged a send on a
// climb nobody is looking at. The same rule covers the one cross-angle sort:
// `popular` orders by `SUM(ascensionist_count)` over every angle, so an event at
// another angle can move a row it is already showing, and nothing else.
//
// Two source gates keep the network out of it, and they apply to the climb
// detail exactly as they apply to the lists. A query whose scope this device
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
  parseClimbStatsRevision,
  parseOfflineBoardKey,
  writeClimbStatsEvents,
  type ClimbStatsWriteThroughInput,
  type ClimbStatsWriteThroughResult,
  type OfflineBoardScope,
  type OfflineDatabase,
} from '@boardsesh/offline-sync';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';

// Both imported, never re-derived: `isOfflineSearchSupported` is the same
// predicate that decides whether a search reads SQLite at all, and
// `normalizeSortBy` is the same rule that turns an absent `sortBy` into
// `ascents`. A local copy of either would silently drift into refreshing a
// network-served list, or into missing the default sort.
import { isOfflineSearchSupported, normalizeSortBy } from '../db/queries/search-climbs-local';

/** Quiet period after the last applied write before the list is refreshed. */
export const CLIMB_STATS_INVALIDATE_TRAILING_MS = 2_000;
/** Ceiling on that wait, so a continuous stream still refreshes on a schedule. */
export const CLIMB_STATS_INVALIDATE_MAX_WAIT_MS = 6_000;
/**
 * How long the drain stands down after losing the write lock. A VACUUM or a
 * snapshot import holds it for seconds; without this every arriving event pays
 * a fresh pre-read pass, a new native connection and the full 250 ms wait.
 */
export const CLIMB_STATS_LOCK_BACKOFF_MS = 1_000;
/**
 * How many `(board, climb, angle)` revisions one instance remembers, so a
 * republished event can be dropped before it reaches SQLite. Bounded because
 * the channel is layout-wide and runs for the life of the app; the oldest entry
 * is evicted, and a forgotten key just costs one autocommit read.
 */
export const CLIMB_STATS_TRACKED_REVISIONS = 2_000;
/**
 * How long a remembered revision is trusted. Another writer can delete these
 * rows underneath the memo — a scope teardown, a sign-out purge, a snapshot
 * reconcile — and nothing tells this module. After a remove and re-download
 * inside one session the re-imported row can sit at an OLDER revision than the
 * memo, and a routine republish that would have healed it would be discarded.
 *
 * Matches the reconciliation read's interval in `@boardsesh/board-react`, which
 * is the outer bound on how long any staleness here can last anyway.
 */
export const CLIMB_STATS_REVISION_MEMO_TTL_MS = 120_000;
/**
 * How many un-written events one instance holds. The queue only grows while
 * SQLite is unreachable (no handle yet, or the write lock held), and every
 * event on it is disposable — the next pull carries the same values — so the
 * oldest is dropped rather than letting a session whose database never opens
 * accumulate one entry per climb on the layout, and copy the whole map on
 * every arrival.
 */
export const CLIMB_STATS_MAX_PENDING_EVENTS = 500;

/** The `['climb', variables]` root, whose predicate matches on the climb uuid. */
const CLIMB_DETAIL_KEY_ROOT = 'climb';
/** The count root, where the ORDER BY is irrelevant — a sort cannot move a total. */
const CLIMB_COUNT_KEY_ROOT = 'searchClimbsCount';

/**
 * Search fields whose value depends on a climb's stats. A change to any of them
 * can move a climb into or out of the result set, so a cached query carrying
 * one must re-read even for a climb it has never shown.
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

/**
 * The one sort whose key spans angles: `popular` orders by
 * `SUM(ascensionist_count)` over EVERY angle of the climb (see
 * `search-climbs-local.ts` `sortColumnSql`), so a send logged at 25° reorders a
 * list browsing 40°. Every other stats column is read at the browsed angle only.
 */
const CROSS_ANGLE_SORT = 'popular';

/**
 * Does this search FILTER on climb stats?
 *
 * Only filters, deliberately: a filter decides membership, so it can pull a
 * climb the list has never shown into the result set. A sort cannot — see the
 * header — and is handled by the loaded-page check instead.
 *
 * A field counts as set unless it is absent or an explicitly disabled toggle.
 * Zero counts too, though nothing reaches this with a zero today —
 * `toClimbSearchInput` only sets these fields when they are non-null, and the
 * local SQL truthy-gates them — so the rule costs at most one extra local
 * re-read if that ever changes.
 */
export function hasStatsDependentFilter(input: Partial<ClimbSearchInput>): boolean {
  for (const field of STATS_DEPENDENT_FILTERS) {
    const value = input[field];
    if (value !== undefined && value !== null && value !== false) return true;
  }
  return false;
}

/** One applied write, as the refresh stage needs it. */
export type FlushedClimbStat = {
  boardType: string;
  /**
   * The climb's OWN layout, read from `board_climbs` by the write — never the
   * layout the event or the reconciliation read was labelled with, which is
   * the layout the user happens to be browsing.
   */
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

/**
 * The offline scope a cached query reads from, or null if the key carries no
 * scope. Both the search inputs and `GetClimbQueryVariables` name the board the
 * same way, so one reader covers every root.
 */
export function searchInputScope(input: unknown): OfflineBoardScope | null {
  if (input === null || typeof input !== 'object') return null;
  const { boardName, layoutId, sizeId } = input as Partial<ClimbSearchInput>;
  if (typeof boardName !== 'string' || typeof layoutId !== 'number' || typeof sizeId !== 'number') return null;
  return { boardType: boardName, layoutId, sizeId };
}

/** True when some entry in the batch belongs to this scope's board and layout. */
function batchTouchesScope(scope: OfflineBoardScope, batch: readonly FlushedClimbStat[]): boolean {
  return batch.some((entry) => entry.boardType === scope.boardType && entry.layoutId === scope.layoutId);
}

/**
 * Can this batch of applied writes change what this cached query renders?
 *
 * Decided per query rather than against one "armed" board, because the user can
 * switch angle, size or board inside the 2 s window and the list they end up on
 * is the one that has to be right.
 *
 * An entry has to be the same board and layout, then clear the size gate — a
 * climb that does not fit the browsed size is not in this list's result set at
 * any angle. After that, a stats FILTER at the query's own angle is enough on
 * its own; everything else (a stats sort, a plain value refresh, and the
 * cross-angle `popular` sort) needs the climb to be on a loaded page.
 *
 * `cachedData` is the RAW query data, before any `select` — the infinite list
 * caches `{ pages: [{ searchClimbs: { climbs } }] }`, the single-page list
 * `{ searchClimbs: { climbs } }`, and the count neither (so a count only ever
 * moves on a filter, which is exactly right).
 */
export function canStreamChangeList(
  root: string,
  input: unknown,
  cachedData: unknown,
  batch: readonly FlushedClimbStat[],
): boolean {
  if (input === null || typeof input !== 'object') return false;
  const search = input as Partial<ClimbSearchInput>;
  const filterDependent = hasStatsDependentFilter(search);
  // A sort cannot change a total, so the count root ignores it entirely.
  const sortMatters = root !== CLIMB_COUNT_KEY_ROOT;
  const crossAngleSort = sortMatters && normalizeSortBy(search.sortBy) === CROSS_ANGLE_SORT;
  const sizeScoped = typeof search.boardName === 'string' && isSizeScopedBoard(search.boardName);

  // Climbs that clear every gate but still need the loaded pages checked.
  // Collected first so the pages are walked once, not once per entry.
  const onPageCandidates = new Set<string>();
  for (const entry of batch) {
    // A climb belongs to exactly one board and layout, so an event from another
    // one cannot be in this list's result set at any angle.
    if (search.boardName !== entry.boardType || search.layoutId !== entry.layoutId) continue;
    if (sizeScoped) {
      // No cast: a size-scoped key without a numeric sizeId is malformed, and a
      // malformed key must fail closed rather than match by accident.
      const { sizeId } = search;
      if (typeof sizeId !== 'number' || !(entry.compatibleSizeIds?.includes(sizeId) ?? false)) continue;
    }
    if (search.angle !== entry.angle) {
      if (crossAngleSort) onPageCandidates.add(entry.climbUuid);
      continue;
    }
    if (filterDependent) return true;
    onPageCandidates.add(entry.climbUuid);
  }
  if (onPageCandidates.size === 0) return false;
  return loadedPagesHoldAny(cachedData, onPageCandidates);
}

/**
 * The `['climb', variables]` detail query, under the same source gates the
 * lists get. Its variables always carry a board, a layout, a size and an angle
 * (`GetClimbQueryVariables`), but each check is conditional so a narrower
 * future variant still matches on the uuid rather than silently never
 * refreshing — except the scope, which fails closed: a detail served over HTTP
 * must not be refetched by a global stream.
 */
export function climbDetailMatchesBatch(
  variables: unknown,
  batch: readonly FlushedClimbStat[],
  downloaded: ReadonlyMap<string, boolean>,
): boolean {
  if (variables === null || typeof variables !== 'object') return false;
  const { climbUuid, angle, boardName, layoutId, sizeId } = variables as {
    climbUuid?: unknown;
    angle?: unknown;
    boardName?: unknown;
    layoutId?: unknown;
    sizeId?: unknown;
  };
  if (typeof climbUuid !== 'string') return false;

  return batch.some((entry) => {
    if (entry.climbUuid !== climbUuid) return false;
    if (typeof angle === 'number' && entry.angle !== angle) return false;
    if (typeof boardName === 'string' && boardName !== entry.boardType) return false;
    if (typeof layoutId === 'number' && layoutId !== entry.layoutId) return false;
    if (typeof sizeId === 'number') {
      return downloaded.get(offlineBoardKey({ ...entry, sizeId })) === true;
    }
    // No size on the key: accept only if some scope of this board and layout
    // was already resolved as downloaded for the list queries.
    for (const [scopeKey, isDownloaded] of downloaded) {
      if (!isDownloaded) continue;
      const scope = parseOfflineBoardKey(scopeKey);
      if (scope?.boardType === entry.boardType && scope.layoutId === entry.layoutId) return true;
    }
    return false;
  });
}

export type ClimbStatsLiveSyncOptions = {
  /** Null until migrations publish the handle, and again after a hot reload. */
  getDb: () => OfflineDatabase | null;
  queryClient: QueryClient;
  isScopeDownloaded: (db: OfflineDatabase, scope: OfflineBoardScope) => Promise<boolean>;
  /** Mobile: backgrounded or signing out. Both mean "do not touch SQLite". */
  shouldSkipWrites: () => boolean;
  /**
   * Board-level, not layout-level, and deliberately so: a reconciliation row's
   * layout label comes from the selector's key rather than from the climb, so
   * it cannot be trusted to gate anything. The batched pre-read's primary-key
   * miss handles a wrong layout for the price of one row in an IN list.
   */
  hasEnabledScopeForBoard: (boardType: string) => boolean;
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
  // Insertion-ordered, so the oldest key is the one evicted at the cap.
  const settledRevisions = new Map<string, { revision: number; at: number }>();
  // The handle the memo was built against. A different one means a new database
  // session — a sign-out wipe and re-open, or a hot reload — whose rows this
  // module has never seen.
  let memoDbHandle: OfflineDatabase | null = null;

  let draining = false;
  let disposed = false;
  let hasReportedError = false;
  let cancelTrailing: (() => void) | null = null;
  let cancelMaxWait: (() => void) | null = null;
  let cancelRetryDrain: (() => void) | null = null;
  let retryDrainNotBefore = 0;

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

  /** Remember that the local row is at least this revision. */
  function rememberSettledRevision(key: string, syncSeq: string): void {
    const revision = Number(syncSeq);
    if (!Number.isFinite(revision)) return;
    // Delete first so the re-insert moves the key to the young end.
    settledRevisions.delete(key);
    settledRevisions.set(key, { revision, at: Date.now() });
    while (settledRevisions.size > CLIMB_STATS_TRACKED_REVISIONS) {
      const oldest = settledRevisions.keys().next();
      if (oldest.done) break;
      settledRevisions.delete(oldest.value);
    }
  }

  /**
   * Forget everything remembered against a database this module is no longer
   * talking to. A sign-out wipe and re-open, or a hot reload, publishes a new
   * handle over rows the memo has never seen.
   */
  function resetMemoOnNewHandle(db: OfflineDatabase): void {
    if (memoDbHandle === db) return;
    memoDbHandle = db;
    settledRevisions.clear();
  }

  /** True when SQLite already holds this revision, so the write can only be a no-op. */
  function alreadySettled(event: ClimbStatsWriteThroughInput): boolean {
    const key = pendingKey(event);
    const known = settledRevisions.get(key);
    if (known === undefined) return false;
    // Another writer can delete these rows without telling us. Expiring the
    // memo bounds how long a remove + re-download inside one session can keep
    // discarding the republish that would heal it.
    if (Date.now() - known.at >= CLIMB_STATS_REVISION_MEMO_TTL_MS) {
      settledRevisions.delete(key);
      return false;
    }
    const revision = Number(event.syncSeq);
    // An unparseable revision falls through to the writer, which reports it as
    // `invalid_revision` rather than being silently swallowed here.
    return Number.isFinite(revision) && revision <= known.revision;
  }

  /**
   * The higher of two revisions for the same key, so a queue slot never moves
   * backwards. A reconciliation row is a server snapshot taken BEFORE the
   * recompute the stream already published, so latest-arrival-wins would let a
   * revision 100 replace a queued 101 and lose it entirely.
   */
  function keepNewerEvent(
    queued: ClimbStatsWriteThroughInput | undefined,
    arriving: ClimbStatsWriteThroughInput,
  ): ClimbStatsWriteThroughInput {
    if (!queued) return arriving;
    const queuedRevision = parseClimbStatsRevision(queued.syncSeq);
    const arrivingRevision = parseClimbStatsRevision(arriving.syncSeq);
    // An unparseable revision loses to a parseable one, and two unparseable
    // ones keep the arrival — the writer reports it as `invalid_revision`.
    if (queuedRevision === null) return arriving;
    if (arrivingRevision === null) return queued;
    return arrivingRevision >= queuedRevision ? arriving : queued;
  }

  /** Queue an event, keeping the newer of it and whatever already sat on its key. */
  function enqueueEvent(event: ClimbStatsWriteThroughInput): void {
    const key = pendingKey(event);
    const kept = keepNewerEvent(pendingEvents.get(key), event);
    // Delete first so a replaced key moves to the young end and the drop-oldest
    // eviction below stays a real FIFO.
    pendingEvents.delete(key);
    pendingEvents.set(key, kept);
    while (pendingEvents.size > CLIMB_STATS_MAX_PENDING_EVENTS) {
      const oldest = pendingEvents.keys().next();
      if (oldest.done) break;
      pendingEvents.delete(oldest.value);
    }
  }

  function armFlushTimers(): void {
    if (disposed) return;
    if (!cancelMaxWait) {
      cancelMaxWait = scheduleTask(() => {
        cancelMaxWait = null;
        void flush();
      }, CLIMB_STATS_INVALIDATE_MAX_WAIT_MS);
    }
    cancelTrailing?.();
    cancelTrailing = scheduleTask(() => {
      cancelTrailing = null;
      void flush();
    }, CLIMB_STATS_INVALIDATE_TRAILING_MS);
  }

  function armFlush(event: ClimbStatsWriteThroughInput, layoutId: number, compatibleSizeIds: number[] | null): void {
    flushedStats.set(pendingKey(event), {
      boardType: event.boardType,
      layoutId,
      climbUuid: event.climbUuid,
      angle: event.angle,
      compatibleSizeIds,
    });
    armFlushTimers();
  }

  /**
   * Probe each distinct offline scope that is cached AND could be affected by
   * this batch — typically one, the board being browsed. A scope the device
   * never downloaded is served over the network and must not be invalidated;
   * a scope no entry in the batch belongs to cannot change either way, so it is
   * not worth a `board_climbs` EXISTS probe.
   */
  async function downloadedScopes(
    db: OfflineDatabase,
    roots: readonly (readonly string[])[],
    batch: readonly FlushedClimbStat[],
  ): Promise<Map<string, boolean>> {
    const downloaded = new Map<string, boolean>();
    const cache = options.queryClient.getQueryCache();
    for (const root of roots) {
      for (const query of cache.findAll({ queryKey: root })) {
        const scope = searchInputScope(query.queryKey[1]);
        if (!scope || !batchTouchesScope(scope, batch)) continue;
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
    const downloaded = await downloadedScopes(db, roots, batch);
    if (disposed) return;

    for (const root of roots) {
      if (root[0] === CLIMB_DETAIL_KEY_ROOT) {
        void options.queryClient.invalidateQueries({
          queryKey: root,
          predicate: (query: Query) => climbDetailMatchesBatch(query.queryKey[1], batch, downloaded),
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

    // Transient gates BEFORE the batch is consumed, and they arm nothing: the
    // ceiling re-arming itself here would tick forever while the app sits
    // backgrounded. The batch stays pending and `handleEvent` re-arms the
    // trailing timer on the next event, which is also the first moment the app
    // can be in the foreground again.
    if (options.shouldSkipWrites()) return;
    const db = options.getDb();
    if (!db) return;

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

  /** One pending re-drain, for the backoff after contention. */
  function scheduleRetryDrain(delayMs: number): void {
    if (disposed || cancelRetryDrain) return;
    cancelRetryDrain = scheduleTask(
      () => {
        cancelRetryDrain = null;
        void drain();
      },
      Math.max(0, delayMs),
    );
  }

  async function drain(): Promise<void> {
    if (draining) return;
    // Standing down after contention. Every event that arrives inside the
    // window would otherwise re-drive the whole pending map: a full pre-read
    // pass, a fresh native connection and another 250 ms lock wait.
    const waitMs = retryDrainNotBefore - Date.now();
    if (waitMs > 0) {
      scheduleRetryDrain(waitMs);
      return;
    }
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
          // No timer: re-driving costs nothing until a handle exists, and the
          // next event is the cheapest possible trigger.
          requeue(keys, events);
          break;
        }

        let results: ClimbStatsWriteThroughResult[];
        try {
          results = await writeEvents(db, events);
        } catch (error) {
          // A broken database is worth one report per session, not one per
          // event on a chatty layout channel. Contention never lands here —
          // writeClimbStatsEvents returns `lock_lost` for it. The events of
          // this pass are dropped, deliberately: they are disposable (the next
          // pull carries the same rows) and requeuing against a database that
          // just threw would only repeat the failure on every arrival.
          reportFirstError(error);
          continue;
        }
        if (disposed) break;

        let lostLock = false;
        for (const [index, result] of results.entries()) {
          const event = events[index];
          if (result.status === 'lock_lost') {
            lostLock = true;
            continue;
          }
          // Only what the PRE-READ settled. `applied` means the row is now at
          // this revision; a `stale` from the pre-read means it already was. A
          // `stale` from the WRITE means the upsert matched nothing, which
          // happens when the climb vanished — there may be no row at all, so
          // remembering it would suppress the republish that heals a
          // re-download.
          if (result.status === 'applied' || (result.status === 'stale' && result.settledBy === 'pre_read')) {
            rememberSettledRevision(keys[index], event.syncSeq);
          }
          if (result.status !== 'applied') continue;
          // The climb's OWN layout, never the event's: a reconciliation read
          // labels its rows with the layout the user is browsing.
          if (result.layoutId === null) continue;
          armFlush(event, result.layoutId, result.compatibleSizeIds);
        }
        if (lostLock) {
          // Another writer holds the file (a VACUUM or a snapshot import can
          // hold it for 5-20 s). Keep the events, stand down, and let one timer
          // retry rather than every arriving event.
          requeue(
            keys.filter((_key, index) => results[index]?.status === 'lock_lost'),
            events.filter((_event, index) => results[index]?.status === 'lock_lost'),
          );
          retryDrainNotBefore = Date.now() + CLIMB_STATS_LOCK_BACKOFF_MS;
          scheduleRetryDrain(CLIMB_STATS_LOCK_BACKOFF_MS);
          break;
        }
      }
    } finally {
      draining = false;
    }
  }

  /**
   * Put unwritten events back. A newer payload can have arrived for the same key
   * while the write was in flight, so the higher revision wins rather than the
   * later arrival.
   */
  function requeue(keys: readonly string[], events: readonly ClimbStatsWriteThroughInput[]): void {
    for (const [index, key] of keys.entries()) {
      const kept = keepNewerEvent(pendingEvents.get(key), events[index]);
      // A requeued event goes back at the young end only when it wins; an
      // already-queued newer one keeps its place.
      if (kept === pendingEvents.get(key)) continue;
      pendingEvents.delete(key);
      pendingEvents.set(key, kept);
    }
  }

  return {
    handleEvent(event) {
      if (disposed) return;
      if (options.shouldSkipWrites()) return;
      // The cheap pre-gate: a board with no opted-in scope at all can never
      // have a local row worth writing, and that is the common case on a global
      // channel. Board-level only — the event's layout label is the browsed
      // layout on a reconciliation row, not the climb's.
      if (!options.hasEnabledScopeForBoard(event.boardType)) return;
      // A batch left pending by a transient flush gate has no timer of its own.
      // This is the first moment the app can be foregrounded again, so re-arm.
      if (flushedStats.size > 0 && !cancelTrailing && !cancelMaxWait) armFlushTimers();
      // Checked where the memo is READ, not where it is written: a handle
      // swapped between two events must not let the first one's memory decide
      // the second.
      const db = options.getDb();
      if (db) resetMemoOnNewHandle(db);
      if (alreadySettled(event)) return;
      enqueueEvent(event);
      // Deferred, not immediate: a synchronous burst (a reconciliation pass
      // delivers its rows in one loop) would otherwise send its first event
      // alone and batch only the remainder.
      queueMicrotask(() => {
        void drain();
      });
    },
    dispose() {
      disposed = true;
      cancelTimers();
      cancelRetryDrain?.();
      cancelRetryDrain = null;
      pendingEvents.clear();
      flushedStats.clear();
      settledRevisions.clear();
      memoDbHandle = null;
    },
  };
}
