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
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
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
  type MutationDeadLetterReporter,
  type MutationDeliveryEvent,
  type MutationStatusListenerFailure,
  type DrainQueue,
  type GraphQLFetch,
  type OfflineDatabase,
  type BootstrapMetadataChangedReporter,
  type CoverageEvaluatedReporter,
  type BootstrapPathRecoveredReporter,
  type BootstrapRetryScheduledReporter,
  type CoverageResetReporter,
  type ScopeDownloadCompleteReporter,
  type ScopeDownloadStartReporter,
  type SchedulerTriggers,
  type SchemaDriftReporter,
  type SnapshotBootstrapErrorReporter,
  type SnapshotSource,
  type SyncOptions,
  type SyncProgressSink,
} from '@boardsesh/offline-sync';
import { SHARED_EVENTS, sanitizeErrorForAnalytics } from '@boardsesh/analytics';
import { reportHandledError } from '../lib/error-reporting';
import { isOfflineEngineEnabled } from '../lib/offline-engine';
import { takeDownloadTrigger } from '../settings';
import { track } from '../lib/analytics';

// Exported so non-drain reporters can record the one dimension that decides
// whether a failed local write actually lost data: a tick that falls through to
// the network save is fine online and gone offline (see board-adapter).
export const isOnline = () => onlineManager.isOnline();

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

// A queued write we will never deliver. Both channels are deliberate: Sentry
// because a dead letter is a defect (the drainer never dead-letters for lack of
// a connection, so this is always a real rejection or an exhausted retry
// budget), and PostHog because only a rate across the fleet says whether it is
// one broken account or a systemic loss. The `{ cause }` is load-bearing for the
// same reason it is on reportSnapshotBootstrapError: reportHandledError
// classifies what it is handed, and a synthetic wrapper with no cause matches
// nothing (issue #4238).
const reportMutationDeadLettered: MutationDeadLetterReporter = ({
  tableName,
  operation,
  idempotencyKey,
  reason,
  retryCount,
  maxRetries,
  queuedForMs,
  status,
  errorMessage,
  error,
}) => {
  reportHandledError(new Error(`Offline ${tableName} ${operation} dead-lettered (${reason})`, { cause: error }), {
    tags: { source: 'offline-sync', kind: 'mutation-dead-letter', reason },
    extra: { tableName, operation, idempotencyKey, reason, retryCount, maxRetries, status, queuedForMs, errorMessage },
  });
  // idempotencyKey stays out of the analytics props on purpose: it is a raw
  // uuid for ticks and a per-climb key for favorites, i.e. unbounded cardinality.
  track(SHARED_EVENTS.OfflineMutationDeadLettered, {
    tableName,
    operation,
    reason,
    retryCount,
    status,
    queuedForMs,
    error: sanitizeErrorForAnalytics(error),
  });
};

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
  // The funnel's Failed leg (issue #4316). Sentry alone could never answer "what
  // fraction of downloads fail, and at which stage" — it groups by exception
  // shape, not by scope, and expected transport failures are deliberately
  // downgraded there. Same call site, so the two can never disagree about
  // whether a failure happened.
  track(SHARED_EVENTS.OfflineBoardDownloadFailed, {
    scopeKey,
    stage,
    attempt,
    expected,
    errorMessage: cause instanceof Error ? cause.message : String(cause),
    offlineEngineEnabled: isOfflineEngineEnabled(),
  });
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
const reportScopeDownloadComplete: ScopeDownloadCompleteReporter = ({
  scopeKey,
  method,
  durationMs,
  bytes,
  rowCount,
  downloadMs,
  importMs,
}) => {
  track(SHARED_EVENTS.OfflineBoardDownloadCompleted, {
    scopeKey,
    method,
    durationMs,
    // Spread rather than set: the engine omits these when the completing delta
    // pull landed in a later cycle than the import, and an omitted prop is the
    // honest answer where a 0 would look like a real measurement.
    ...(bytes === undefined ? {} : { bytes }),
    ...(rowCount === undefined ? {} : { rowCount }),
    ...(downloadMs === undefined ? {} : { downloadMs }),
    ...(importMs === undefined ? {} : { importMs }),
    // Stamped so the funnel stays readable once #4312 bakes the flag on: the
    // engine gate, not the raw flag value.
    offlineEngineEnabled: isOfflineEngineEnabled(),
  });
};

