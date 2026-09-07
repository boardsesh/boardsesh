import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { BoardName } from '@boardsesh/shared-schema';
import { parseRateLimitError } from '@boardsesh/graphql-client';
import type { BoardAdapter } from './adapter';
import { useBoardAdapter } from './adapter';
import {
  applyCanonicalClimbStats,
  getAcknowledgedClimbStatsTokens,
  getClimbStatsSnapshot,
  getRetainedClimbStatsKeys,
  isClimbStatsReadRetained,
  retireAcknowledgedOptimisticAscents,
  setClimbStatsAuthEpoch,
  settleOfflineTickAscent,
  subscribeClimbStats,
  type ClimbStatsKey,
} from './climb-stats-store';

type QueuedRead = {
  adapter: BoardAdapter;
  key: ClimbStatsKey;
  layoutIds: Set<number>;
  force: boolean;
  acknowledgedTokens: Set<string>;
  authEpoch: number;
  rateLimitRetried: boolean;
  promise: Promise<void>;
  waiters: Set<() => void>;
};

type ReadGroup = {
  adapter: BoardAdapter;
  boardType: string;
  reads: Map<string, QueuedRead>;
  rateLimitPause: RateLimitPause | null;
};

type RateLimitPause = {
  ready: boolean;
  timerPending: boolean;
  cancelTask: () => void;
  generation: number;
};

type ActiveBatch = {
  adapter: BoardAdapter;
  boardType: string;
  reads: QueuedRead[];
  group: ReadGroup;
  isRateLimitRetry: boolean;
};

const queuedGroups = new Map<BoardAdapter, Map<string, ReadGroup>>();
const lastReadAt = new Map<string, number>();
const READ_COOLDOWN_MS = 30_000;
const LAST_READ_TTL_MS = 10 * 60_000;
/** @internal Hard bound for the climb-stats read coordinator's LRU timestamps. */
export const MAX_LAST_READ_ENTRIES = 500;
const MAX_BATCH_SIZE = 50;
const RECONCILIATION_INTERVAL_MS = 120_000;
let activeBatch: ActiveBatch | null = null;
let drainScheduled = false;
let coordinatorGeneration = 0;

function readKey(boardType: string, climbUuid: string): string {
  return `${boardType}\u0000${climbUuid}`;
}

function pruneLastReadAt(now: number): void {
  for (const [serialized, readAt] of lastReadAt) {
    if (now - readAt > LAST_READ_TTL_MS) lastReadAt.delete(serialized);
  }
  while (lastReadAt.size > MAX_LAST_READ_ENTRIES) {
    const oldest = lastReadAt.keys().next().value;
    if (typeof oldest !== 'string') break;
    lastReadAt.delete(oldest);
  }
}

function recentReadAt(serialized: string, now: number): number | undefined {
  pruneLastReadAt(now);
  const readAt = lastReadAt.get(serialized);
  if (readAt != null) {
    // Map insertion order is the LRU order. A cooldown hit is still a use.
    lastReadAt.delete(serialized);
    lastReadAt.set(serialized, readAt);
  }
  return readAt;
}

function recordReadAt(serialized: string, now: number): void {
  lastReadAt.delete(serialized);
  lastReadAt.set(serialized, now);
  pruneLastReadAt(now);
}

function completeRead(read: QueuedRead): void {
  for (const resolve of read.waiters) resolve();
  read.waiters.clear();
}

function queuedReadCount(): number {
  let count = 0;
  for (const boardGroups of queuedGroups.values()) {
    for (const group of boardGroups.values()) count += group.reads.size;
  }
  return count;
}

function getReadGroup(adapter: BoardAdapter, boardType: string, create: boolean): ReadGroup | undefined {
  let boardGroups = queuedGroups.get(adapter);
  if (!boardGroups && create) {
    boardGroups = new Map();
    queuedGroups.set(adapter, boardGroups);
  }
  let group = boardGroups?.get(boardType);
  if (!group && create && boardGroups) {
    group = { adapter, boardType, reads: new Map(), rateLimitPause: null };
    boardGroups.set(boardType, group);
  }
  return group;
}

