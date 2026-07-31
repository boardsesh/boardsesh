// Mobile binding of @boardsesh/offline-sync's injected seams. The package is
// platform-free; this adapter supplies the react-native pieces exactly once:
//
//   - connectivity probe   → React Query's onlineManager (wired to NetInfo in
//                            query-provider)
//   - scheduler wake-ups   → AppState 'active' transitions + NetInfo changes
//   - schema-drift + cycle telemetry → Sentry / dev-only console.warn
//
// RULE: mobile code never imports drainMutationQueue / startSyncScheduler /
// triggerSync / pullSync from '@boardsesh/offline-sync' directly — always from
// here. The package's isOnline default assumes online; only this adapter
// guarantees the real probe is attached, so a direct import would silently
// drain (and burn retry budget) while offline.

import { AppState, type AppStateStatus } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { onlineManager, type QueryClient } from '@tanstack/react-query';
// The adapter is the one sanctioned importer of the raw engine entry points.
// oxlint-disable-next-line no-restricted-imports
import {
  drainMutationQueue as drainMutationQueueCore,
  startSyncScheduler as startSyncSchedulerCore,
  triggerSync as triggerSyncCore,
  pullSync as pullSyncCore,
  setBackgrounded,
  type DrainOptions,
  type DrainQueue,
  type GraphQLFetch,
  type OfflineDatabase,
  type CoverageResetReporter,
  type ScopeDownloadCompleteReporter,
  type SchedulerTriggers,
  type SchemaDriftReporter,
  type SnapshotBootstrapErrorReporter,
  type SnapshotSource,
  type SyncOptions,
  type SyncProgressSink,
} from '@boardsesh/offline-sync';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { reportHandledError } from '../lib/error-reporting';
import { track } from '../lib/analytics';

const isOnline = () => onlineManager.isOnline();

const reportSchemaDrift: SchemaDriftReporter = ({ tableName, column }) => {
  reportHandledError(new Error(`Sync document for ${tableName} contains unknown column: ${column}`), {
    tags: { source: 'offline-sync', kind: 'schema-drift' },
    extra: { tableName, column },
  });
};

// Offline-download telemetry. Both handlers are wired unconditionally (like
// reportSchemaDrift above). reportSnapshotBootstrapError is inert without a
// `snapshotSource` (the engine only calls it from the bootstrap phase, which
// it skips entirely without one); reportScopeDownloadComplete fires for EVERY
// scope's first full download — paged crawls included — because the
// snapshot-vs-paged rollout comparison needs both methods to emit the event.
const reportSnapshotBootstrapError: SnapshotBootstrapErrorReporter = ({ scopeKey, stage, attempt, cause }) => {
  reportHandledError(new Error(`Snapshot bootstrap failed for ${scopeKey} at stage "${stage}" (attempt ${attempt})`), {
    tags: { source: 'offline-sync', kind: 'snapshot-bootstrap' },
    extra: { scopeKey, stage, attempt, cause: cause instanceof Error ? cause.message : cause },
  });
};

// Fired once per board scope's initial download so the snapshot-bootstrap
// warm-up can be compared against the plain paged crawl in the field (which
// path actually got used, and how long it took).
const reportScopeDownloadComplete: ScopeDownloadCompleteReporter = ({ scopeKey, method, durationMs }) => {
  track(SHARED_EVENTS.OfflineBoardDownloadCompleted, { scopeKey, method, durationMs });
};

// The deletions-coverage guard rebuilt this device's local user data because it
// had been away longer than the tombstone retention window (issue #3474).
// track(), not reportHandledError(): nothing failed — the guard did its job —
// and the only question anyone will ask is how often it fires. If this shows up
// far more than the "device away for 80+ days" model predicts, the threshold or
// the marker plumbing is wrong, not the user's phone.
const reportCoverageReset: CoverageResetReporter = ({ markerAgeDays, rowsCleared, pendingMutations }) => {
  track(SHARED_EVENTS.OfflineSyncCoverageResetForced, { markerAgeDays, rowsCleared, pendingMutations });
};

