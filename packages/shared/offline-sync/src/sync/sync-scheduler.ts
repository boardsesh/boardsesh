import type { OfflineDatabase, QueryInvalidator } from '../database';
import {
  pullSync,
  type SyncProgress,
  type SchemaDriftReporter,
  type BootstrapMetadataChangedReporter,
  type ScopeDownloadCompleteReporter,
  type ScopeDownloadStartReporter,
  type CoverageResetReporter,
  type CoverageEvaluatedReporter,
  type BootstrapRetryScheduledReporter,
  type BootstrapPathRecoveredReporter,
  type BootstrapRetryWakeInfo,
} from './pull-client';
import type { SnapshotSource, SnapshotBootstrapErrorReporter } from './snapshot-bootstrap';
import { onPurgeSettled } from '../mutation-queue/drainer';
import { purgeNamespaceForScopeKey } from '../offline-board-key';

/**
 * Optional progress sink for the pull phase. The bridge passes the sync-status
 * store's `setSyncProgress` so the Settings screen can show live progress; when
 * omitted (tests, headless callers) the pull just runs silently.
 */
export type SyncProgressSink = (progress: SyncProgress) => void;

const FOREGROUND_DEBOUNCE_MS = 2000;

type GraphqlFetch = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

/**
 * Pushes any locally-queued mutations to the server. Threaded in by the caller
 * (typically `drainMutationQueue` bound to the live db/queryClient/fetch) so the
 * scheduler can flush local writes before pulling server state. Returns a
 * promise that resolves when the drain attempt finishes; rejection is tolerated
 * (the next trigger retries).
 */
export type DrainQueue = () => Promise<void>;

/**
 * Platform wake-up sources, injected so the package stays free of react-native
 * imports. Each subscribe returns an unsubscribe. The mobile adapter wires
 * AppState ('active' transitions) and NetInfo; the foreground debounce and the
 * offline→online edge detection live HERE, not in the adapter — they are the
 * tested scheduling logic.
 */
export type SchedulerTriggers = {
  /** Fires every time the app returns to the foreground. */
  subscribeForeground(callback: () => void): () => void;
  /** Fires on every connectivity change with the new connected state. */
  subscribeConnectivity(callback: (isConnected: boolean) => void): () => void;
};

export type SchedulerOptions = {
  onProgress?: SyncProgressSink;
  /**
   * Threaded through to pullSync's SyncOptions. Omitted → pullSync assumes
   * online, which is what every existing caller got. The offline→online edge
   * detection below stays the retry mechanism: a cycle skipped because the
   * probe said offline is re-run by `subscribeConnectivity` the moment the
   * device reconnects.
   */
  isOnline?: () => boolean;
  /** Public-snapshot-only mode for login-free profiles; see SyncOptions.catalogOnly. */
  catalogOnly?: boolean;
  /**
   * Called when a sync cycle throws. Observational only: a reporter that throws
   * is swallowed so it cannot suppress the failed-idle frame or the retry wake.
   */
  onCycleError?: (error: unknown) => void;
  /** Threaded through to pullSync — see SchemaDriftReporter. */
  onSchemaDrift?: SchemaDriftReporter;
  /** Threaded through to pullSync's SyncOptions — see snapshot-bootstrap.ts. */
  snapshotSource?: SnapshotSource;
  /** Threaded through to pullSync's SyncOptions. */
  onSnapshotBootstrapError?: SnapshotBootstrapErrorReporter;
  /** Threaded through to pullSync's SyncOptions. */
  onBootstrapMetadataChanged?: BootstrapMetadataChangedReporter;
  /** Threaded through to pullSync's SyncOptions — see ScopeDownloadCompleteInfo. */
  onScopeDownloadComplete?: ScopeDownloadCompleteReporter;
  onScopeDownloadStart?: ScopeDownloadStartReporter;
  /** Threaded through to pullSync's SyncOptions — see CoverageResetInfo. */
  onCoverageReset?: CoverageResetReporter;
  /** Threaded through to pullSync's SyncOptions — see CoverageEvaluatedInfo. */
  onCoverageEvaluated?: CoverageEvaluatedReporter;
  /** Threaded through to pullSync's SyncOptions — see BootstrapRetryScheduledInfo. */
  onBootstrapRetryScheduled?: BootstrapRetryScheduledReporter;
  /** Threaded through to pullSync's SyncOptions — see BootstrapPathRecoveredInfo. */
  onBootstrapPathRecovered?: BootstrapPathRecoveredReporter;
  /**
   * Threaded through to pullSync's SyncOptions. Only the automatic heal of a
   * partly-crawled scope consults it (issue #4313).
   */
  isOnUnmeteredNetwork?: () => boolean | Promise<boolean>;
};