function deleteGroupIfEmpty(group: ReadGroup): void {
  if (group.reads.size > 0 || group.rateLimitPause) return;
  const boardGroups = queuedGroups.get(group.adapter);
  // An active request can outlive the group object that dispatched it. Never
  // let cleanup of that stale owner delete a replacement lane created under
  // the same adapter+board key.
  if (boardGroups?.get(group.boardType) !== group) return;
  boardGroups.delete(group.boardType);
  if (boardGroups?.size === 0) queuedGroups.delete(group.adapter);
}

function clearRateLimitPause(group: ReadGroup): void {
  const pause = group.rateLimitPause;
  if (!pause) return;
  group.rateLimitPause = null;
  if (pause.timerPending) pause.cancelTask();
  deleteGroupIfEmpty(group);
}

function completeQueuedGroupReads(group: ReadGroup): void {
  for (const read of group.reads.values()) completeRead(read);
  group.reads.clear();
}

function completeQueuedGroupReadsForAuthEpochs(group: ReadGroup, authEpochs: ReadonlySet<number>): void {
  for (const [climbUuid, read] of group.reads) {
    if (!authEpochs.has(read.authEpoch)) continue;
    group.reads.delete(climbUuid);
    completeRead(read);
  }
  deleteGroupIfEmpty(group);
}

function groupOwnsActiveRateLimitRetry(group: ReadGroup): boolean {
  return activeBatch?.isRateLimitRetry === true && activeBatch.group === group;
}

function clearEmptyRateLimitPause(group: ReadGroup): void {
  if (group.reads.size > 0 || groupOwnsActiveRateLimitRetry(group)) return;
  clearRateLimitPause(group);
}

function createQueuedRead(
  adapter: BoardAdapter,
  key: ClimbStatsKey,
  force: boolean,
  acknowledgedTokens: Iterable<string>,
): QueuedRead {
  let resolveRead = () => {};
  const promise = new Promise<void>((resolve) => {
    resolveRead = resolve;
  });
  return {
    adapter,
    key,
    layoutIds: new Set([key.layoutId]),
    force,
    acknowledgedTokens: new Set(acknowledgedTokens),
    authEpoch: adapter.captureAuthEpoch?.() ?? 0,
    rateLimitRetried: false,
    promise,
    waiters: new Set([resolveRead]),
  };
}

function mergeQueuedRead(target: QueuedRead, source: QueuedRead): void {
  for (const layoutId of source.layoutIds) target.layoutIds.add(layoutId);
  for (const token of source.acknowledgedTokens) target.acknowledgedTokens.add(token);
  for (const waiter of source.waiters) target.waiters.add(waiter);
  target.force ||= source.force;
  target.rateLimitRetried ||= source.rateLimitRetried;
}

function enqueueRead(read: QueuedRead): QueuedRead {
  const group = getReadGroup(read.adapter, read.key.boardType, true);
  if (!group) return read;
  const existing = group.reads.get(read.key.climbUuid);
  if (existing) {
    if (existing.authEpoch === read.authEpoch) {
      mergeQueuedRead(existing, read);
      return existing;
    }
    group.reads.delete(read.key.climbUuid);
    completeRead(existing);
  }
  group.reads.set(read.key.climbUuid, read);
  scheduleDrainReadQueue();
  return read;
}

function scheduleDrainReadQueue(): void {
  if (activeBatch || drainScheduled) return;
  drainScheduled = true;
  void Promise.resolve().then(() => {
    drainScheduled = false;
    drainReadQueue();
  });
}

function readIsCurrent(read: QueuedRead): boolean {
  return read.adapter.isAuthEpochCurrent?.(read.authEpoch) ?? true;
}