// A failed cycle is routine for offline users (the reconnect trigger retries),
// so production neither spams the console nor reports expected network errors
// as handled exceptions.
const warnCycleError = (error: unknown) => {
  if (__DEV__) {
    console.warn('[Sync] Sync cycle failed:', error instanceof Error ? error.message : 'unknown');
  }
};

// Feeds setBackgrounded() (Sentry BOARDSESH-AN); call once for the app's lifetime — see OfflineSyncBridge.
export function startBackgroundTracking(): () => void {
  const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
    if (nextState === 'background') setBackgrounded(true);
    if (nextState === 'active') setBackgrounded(false);
  });
  return () => subscription.remove();
}

const schedulerTriggers: SchedulerTriggers = {
  subscribeForeground(callback) {
    const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (nextState === 'active') callback();
    });
    return () => subscription.remove();
  },
  subscribeConnectivity(callback) {
    return NetInfo.addEventListener((state) => {
      callback(state.isConnected ?? false);
    });
  },
};

export function drainMutationQueue(
  db: OfflineDatabase,
  queryClient: QueryClient,
  graphqlFetch: GraphQLFetch,
  options?: Partial<DrainOptions>,
): Promise<void> {
  return drainMutationQueueCore(db, queryClient, graphqlFetch, {
    ...options,
    isOnline: options?.isOnline ?? isOnline,
  });
}

// A named bag rather than trailing positionals so callers (and their tests)
// never depend on argument order for the optional seams.
export type SyncRunOptions = {
  onProgress?: SyncProgressSink;
  // Injected only when the offline-snapshot-bootstrap flag is on (see
  // useSnapshotSource) — undefined here reproduces the pure paged-crawl
  // behaviour exactly, byte-identical to before this seam existed.
  snapshotSource?: SnapshotSource;
};

export function startSyncScheduler(
  db: OfflineDatabase,
  queryClient: QueryClient,
  graphqlFetch: GraphQLFetch,
  getEnabledBoards: () => string[],
  drainQueue: DrainQueue,
  options?: SyncRunOptions,
): () => void {
  return startSyncSchedulerCore(db, queryClient, graphqlFetch, getEnabledBoards, drainQueue, schedulerTriggers, {
    onProgress: options?.onProgress,
    onCycleError: warnCycleError,
    onSchemaDrift: reportSchemaDrift,
    snapshotSource: options?.snapshotSource,
    onSnapshotBootstrapError: reportSnapshotBootstrapError,
    onScopeDownloadComplete: reportScopeDownloadComplete,
    onCoverageReset: reportCoverageReset,
  });
}

export function triggerSync(
  db: OfflineDatabase,
  queryClient: QueryClient,
  graphqlFetch: GraphQLFetch,
  getEnabledBoards: () => string[],
  drainQueue: DrainQueue,
  options?: SyncRunOptions,
): void {
  triggerSyncCore(db, queryClient, graphqlFetch, getEnabledBoards, drainQueue, {
    onProgress: options?.onProgress,
    onCycleError: warnCycleError,
    onSchemaDrift: reportSchemaDrift,
    snapshotSource: options?.snapshotSource,
    onSnapshotBootstrapError: reportSnapshotBootstrapError,
    onScopeDownloadComplete: reportScopeDownloadComplete,
    onCoverageReset: reportCoverageReset,
  });
}

export function pullSync(
  db: OfflineDatabase,
  queryClient: QueryClient,
  graphqlFetch: GraphQLFetch,
  options?: SyncOptions,
): Promise<void> {
  return pullSyncCore(db, queryClient, graphqlFetch, {
    onSchemaDrift: reportSchemaDrift,
    onSnapshotBootstrapError: reportSnapshotBootstrapError,
    onScopeDownloadComplete: reportScopeDownloadComplete,
    onCoverageReset: reportCoverageReset,
    ...options,
  });
}