// The funnel's missing anchor (issue #4316): without it, abandonment is
// structurally unmeasurable — a download that is never finished emits nothing at
// all. The engine guarantees this fires once ever per scope (durable
// `scope-started:` marker), matching Completed, so the ratio is real.
const reportScopeDownloadStart: ScopeDownloadStartReporter = ({ scopeKey, pathIntent, artifactBytes }) => {
  track(SHARED_EVENTS.OfflineBoardDownloadStarted, {
    scopeKey,
    pathIntent,
    artifactBytes,
    // Consumed here, which both attributes the event and prunes the store. The
    // attribution is persisted rather than in-memory precisely because the
    // interesting case is a board enabled while offline whose download runs on a
    // later launch — an in-memory map loses exactly that one.
    trigger: takeDownloadTrigger(scopeKey),
    offlineEngineEnabled: isOfflineEngineEnabled(),
  });
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

// The reset above only fires on the rare wipe. This one reports the verdict for
// every evaluation, including `unknown` — the devices that have never completed
// a deletions pull, which the reset event can never see (issue #4315).
//
// The dedupe lives HERE rather than in the engine on purpose: the engine seam
// fires on every pullSync so it stays deterministic and testable, but
// enforceDeletionsCoverage runs at the top of every cycle and the scheduler has
// no interval — it wakes on foreground and on reconnect. Un-deduped, a device
// stuck on `unknown` would emit indefinitely, and those are precisely the
// devices we care about. Keyed on the verdict so a fresh→stale transition still
// reports; once per launch otherwise.
const reportedCoverageVerdicts = new Set<string>();

const reportCoverageEvaluated: CoverageEvaluatedReporter = ({ verdict, markerAgeDays, outcome }) => {
  const dedupeKey = `${verdict}:${outcome}`;
  if (reportedCoverageVerdicts.has(dedupeKey)) return;
  reportedCoverageVerdicts.add(dedupeKey);
  track(SHARED_EVENTS.OfflineSyncCoverageEvaluated, { verdict, markerAgeDays, outcome });
};

export function __resetCoverageVerdictDedupeForTests(): void {
  reportedCoverageVerdicts.clear();
}

// The retry ladder scheduled another go at the fast download (issue #4313).
// track(), not reportHandledError(): the failure itself already went to Sentry
// via reportSnapshotBootstrapError at its own severity, and what nobody can
// answer today is how often boards give up entirely versus recover.
const reportBootstrapRetryScheduled: BootstrapRetryScheduledReporter = (info) => {
  track(SHARED_EVENTS.OfflineSnapshotRetryScheduled, { ...info });
};

// The other half of that measurement: a board that had failed the fast download
// is back on it, and what brought it back.
const reportBootstrapPathRecovered: BootstrapPathRecoveredReporter = (info) => {
  track(SHARED_EVENTS.OfflineSnapshotPathRecovered, { ...info });
};

// Last connectivity state NetInfo reported. `null` means it has not reported
// yet, which on a cold launch is a real window and not a formality: the
// scheduler's first cycle starts in the effect right after
// startBackgroundTracking's, and NetInfo's first emission is asynchronous.
// Updated by the listener there (one subscription for the app's lifetime) and
// seeded by the probe below.
let isConnectionMetered: boolean | null = null;

const readMetered = (state: NetInfoState): boolean =>
  state.type === 'cellular' || state.details?.isConnectionExpensive === true;

/**
 * Gates ONE decision in the engine: the automatic heal of a partly-crawled
 * scope, which is a ~100 MB download the climber did not ask for that day
 * (issue #4313). A fresh bootstrap — confirmed behind a size-disclosing dialog
 * moments earlier — and a user-requested retry both ignore it.
 *
 * Async on purpose. Before the listener has fired there is nothing to answer
 * from, and answering "unmetered" would hand the FIRST cycle of a cold cellular
 * launch precisely the heal this probe exists to defer — so that once, it asks
 * NetInfo directly and seeds the cache every later cycle reads.
 *
 * Unknown still reads as UNMETERED (a failed fetch, or a platform reporting
 * neither `cellular` nor `isConnectionExpensive`). Deferring forever is the
 * worse failure: the board stays on the 400+-round-trip crawl and nothing ever
 * says why.
 */
const isOnUnmeteredNetwork = async (): Promise<boolean> => {
  if (isConnectionMetered !== null) return !isConnectionMetered;
  try {
    isConnectionMetered = readMetered(await NetInfo.fetch());
  } catch {
    return true;
  }
  return !isConnectionMetered;
};

/** Cold-launch state is per-process; tests re-arm it between cases. */
export function __resetMeteredStateForTests(): void {
  isConnectionMetered = null;
}

// A failed cycle is routine for offline users (the reconnect trigger retries),
// so production neither spams the console nor reports expected network errors
// as handled exceptions.
const warnCycleError = (error: unknown) => {
  if (__DEV__) {
    console.warn('[Sync] Sync cycle failed:', error instanceof Error ? error.message : 'unknown');
  }
};

// Feeds setBackgrounded() (Sentry BOARDSESH-AN) and the metered-link flag above;
// call once for the app's lifetime — see OfflineSyncBridge.
export function startBackgroundTracking(): () => void {
  const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
    if (nextState === 'background') setBackgrounded(true);
    if (nextState === 'active') setBackgrounded(false);
  });
  const unsubscribeNetInfo = NetInfo.addEventListener((state) => {
    isConnectionMetered = readMetered(state);
  });
  return () => {
    subscription.remove();
    unsubscribeNetInfo();
  };
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
    // Composed, not defaulted (unlike the reporters above): telemetry for a
    // permanently lost write must not be something a call site can opt out of
    // by passing its own handler.
    onMutationDeadLettered: (info) => {
      try {
        options?.onMutationDeadLettered?.(info);
      } finally {
        reportMutationDeadLettered(info);
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
    onScopeDownloadStart: reportScopeDownloadStart,
    onCoverageReset: reportCoverageReset,
    onCoverageEvaluated: reportCoverageEvaluated,
    onBootstrapRetryScheduled: reportBootstrapRetryScheduled,
    onBootstrapPathRecovered: reportBootstrapPathRecovered,
    isOnUnmeteredNetwork,
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
    onScopeDownloadStart: reportScopeDownloadStart,
    onCoverageReset: reportCoverageReset,
    onCoverageEvaluated: reportCoverageEvaluated,
    onBootstrapRetryScheduled: reportBootstrapRetryScheduled,
    onBootstrapPathRecovered: reportBootstrapPathRecovered,
    isOnUnmeteredNetwork,
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
    onScopeDownloadStart: options?.onScopeDownloadStart ?? reportScopeDownloadStart,
    onCoverageReset: options?.onCoverageReset ?? reportCoverageReset,
    onCoverageEvaluated: options?.onCoverageEvaluated ?? reportCoverageEvaluated,
    onBootstrapRetryScheduled: options?.onBootstrapRetryScheduled ?? reportBootstrapRetryScheduled,
    onBootstrapPathRecovered: options?.onBootstrapPathRecovered ?? reportBootstrapPathRecovered,
    isOnUnmeteredNetwork: options?.isOnUnmeteredNetwork ?? isOnUnmeteredNetwork,
    // Caller-provided error/drift/coverage reporters keep their existing
    // override semantics; scope completion is the one callback deliberately
    // composed because both telemetry and per-scope UI invalidation are required.
  });
}