function pruneUnusableQueuedReads(): void {
  const now = Date.now();
  for (const boardGroups of queuedGroups.values()) {
    for (const group of boardGroups.values()) {
      for (const [climbUuid, read] of group.reads) {
        const serialized = readKey(group.boardType, climbUuid);
        const recent = read.force ? undefined : recentReadAt(serialized, now);
        if (
          !read.adapter.isAuthenticated ||
          !read.adapter.fetchClimbStatsForClimbs ||
          !readIsCurrent(read) ||
          !isClimbStatsReadRetained(group.boardType, climbUuid) ||
          (recent != null && now - recent < READ_COOLDOWN_MS)
        ) {
          group.reads.delete(climbUuid);
          completeRead(read);
        }
      }
      // Cancel a waiting timer when the lane empties, but keep the owner while
      // its physical retry is active so a new same-lane read cannot bypass the
      // terminal outcome through a replacement group.
      clearEmptyRateLimitPause(group);
      deleteGroupIfEmpty(group);
    }
  }
}

function takeReads(
  group: ReadGroup,
  predicate: (read: QueuedRead) => boolean,
  isRateLimitRetry: boolean,
): ActiveBatch | null {
  const reads: QueuedRead[] = [];
  for (const [climbUuid, read] of group.reads) {
    if (!predicate(read)) continue;
    group.reads.delete(climbUuid);
    reads.push(read);
    if (reads.length === MAX_BATCH_SIZE) break;
  }
  if (reads.length === 0) return null;
  deleteGroupIfEmpty(group);
  return { adapter: group.adapter, boardType: group.boardType, reads, group, isRateLimitRetry };
}

function takeNextBatch(): ActiveBatch | null {
  pruneUnusableQueuedReads();

  // A whole lane sleeps behind one timer. Once it opens, retry precisely the
  // failed physical batch as one coalesced request before later lane chunks.
  for (const boardGroups of queuedGroups.values()) {
    for (const group of boardGroups.values()) {
      if (!group.rateLimitPause?.ready) continue;
      const retryBatch = takeReads(group, (read) => read.rateLimitRetried, true);
      if (retryBatch) return retryBatch;
      // Every affected key may have unmounted while later keys stayed queued.
      // They still waited out retryAfter; now the unaffected work may proceed.
      clearRateLimitPause(group);
    }
  }

  let selectedGroup: ReadGroup | undefined;
  let forcedOnly = false;
  for (const boardGroups of queuedGroups.values()) {
    for (const group of boardGroups.values()) {
      if (group.rateLimitPause) continue;
      if ([...group.reads.values()].some((read) => read.force)) {
        selectedGroup = group;
        forcedOnly = true;
        break;
      }
    }
    if (selectedGroup) break;
  }
  if (!selectedGroup) {
    for (const boardGroups of queuedGroups.values()) {
      for (const group of boardGroups.values()) {
        if (!group.rateLimitPause && group.reads.size > 0) {
          selectedGroup = group;
          break;
        }
      }
      if (selectedGroup) break;
    }
  }
  if (!selectedGroup) return null;

  return takeReads(selectedGroup, (read) => !forcedOnly || read.force, false);
}