let isSyncing = false;

type SyncRunRequest = {
  db: OfflineDatabase;
  queryClient: QueryInvalidator;
  graphqlFetch: GraphqlFetch;
  getEnabledBoards: () => string[];
  drainQueue: DrainQueue;
  options?: SchedulerOptions;
  schedulerOwner?: symbol;
};

// Latest-wins, not a boolean. A replacement scheduler can be mounted with a
// newly available snapshot source while the old cycle is still running; keeping
// only "something happened" made the follow-up reuse the OLD options and start
// the 500-row crawl anyway.
let pendingRunRequest: SyncRunRequest | null = null;

type RetryWakeCoordinator = {
  db: OfflineDatabase;
  owner: symbol;
  schedule(info: BootstrapRetryWakeInfo): void;
  clear(scopeKey: string): void;
  dispose(): void;
};

// One mobile bridge owns the scheduler, while ad-hoc download taps call
// `triggerSync`. Keeping the coordinator here lets either path arm the same
// timer without creating competing alarms.
let activeRetryWakeCoordinator: RetryWakeCoordinator | null = null;

// A cycle can fail outside snapshot bootstrap (queue drain, deletions, paged
// GraphQL, SQLite). Without its own wake, a foregrounded connected app had no
// reason to try again. Share the same exact-deadline coordinator so these
// failures cannot recreate the indefinite "Waiting to download" state.
const CYCLE_ERROR_RETRY_KEY = '__sync-cycle-error__';
const CYCLE_ERROR_RETRY_DELAY_MS = 30_000;

/**
 * Is a drain+pull cycle running right now? The scheduler's single-flight latch,
 * exposed so a caller can decide whether an exclusive-lock operation is safe to
 * start. `compactOfflineDatabase` is the one consumer: VACUUM holds an exclusive
 * lock for 5-20s on a 200-400MB database, which a concurrent snapshot import
 * would meet as SQLITE_BUSY and charge itself a structural failure for (issue
 * #4370).
 */
export function isSyncInFlight(): boolean {
  return isSyncing;
}

export function __resetSyncSchedulerStateForTests(): void {
  isSyncing = false;
  pendingRunRequest = null;
  activeRetryWakeCoordinator?.dispose();
  activeRetryWakeCoordinator = null;
}

