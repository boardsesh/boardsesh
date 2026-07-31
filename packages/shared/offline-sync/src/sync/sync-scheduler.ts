import type { OfflineDatabase, QueryInvalidator } from '../database';
import {
  pullSync,
  type SyncProgress,
  type SchemaDriftReporter,
  type ScopeDownloadCompleteReporter,
  type CoverageResetReporter,
} from './pull-client';
import type { SnapshotSource, SnapshotBootstrapErrorReporter } from './snapshot-bootstrap';

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
   * Called when a sync cycle throws. A failed cycle is routine for offline
   * users (the reconnect trigger retries), so the mobile adapter passes a
   * dev-only console.warn — production neither spams the console nor reports
   * expected network errors as handled exceptions.
   */
  onCycleError?: (error: unknown) => void;
  /** Threaded through to pullSync — see SchemaDriftReporter. */
  onSchemaDrift?: SchemaDriftReporter;
  /** Threaded through to pullSync's SyncOptions — see snapshot-bootstrap.ts. */
  snapshotSource?: SnapshotSource;
  /** Threaded through to pullSync's SyncOptions. */
  onSnapshotBootstrapError?: SnapshotBootstrapErrorReporter;
  /** Threaded through to pullSync's SyncOptions — see ScopeDownloadCompleteInfo. */
  onScopeDownloadComplete?: ScopeDownloadCompleteReporter;
  /** Threaded through to pullSync's SyncOptions — see CoverageResetInfo. */
  onCoverageReset?: CoverageResetReporter;
};

let isSyncing = false;
let pendingTrigger = false;

export function __resetSyncSchedulerStateForTests(): void {
  isSyncing = false;
  pendingTrigger = false;
}

// Each cycle does drain-first (push local mutations) then pull (fetch server
// state), so a write that failed to send is reattempted on every sync trigger
// — not just on the next user write (B12). Single-flight: concurrent triggers
// collapse into one in-flight run plus at most one queued follow-up.
async function runSync(
  db: OfflineDatabase,
  queryClient: QueryInvalidator,
  graphqlFetch: GraphqlFetch,
  getEnabledBoards: () => string[],
  drainQueue: DrainQueue,
  options?: SchedulerOptions,
): Promise<void> {
  if (isSyncing) {
    pendingTrigger = true;
    return;
  }

  isSyncing = true;
  try {
    // Push first so the subsequent pull reflects our own just-flushed writes.
    await drainQueue();
    await pullSync(db, queryClient, graphqlFetch, {
      enabledBoards: getEnabledBoards(),
      onProgress: options?.onProgress,
      onSchemaDrift: options?.onSchemaDrift,
      snapshotSource: options?.snapshotSource,
      onSnapshotBootstrapError: options?.onSnapshotBootstrapError,
      onScopeDownloadComplete: options?.onScopeDownloadComplete,
      onCoverageReset: options?.onCoverageReset,
    });
  } catch (error) {
    options?.onCycleError?.(error);
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
    if (pendingTrigger) {
      pendingTrigger = false;
      void runSync(db, queryClient, graphqlFetch, getEnabledBoards, drainQueue, options);
    }
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
  void runSync(db, queryClient, graphqlFetch, getEnabledBoards, drainQueue, options);
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

  const unsubscribeForeground = triggers.subscribeForeground(() => {
    if (foregroundTimeout) clearTimeout(foregroundTimeout);
    foregroundTimeout = setTimeout(() => {
      foregroundTimeout = null;
      void runSync(db, queryClient, graphqlFetch, getEnabledBoards, drainQueue, options);
    }, FOREGROUND_DEBOUNCE_MS);
  });

  const unsubscribeConnectivity = triggers.subscribeConnectivity((isConnected) => {
    if (!wasConnected && isConnected) {
      void runSync(db, queryClient, graphqlFetch, getEnabledBoards, drainQueue, options);
    }
    wasConnected = isConnected;
  });

  // Run initial sync immediately
  void runSync(db, queryClient, graphqlFetch, getEnabledBoards, drainQueue, options);

  return () => {
    if (foregroundTimeout) clearTimeout(foregroundTimeout);
    unsubscribeForeground();
    unsubscribeConnectivity();
    // A trigger queued behind an in-flight cycle would otherwise fire that
    // cycle's finally-block re-run AFTER this scheduler stopped (sign-out,
    // flag flip). React runs this cleanup before any replacement scheduler's
    // effect, so a remounting bridge can't lose its own trigger here.
    pendingTrigger = false;
  };
}