function pauseRateLimitedLane(batch: ActiveBatch, retryAfterSeconds: number | null, generation: number): void {
  const group = getReadGroup(batch.adapter, batch.boardType, true);
  if (!group) {
    for (const read of batch.reads) completeRead(read);
    return;
  }

  const rejectionBelongsToCurrentAuth = batch.reads.some((read) => read.adapter.isAuthenticated && readIsCurrent(read));
  for (const read of batch.reads) {
    if (
      !read.adapter.isAuthenticated ||
      !readIsCurrent(read) ||
      !isClimbStatsReadRetained(batch.boardType, read.key.climbUuid)
    ) {
      completeRead(read);
      continue;
    }
    read.rateLimitRetried = true;
    const existing = group.reads.get(read.key.climbUuid);
    if (!existing) {
      group.reads.set(read.key.climbUuid, read);
    } else if (existing.authEpoch === read.authEpoch) {
      mergeQueuedRead(existing, read);
      existing.rateLimitRetried = true;
    } else {
      // Never let an old-auth rejection replace a newer caller's queued read.
      completeRead(read);
    }
  }

  // A late rejection from the previous account must neither retry nor pause
  // reads already queued for the replacement auth generation.
  if (!rejectionBelongsToCurrentAuth) {
    deleteGroupIfEmpty(group);
    return;
  }

  // There may be later chunks waiting even if every failed key unmounted. They
  // share the same server bucket and must not bypass retryAfter.
  if (group.reads.size === 0 || group.rateLimitPause) {
    deleteGroupIfEmpty(group);
    return;
  }

  const delayMs = Math.max(1, retryAfterSeconds ?? 1) * 1_000;
  const pause: RateLimitPause = {
    ready: false,
    timerPending: true,
    cancelTask: () => {},
    generation,
  };
  group.rateLimitPause = pause;

  let registered = false;
  let ranSynchronously = false;
  const openLane = () => {
    if (!registered) ranSynchronously = true;
    if (group.rateLimitPause !== pause || pause.generation !== coordinatorGeneration) return;
    pause.timerPending = false;
    pause.ready = true;
    scheduleDrainReadQueue();
  };
  let cancelTask: () => void;
  if (batch.adapter.scheduleTask) {
    cancelTask = batch.adapter.scheduleTask(openLane, delayMs);
  } else {
    const timer = setTimeout(openLane, delayMs);
    cancelTask = () => clearTimeout(timer);
  }
  registered = true;
  if (!ranSynchronously) pause.cancelTask = cancelTask;
}

function applyBatchRows(
  batch: ActiveBatch,
  rows: Awaited<ReturnType<NonNullable<BoardAdapter['fetchClimbStatsForClimbs']>>>,
): void {
  const rowsByClimbUuid = new Map<string, typeof rows>();
  for (const row of rows) {
    const climbRows = rowsByClimbUuid.get(row.climbUuid) ?? [];
    climbRows.push(row);
    rowsByClimbUuid.set(row.climbUuid, climbRows);
  }

  const now = Date.now();
  for (const read of batch.reads) {
    if (!readIsCurrent(read)) {
      completeRead(read);
      continue;
    }
    recordReadAt(readKey(batch.boardType, read.key.climbUuid), now);
    for (const row of rowsByClimbUuid.get(read.key.climbUuid) ?? []) {
      for (const layoutId of read.layoutIds) {
        applyCanonicalClimbStats({
          boardType: batch.boardType,
          layoutId,
          ...row,
          ascensionistCount: row.ascensionistCount ?? 0,
        });
      }
    }
    retireAcknowledgedOptimisticAscents(read.acknowledgedTokens, read.authEpoch);
    completeRead(read);
  }
}

function finishFailedRateLimitRetry(batch: ActiveBatch): void {
  const failedAuthEpochs = new Set(batch.reads.map((read) => read.authEpoch));
  const currentGroup = getReadGroup(batch.adapter, batch.boardType, false);

  // Same-auth work that arrived behind the retry belongs to the exhausted lane
  // attempt and is dropped. A newer auth generation is independent: preserve
  // it so it can use the global slot once the old physical retry settles.
  completeQueuedGroupReadsForAuthEpochs(batch.group, failedAuthEpochs);
  if (currentGroup && currentGroup !== batch.group) {
    completeQueuedGroupReadsForAuthEpochs(currentGroup, failedAuthEpochs);
  }
  clearRateLimitPause(batch.group);
}