// Each cycle does drain-first (push local mutations) then pull (fetch server
// state), so a write that failed to send is reattempted on every sync trigger
// — not just on the next user write (B12). Single-flight: concurrent triggers
// collapse into one in-flight run plus at most one queued follow-up.
async function runSync(request: SyncRunRequest): Promise<void> {
  if (isSyncing) {
    pendingRunRequest = request;
    return;
  }

  const { db, queryClient, graphqlFetch, getEnabledBoards, drainQueue, options } = request;
  isSyncing = true;
  try {
    // Push first so the subsequent pull reflects our own just-flushed writes.
    // A login-free catalog cycle is structurally read-only with respect to
    // personal server data: it must never inspect or drain an inherited outbox.
    if (!options?.catalogOnly) await drainQueue();
    await pullSync(db, queryClient, graphqlFetch, {
      enabledBoards: getEnabledBoards(),
      catalogOnly: options?.catalogOnly,
      isOnline: options?.isOnline,
      onProgress: options?.onProgress,
      onSchemaDrift: options?.onSchemaDrift,
      snapshotSource: options?.snapshotSource,
      onSnapshotBootstrapError: options?.onSnapshotBootstrapError,
      onBootstrapMetadataChanged: options?.onBootstrapMetadataChanged,
      onScopeDownloadComplete: options?.onScopeDownloadComplete,
      onScopeDownloadStart: options?.onScopeDownloadStart,
      onCoverageReset: options?.onCoverageReset,
      onCoverageEvaluated: options?.onCoverageEvaluated,
      onBootstrapRetryScheduled: options?.onBootstrapRetryScheduled,
      onBootstrapPathRecovered: options?.onBootstrapPathRecovered,
      isOnUnmeteredNetwork: options?.isOnUnmeteredNetwork,
      // Lifecycle-only callbacks. The active scheduler may be newer than this
      // run (for example after a React effect replacement), so resolve it at
      // callback time and require the same database before handing it a wake.
      onBootstrapRetryDue: (info) => {
        if (activeRetryWakeCoordinator?.db === db) activeRetryWakeCoordinator.schedule(info);
      },
      onBootstrapRetryCleared: (scopeKey) => {
        if (activeRetryWakeCoordinator?.db === db) activeRetryWakeCoordinator.clear(scopeKey);
      },
    });
    if (activeRetryWakeCoordinator?.db === db) {
      activeRetryWakeCoordinator.clear(CYCLE_ERROR_RETRY_KEY);
    }
  } catch (error) {
    if (activeRetryWakeCoordinator?.db === db) {
      activeRetryWakeCoordinator.schedule({
        scopeKey: CYCLE_ERROR_RETRY_KEY,
        retryAt: Date.now() + CYCLE_ERROR_RETRY_DELAY_MS,
      });
    }
    try {
      options?.onCycleError?.(error);
    } catch {
      // Telemetry is observational. A broken reporter must never strand the
      // scheduler in the exact failed cycle it was trying to describe.
    }
    // pullSync only emits its terminal `idle` frame on success, so a throw mid-pull
    // would leave the Settings status row stuck on "Downloading…". Emit idle here so
    // the in-flight flag always clears — marked `failed` so the status store does
    // NOT stamp lastSyncedAt for a cycle that never completed.
    options?.onProgress?.({ phase: 'idle', currentTable: null, documentsProcessed: 0, failed: true });
  } finally {
    isSyncing = false;
    // I1: a trigger that arrived mid-run must still produce exactly one
    // follow-up run, even if the cycle above threw. The try/catch above
    // swallows cycle errors so we always reach here; consume the flag and
    // re-run once. (runSync is async, so it can't throw synchronously here.)
    const nextRequest = pendingRunRequest;
    pendingRunRequest = null;
    if (nextRequest) void runSync(nextRequest);
  }
}

export function triggerSync(
  db: OfflineDatabase,
  queryClient: QueryInvalidator,
  graphqlFetch: GraphqlFetch,
  getEnabledBoards: () => string[],
  drainQueue: DrainQueue,
  options?: SchedulerOptions,
): void {
  void runSync({
    db,
    queryClient,
    graphqlFetch,
    getEnabledBoards,
    drainQueue,
    options,
    schedulerOwner: activeRetryWakeCoordinator?.db === db ? activeRetryWakeCoordinator.owner : undefined,
  });
}

