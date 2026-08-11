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
// drain (and burn retry budget) while offline — and, since #4238, would also
// run a whole pull cycle offline, reporting a snapshot-bootstrap failure per
// enabled-but-undownloaded board on the way.

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
  type MutationDeliveryEvent,
  type MutationStatusListenerFailure,
  type DrainQueue,
  type GraphQLFetch,
  type OfflineDatabase,
  type BootstrapMetadataChangedReporter,
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

const mutationDeliveryListeners = new Set<(event: MutationDeliveryEvent) => void>();

function reportMutationStatusListenerFailure({ error, event }: MutationStatusListenerFailure): void {
  try {
    reportHandledError(error, {
      tags: { source: 'offline-sync', kind: 'mutation-status-listener' },
      extra: { tableName: event.tableName, operation: event.operation, status: event.status },
    });
  } catch (reportingError) {
    if (__DEV__) console.warn('[MutationQueue] delivery-listener error reporter failed:', reportingError);
  }
}

export function subscribeMutationDelivery(listener: (event: MutationDeliveryEvent) => void): () => void {
  mutationDeliveryListeners.add(listener);
  return () => mutationDeliveryListeners.delete(listener);
}

function publishMutationDelivery(event: MutationDeliveryEvent): void {
  for (const listener of mutationDeliveryListeners) {
    try {
      listener(event);
    } catch (error) {
      reportMutationStatusListenerFailure({ error, event });
    }
  }
}

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
// The `{ cause }` is load-bearing, not decoration: reportHandledError classifies
// the error it is handed, and this synthetic wrapper matches nothing on its own,
// so every offline user's bootstrap failure used to land in Sentry at `level:
// error` with `extra.cause: null` (issue #4238). The shared classifier walks a
// `.cause` chain three deep, so attaching the real cause is all it takes to get
// the network downgrade — and `expected` (set by the engine for transport-shaped
// failures) forces the warning even when the cause is an unrecognised shape.
const reportSnapshotBootstrapError: SnapshotBootstrapErrorReporter = ({
  scopeKey,
  stage,
  attempt,
  cause,
  expected,
}) => {
  reportHandledError(
    new Error(`Snapshot bootstrap failed for ${scopeKey} at stage "${stage}" (attempt ${attempt})`, { cause }),
    {
      ...(expected ? { level: 'warning' as const } : {}),
      tags: { source: 'offline-sync', kind: 'snapshot-bootstrap', ...(expected ? { expected_offline: true } : {}) },
      extra: {
        scopeKey,
        stage,
        attempt,
        expected,
        cause: cause instanceof Error ? cause.message : cause,
        causeName: cause instanceof Error ? cause.name : null,
      },
    },
  );
};

// Fired once per board scope's initial download so the snapshot-bootstrap
// warm-up can be compared against the plain paged crawl in the field (which
// path actually got used, and how long it took).
const reportScopeDownloadComplete: ScopeDownloadCompleteReporter = ({ scopeKey, method, durationMs }) => {
  track(SHARED_EVENTS.OfflineBoardDownloadCompleted, { scopeKey, method, durationMs });
};

function combinedScopeDownloadCompleteReporter(
  onScopeDownloadComplete: ScopeDownloadCompleteReporter | undefined,
): ScopeDownloadCompleteReporter {
  return (info) => {
    reportScopeDownloadComplete(info);
    onScopeDownloadComplete?.(info);
  };
}

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
    onMutationStatusError: options?.onMutationStatusError ?? reportMutationStatusListenerFailure,
    onMutationStatus: (event) => {
      try {
        options?.onMutationStatus?.(event);
      } finally {
        publishMutationDelivery(event);
      }
    },
  });
}

// A named bag rather than trailing positionals so callers (and their tests)
// never depend on argument order for the optional seams.
export type SyncRunOptions = {
  onProgress?: SyncProgressSink;
  /** UI invalidation after each bootstrap scope's metadata settles. */
  onBootstrapMetadataChanged?: BootstrapMetadataChangedReporter;
  /** UI invalidation after each scope completes, composed with telemetry. */
  onScopeDownloadComplete?: ScopeDownloadCompleteReporter;
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
    isOnline,
    onProgress: options?.onProgress,
    onCycleError: warnCycleError,
    onSchemaDrift: reportSchemaDrift,
    snapshotSource: options?.snapshotSource,
    onSnapshotBootstrapError: reportSnapshotBootstrapError,
    onBootstrapMetadataChanged: options?.onBootstrapMetadataChanged,
    onScopeDownloadComplete: combinedScopeDownloadCompleteReporter(options?.onScopeDownloadComplete),
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
    isOnline,
    onProgress: options?.onProgress,
    onCycleError: warnCycleError,
    onSchemaDrift: reportSchemaDrift,
    snapshotSource: options?.snapshotSource,
    onSnapshotBootstrapError: reportSnapshotBootstrapError,
    onBootstrapMetadataChanged: options?.onBootstrapMetadataChanged,
    onScopeDownloadComplete: combinedScopeDownloadCompleteReporter(options?.onScopeDownloadComplete),
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
    ...options,
    isOnline: options?.isOnline ?? isOnline,
    onSchemaDrift: options?.onSchemaDrift ?? reportSchemaDrift,
    onSnapshotBootstrapError: options?.onSnapshotBootstrapError ?? reportSnapshotBootstrapError,
    onScopeDownloadComplete: combinedScopeDownloadCompleteReporter(options?.onScopeDownloadComplete),
    onCoverageReset: options?.onCoverageReset ?? reportCoverageReset,
    // Caller-provided error/drift/coverage reporters keep their existing
    // override semantics; scope completion is the one callback deliberately
    // composed because both telemetry and per-scope UI invalidation are required.
  });
}