function drainReadQueue(): void {
  if (activeBatch) return;
  const batch = takeNextBatch();
  if (!batch) return;
  const fetchClimbStatsForClimbs = batch.adapter.fetchClimbStatsForClimbs;
  if (!fetchClimbStatsForClimbs) {
    for (const read of batch.reads) completeRead(read);
    scheduleDrainReadQueue();
    return;
  }

  // Capture durable post-ack obligations at the request boundary. Anything
  // acknowledged after this point belongs to a later successful primary read.
  for (const read of batch.reads) {
    for (const token of getAcknowledgedClimbStatsTokens(batch.boardType, read.key.climbUuid, read.authEpoch)) {
      read.acknowledgedTokens.add(token);
    }
  }

  activeBatch = batch;
  const generation = coordinatorGeneration;
  void fetchClimbStatsForClimbs(
    batch.boardType,
    batch.reads.map((read) => read.key.climbUuid),
  )
    .then((rows) => {
      if (generation !== coordinatorGeneration) return;
      if (batch.isRateLimitRetry) clearRateLimitPause(batch.group);
      applyBatchRows(batch, rows);
    })
    .catch((error: unknown) => {
      if (generation !== coordinatorGeneration) return;
      const rateLimit = parseRateLimitError(error);
      if (rateLimit && !batch.isRateLimitRetry) {
        pauseRateLimitedLane(batch, rateLimit.retryAfterSeconds, generation);
        return;
      }
      for (const read of batch.reads) completeRead(read);
      if (!batch.isRateLimitRetry) return;

      // The lane already consumed its single retry. Do not let chunks queued
      // behind it immediately hammer the same exhausted server bucket. Their
      // acknowledged mutations remain durable and a later reconciliation can
      // establish a fresh lane attempt.
      finishFailedRateLimitRetry(batch);
    })
    .finally(() => {
      if (generation !== coordinatorGeneration) return;
      activeBatch = null;
      scheduleDrainReadQueue();
    });
}

function readCanonicalClimbStats(
  adapter: BoardAdapter,
  key: ClimbStatsKey,
  force = false,
  acknowledgedTokens: Iterable<string> = [],
): Promise<void> {
  if (!adapter.fetchClimbStatsForClimbs || !adapter.isAuthenticated) return Promise.resolve();
  const authEpoch = adapter.captureAuthEpoch?.() ?? 0;
  const activeRead =
    activeBatch?.adapter === adapter && activeBatch.boardType === key.boardType
      ? activeBatch.reads.find((read) => read.key.climbUuid === key.climbUuid && read.authEpoch === authEpoch)
      : undefined;
  if (activeRead && !force) {
    activeRead.layoutIds.add(key.layoutId);
    return activeRead.promise;
  }

  const group = getReadGroup(adapter, key.boardType, false);
  const alreadyQueued = group?.reads.get(key.climbUuid);
  if (alreadyQueued && alreadyQueued.authEpoch === authEpoch) {
    alreadyQueued.layoutIds.add(key.layoutId);
    alreadyQueued.force ||= force;
    for (const token of acknowledgedTokens) alreadyQueued.acknowledgedTokens.add(token);
    return alreadyQueued.promise;
  }

  const read = createQueuedRead(adapter, key, force, acknowledgedTokens);
  enqueueRead(read);
  return read.promise;
}

function discardReadIfUnretained(key: ClimbStatsKey): void {
  if (isClimbStatsReadRetained(key.boardType, key.climbUuid)) return;
  for (const boardGroups of queuedGroups.values()) {
    const group = boardGroups.get(key.boardType);
    const read = group?.reads.get(key.climbUuid);
    if (!group || !read) continue;
    group.reads.delete(key.climbUuid);
    completeRead(read);
    clearEmptyRateLimitPause(group);
    deleteGroupIfEmpty(group);
  }
}

async function refreshRetainedClimbStats(adapter: BoardAdapter, boardType: string, layoutId: number): Promise<void> {
  const unique = new Map<string, ClimbStatsKey>();
  for (const key of getRetainedClimbStatsKeys(boardType, layoutId)) unique.set(key.climbUuid, key);
  await Promise.all([...unique.values()].map((key) => readCanonicalClimbStats(adapter, key, true)));
}

export type EffectiveClimbStats = {
  ascensionistCount: number;
  qualityAverage: string | null;
  difficulty: string | null;
};