export function startSyncScheduler(
  db: OfflineDatabase,
  queryClient: QueryInvalidator,
  graphqlFetch: GraphqlFetch,
  getEnabledBoards: () => string[],
  drainQueue: DrainQueue,
  triggers: SchedulerTriggers,
  options?: SchedulerOptions,
): () => void {
  let foregroundTimeout: ReturnType<typeof setTimeout> | null = null;
  let wasConnected = true;
  let stopped = false;
  const schedulerOwner = Symbol('sync-scheduler');

  const schedulerRequest = (): SyncRunRequest => ({
    db,
    queryClient,
    graphqlFetch,
    getEnabledBoards,
    drainQueue,
    options,
    schedulerOwner,
  });
  const runScheduledSync = (): void => {
    if (!stopped) void runSync(schedulerRequest());
  };

  // Snapshot cooldowns are persisted, but persistence alone does not wake an
  // app that stays foregrounded and connected. Keep one exact-deadline timer,
  // retaining every scope so the earliest wake cannot erase a later one.
  const retryDeadlines = new Map<string, number>();
  let retryTimeout: ReturnType<typeof setTimeout> | null = null;
  const armNextRetryWake = (): void => {
    if (retryTimeout !== null) {
      clearTimeout(retryTimeout);
      retryTimeout = null;
    }
    if (stopped || retryDeadlines.size === 0) return;
    let earliestDeadline = Number.POSITIVE_INFINITY;
    for (const deadline of retryDeadlines.values()) earliestDeadline = Math.min(earliestDeadline, deadline);
    retryTimeout = setTimeout(
      () => {
        retryTimeout = null;
        const firedAt = Date.now();
        for (const [scopeKey, deadline] of retryDeadlines) {
          if (deadline <= firedAt) retryDeadlines.delete(scopeKey);
        }
        // Preserve later scopes before starting a cycle; that cycle may replace
        // or clear any deadline it observes from SQLite.
        armNextRetryWake();
        runScheduledSync();
      },
      Math.max(0, earliestDeadline - Date.now()),
    );
  };
  const retryCoordinator: RetryWakeCoordinator = {
    db,
    owner: schedulerOwner,
    schedule({ scopeKey, retryAt }) {
      if (stopped || !Number.isFinite(retryAt)) return;
      retryDeadlines.set(scopeKey, retryAt);
      armNextRetryWake();
    },
    clear(scopeKey) {
      if (!retryDeadlines.delete(scopeKey)) return;
      armNextRetryWake();
    },
    dispose() {
      if (retryTimeout !== null) clearTimeout(retryTimeout);
      retryTimeout = null;
      retryDeadlines.clear();
    },
  };
  activeRetryWakeCoordinator?.dispose();
  activeRetryWakeCoordinator = retryCoordinator;

  const unsubscribeForeground = triggers.subscribeForeground(() => {
    if (foregroundTimeout) clearTimeout(foregroundTimeout);
    foregroundTimeout = setTimeout(() => {
      foregroundTimeout = null;
      runScheduledSync();
    }, FOREGROUND_DEBOUNCE_MS);
  });

  const unsubscribeConnectivity = triggers.subscribeConnectivity((isConnected) => {
    if (!wasConnected && isConnected) {
      runScheduledSync();
    }
    wasConnected = isConnected;
  });

  // The third wake-up, and the one that is not about the phone (issue #4406).
  //
  // Removing a board latches its namespace for the seconds its delete
  // transaction runs, and every guard in the pull client reads that latch as
  // "purged": a cycle that starts inside the window skips the scope from top to
  // bottom. That is correct — it must not write into a delete — but it also
  // CONSUMES the trigger. A climber who switches a board straight back on gets
  // their kick collapsed into exactly that cycle (`runSync` is single-flight),
  // and with no interval here, the next wake-up is a foreground or a
  // reconnect that may not come for hours. Marco's phone sat on "waiting to
  // download" for nine hours and an app relaunch.
  //
  // So the moment the window closes, re-run — but only when something still
  // enabled actually needs that namespace's rows. An ordinary removal (the board
  // is gone and stays gone) matches nothing and costs no cycle.
  const unsubscribePurge = onPurgeSettled((namespace) => {
    const isNamespaceStillWanted = getEnabledBoards().some(
      (scopeKey) => purgeNamespaceForScopeKey(scopeKey) === namespace,
    );
    if (!isNamespaceStillWanted) return;
    runScheduledSync();
  });

  // Run initial sync immediately
  runScheduledSync();

  return () => {
    stopped = true;
    if (foregroundTimeout) clearTimeout(foregroundTimeout);
    retryCoordinator.dispose();
    if (activeRetryWakeCoordinator === retryCoordinator) activeRetryWakeCoordinator = null;
    unsubscribeForeground();
    unsubscribeConnectivity();
    unsubscribePurge();
    // A trigger queued behind an in-flight cycle would otherwise fire that
    // cycle's finally-block re-run AFTER this scheduler stopped (sign-out,
    // flag flip). React runs this cleanup before any replacement scheduler's
    // effect, so a remounting bridge can't lose its own trigger here.
    if (pendingRunRequest?.schedulerOwner === schedulerOwner) pendingRunRequest = null;
  };
}