export type EffectiveClimbStatsBase = {
  ascensionistCount?: number | null;
  qualityAverage?: string | null;
  difficulty?: string | null;
};

/**
 * Exact-key selector over the renderer-neutral live-stats store. Only the
 * component calling this hook re-renders; row thumbnails/gesture shells do not
 * subscribe. The snapshot object is stable until this exact key changes.
 */
export function useEffectiveClimbStats(
  boardType: BoardName,
  layoutId: number,
  climbUuid: string,
  angle: number,
  base: EffectiveClimbStatsBase,
): EffectiveClimbStats {
  const adapter = useBoardAdapter();
  const key = useMemo<ClimbStatsKey>(
    () => ({ boardType, layoutId, climbUuid, angle }),
    [boardType, layoutId, climbUuid, angle],
  );
  const subscribe = useCallback((listener: () => void) => subscribeClimbStats(key, listener), [key]);
  const getSnapshot = useCallback(() => getClimbStatsSnapshot(key), [key]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    void readCanonicalClimbStats(adapter, key);
    return () => {
      // React releases the external-store subscription in a separate cleanup.
      // Check retention in the next microtask so a row that was queued and then
      // unmounted is removed before an active read frees a scheduler slot.
      void Promise.resolve().then(() => discardReadIfUnretained(key));
    };
  }, [adapter, key]);

  const canonical = snapshot.canonical;
  const canonicalCount = canonical?.ascensionistCount ?? 0;
  const baseCount = base.ascensionistCount ?? 0;
  return {
    // The list/search base is only bootstrap data. Once a revision-gated
    // canonical row exists it is authoritative even when the count decreased
    // to zero; only an outstanding mutation floor may temporarily exceed it.
    ascensionistCount: canonical
      ? Math.max(canonicalCount, snapshot.optimisticFloor ?? canonicalCount)
      : Math.max(baseCount, snapshot.optimisticFloor ?? baseCount),
    // Once a canonical object exists, its nulls are authoritative removals.
    // Falling back field-by-field would resurrect a stale list/search value.
    qualityAverage: canonical
      ? canonical.qualityAverage == null
        ? null
        : String(canonical.qualityAverage)
      : (base.qualityAverage ?? null),
    difficulty: canonical ? canonical.difficulty : (base.difficulty ?? null),
  };
}

/** Mount once in BoardProvider: one layout stream over the mobile singleton WS. */
export function useClimbStatsLayoutSync(boardType: BoardName | null, layoutId: number | undefined): void {
  const adapter = useBoardAdapter();
  const authEpoch = adapter.captureAuthEpoch?.() ?? 0;

  useEffect(() => {
    setClimbStatsAuthEpoch(authEpoch);
  }, [authEpoch]);

  useEffect(() => {
    if (!adapter.subscribeOfflineMutationDelivery) return undefined;
    const acknowledgedReadOwner = createAcknowledgedClimbStatsReadOwner();
    const unsubscribe = adapter.subscribeOfflineMutationDelivery((event) => {
      if (event.tableName !== 'boardsesh_ticks' || event.operation !== 'create') return;
      const settled = settleOfflineTickAscent(event.idempotencyKey, event.status, authEpoch);
      if (settled?.status === 'acknowledged') {
        acknowledgedReadOwner.schedule(adapter, settled.key, settled.token);
      }
    });
    return () => {
      unsubscribe();
      acknowledgedReadOwner.cancelAll();
    };
  }, [adapter, authEpoch]);

  useEffect(() => {
    if (!boardType || !layoutId || !adapter.isAuthenticated || !adapter.subscribeClimbStats) return undefined;
    const refresh = () => {
      void refreshRetainedClimbStats(adapter, boardType, layoutId);
    };
    const unsubscribe = adapter.subscribeClimbStats(boardType, layoutId, {
      next: (event) => {
        if (event.boardType !== boardType || event.layoutId !== layoutId) return;
        applyCanonicalClimbStats(event);
        // After the store, and unconditionally: the store keeps only the keys a
        // mounted selector retains, while the local catalog needs every event
        // for the board the user is browsing. Mobile supplies this; web omits it.
        adapter.persistClimbStatsEvent?.(event);
      },
      connected: refresh,
      // Redis-required subscription setup failures surface as operation errors.
      // A bounded primary refresh repairs retained keys while graphql-ws retries.
      error: refresh,
    });
    refresh();
    // Redis PUBLISH is intentionally fail-open and operation-level errors can
    // occur without closing the singleton socket. A low-frequency bounded
    // primary pass repairs that otherwise-undetectable missed-event case.
    let cancelReconciliation: (() => void) | undefined;
    const scheduleReconciliation = () => {
      cancelReconciliation = adapter.scheduleTask?.(() => {
        refresh();
        scheduleReconciliation();
      }, RECONCILIATION_INTERVAL_MS);
    };
    scheduleReconciliation();
    return () => {
      cancelReconciliation?.();
      unsubscribe();
    };
  }, [adapter, boardType, layoutId]);
}

/** Schedule the post-ack safety read that covers a lost Redis publish. */
export function scheduleAcknowledgedClimbStatsRead(
  adapter: BoardAdapter,
  key: ClimbStatsKey,
  onReadStarted?: () => void,
  acknowledgedToken?: string,
): () => void {
  let pending = true;
  const startRead = () => {
    if (!pending) return;
    pending = false;
    onReadStarted?.();
    void readCanonicalClimbStats(adapter, key, true, acknowledgedToken ? [acknowledgedToken] : []);
  };
  if (!adapter.scheduleTask) {
    startRead();
    return () => {};
  }
  const cancelTask = adapter.scheduleTask(startRead, 3_000);
  return () => {
    if (!pending) return;
    pending = false;
    cancelTask();
  };
}

/** Own any number of post-ack reads and cancel those still pending at teardown. */
export function createAcknowledgedClimbStatsReadOwner(): {
  schedule: (adapter: BoardAdapter, key: ClimbStatsKey, acknowledgedToken?: string) => void;
  cancelAll: () => void;
} {
  const cancelScheduledReads = new Set<() => void>();
  return {
    schedule: (adapter, key, acknowledgedToken) => {
      let cancelScheduledRead: (() => void) | null = null;
      let readStartedBeforeRegistration = false;
      cancelScheduledRead = scheduleAcknowledgedClimbStatsRead(
        adapter,
        key,
        () => {
          if (cancelScheduledRead) cancelScheduledReads.delete(cancelScheduledRead);
          else readStartedBeforeRegistration = true;
        },
        acknowledgedToken,
      );
      if (!readStartedBeforeRegistration) cancelScheduledReads.add(cancelScheduledRead);
    },
    cancelAll: () => {
      for (const cancelScheduledRead of cancelScheduledReads) cancelScheduledRead();
      cancelScheduledReads.clear();
    },
  };
}

export function resetClimbStatsReadCoordinatorForTests(): void {
  coordinatorGeneration += 1;
  for (const boardGroups of queuedGroups.values()) {
    for (const group of boardGroups.values()) {
      clearRateLimitPause(group);
      completeQueuedGroupReads(group);
    }
  }
  queuedGroups.clear();
  if (activeBatch) {
    for (const read of activeBatch.reads) completeRead(read);
  }
  activeBatch = null;
  drainScheduled = false;
  lastReadAt.clear();
}

/** Test-only coordinator bounds/debug state. */
export function getClimbStatsReadCoordinatorStateForTests(): {
  active: number;
  queued: number;
  timestamps: number;
} {
  return { active: activeBatch ? 1 : 0, queued: queuedReadCount(), timestamps: lastReadAt.size };
}

/** Test-only seam for the TTL/LRU timestamp bound without mounting 500 rows. */
export function recordClimbStatsReadForTests(serialized: string, readAt: number): void {
  recordReadAt(serialized, readAt);
}
