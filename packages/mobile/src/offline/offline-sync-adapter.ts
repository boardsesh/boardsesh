// Mobile binding of @boardsesh/offline-sync's injected seams. The package is
// platform-free; this adapter supplies the react-native pieces exactly once:
//
//   - connectivity probe   → React Query's onlineManager, which since #4862 is
//                            written only by the connectivity store
//                            (src/lib/connectivity)
//   - server availability  → the store's deduped /health/db confirmation, so a
//                            drain does not spend retry budget on a backend
//                            that is known to be down
//   - scheduler wake-ups   → AppState 'active' transitions + connectivity edges
//   - schema-drift + cycle telemetry → Sentry / PostHog / dev console
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
  type AbandonedDownloadInfo,
} from '@boardsesh/offline-sync';
import { SHARED_EVENTS, sanitizeErrorForAnalytics } from '@boardsesh/analytics';
import { getErrorStatus, isNetworkError, isServerUnavailableError } from '@boardsesh/offline-sync/error-classification';
import {
  confirmBackendAvailability,
  getConnectivitySnapshot,
  refreshDeviceState,
  subscribeConnectivity as subscribeConnectivityStore,
} from '../lib/connectivity/connectivity-store';
import { reportHandledError } from '../lib/error-reporting';
import { isOfflineEngineEnabled } from '../lib/offline-engine';
import { takeDownloadTrigger } from '../settings';
import { track } from '../lib/analytics';
import { getSyncStatusSnapshot } from '../sync/sync-status';

// Exported so non-drain reporters can record the one dimension that decides
// whether a failed local write actually lost data: a tick that falls through to
// the network save is fine online and gone offline (see board-adapter).
export const isOnline = () => onlineManager.isOnline();

/**
 * Is a sync worth starting right now? Offline mode off, an uplink attached, and
 * that uplink not KNOWN to be dead. `unknown` reachability counts as usable —
 * it means NetInfo has not finished probing, never that the upstream is down —
 * while a captive portal or a dead gym upstream is the explicit `unreachable`
 * case that must not kick a cycle.
 */
function isUsableConnection(): boolean {
  const snapshot = getConnectivitySnapshot();
  return !snapshot.effectiveOffline && snapshot.deviceReachability !== 'unreachable';
}

/**
 * Read current reachability after an offline-surface download request is armed.
 * This closes the ordering race where the reconnect edge lands just before the
 * setting write: the scheduler consumed the edge, but this current-state probe
 * can still kick the newly enabled scope.
 *
 * It no longer writes `onlineManager.setOnline(true)` on the way (#4862). The
 * connectivity store is the single writer of that value now, and a second one
 * here could declare the app online while the store had just confirmed the
 * backend unreachable — which is the exact "looks online, answers nothing"
 * state this work exists to remove. `refreshDeviceState()` gives the store the
 * fresh NetInfo read instead, so the answer below is current either way.
 */
export async function hasUsableInternetConnection(): Promise<boolean> {
  await refreshDeviceState();
  return isUsableConnection();
}

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
  reason,
  aborted,
}) => {
  // The funnel's Failed leg (issue #4316). Sentry alone could never answer "what
  // fraction of downloads fail, and at which stage" — it groups by exception
  // shape, not by scope, and expected transport failures are deliberately
  // downgraded there. Same call site, so the two can never disagree about
  // whether a failure happened.
  //
  // `aborted` rides along so a failure-RATE query can exclude the teardowns (a
  // pocketed phone, a board removed elsewhere in the app) that are now reported
  // here for funnel completeness rather than because anything broke.
  track(SHARED_EVENTS.OfflineBoardDownloadFailed, {
    scopeKey,
    stage,
    attempt,
    expected,
    reason,
    aborted,
    errorMessage: cause instanceof Error ? cause.message : String(cause),
    offlineEngineEnabled: isOfflineEngineEnabled(),
  });
  // A teardown is not a defect and there are as many of them as there are lock
  // screens, so it stops at the funnel. Sending them would bury the artifact and
  // database failures this issue exists to surface.
  if (aborted) return;
  reportHandledError(
    new Error(`Snapshot bootstrap failed for ${scopeKey} at stage "${stage}" (attempt ${attempt})`, { cause }),
    {
      ...(expected ? { level: 'warning' as const } : {}),
      // `stage` and `reason` are TAGS, not just extras: Sentry can only search and
      // group on tags, and chasing BOARDSESH-D7 through `extra.stage` is exactly
      // what made "which phase is this?" unanswerable from the issue page.
      tags: {
        source: 'offline-sync',
        kind: 'snapshot-bootstrap',
        stage,
        reason,
        ...(expected ? { expected_offline: true } : {}),
      },
      extra: {
        scopeKey,
        stage,
        attempt,
        expected,
        reason,
        cause: cause instanceof Error ? cause.message : cause,
        causeName: cause instanceof Error ? cause.name : null,
      },
    },
  );
};

/**
 * The funnel's other missing terminal (issue #4406): the climber removed the
 * board while its download was still running.
 *
 * Routed through `reportSnapshotBootstrapError` rather than a `track()` of its
 * own so the Failed leg has exactly one shape and one call site — the two could
 * otherwise disagree about what a failed download looks like. `aborted: true`
 * keeps it out of Sentry (a Remove tap is not a defect) and out of any failure
 * RATE, while the `abandoned-removed` reason is what makes abandonment
 * countable: it fires at most once per `Offline Board Download Started`, from
 * the teardown that deletes the marker.
 */
export const reportScopeDownloadAbandoned = ({ scopeKey }: AbandonedDownloadInfo): void => {
  reportSnapshotBootstrapError({
    scopeKey,
    stage: 'board-removed',
    // No retry budget was spent — the same "nothing was burned" zero every other
    // teardown report sends.
    attempt: 0,
    cause: new Error(`Offline download for ${scopeKey} was removed before it finished`),
    expected: true,
    reason: 'abandoned-removed',
    aborted: true,
  });
};

/**
 * The same terminal for every OTHER way a download ends for good (issue #4452):
 * the paths that de-list a board instead of deleting it.
 *
 * `removeBoardScopeData` was the only ender that reported, which left the funnel
 * blind to every path that empties `syncEnabledBoards` — all three sign-outs and
 * the My Boards toggle-off. The pull client's board loop iterates only ENABLED
 * scopes, so a de-listed scope's `Offline Board Download Started` stays open
 * forever even when nothing was deleted and the marker is still sitting there.
 *
 * One shape, one call site, same as #4406's: `stage: 'abandoned'` (no bootstrap
 * stage produced this, and it is NOT `board-removed` — nothing was removed),
 * `aborted: true` so it stays out of Sentry and out of any failure rate, and
 * `attempt: 0` because no retry budget was spent. The reason is the only thing
 * that varies, and it names which de-listing it was.
 */
const reportScopeDownloadAbandonedOnDelist = (
  scopeKey: string,
  reason: 'abandoned-signed-out' | 'abandoned-disabled',
  what: string,
): void => {
  reportSnapshotBootstrapError({
    scopeKey,
    stage: 'abandoned',
    attempt: 0,
    cause: new Error(`Offline download for ${scopeKey} was ${what} before it finished`),
    expected: true,
    reason,
    aborted: true,
  });
};

/** Sign-out ended it — the explicit wipe, or any sign-out that de-listed the board. */
export const reportScopeDownloadAbandonedOnSignOut = ({ scopeKey }: { scopeKey: string }): void => {
  reportScopeDownloadAbandonedOnDelist(scopeKey, 'abandoned-signed-out', 'signed out from');
};

/** The climber turned the board off from My Boards, keeping the rows on disk. */
export const reportScopeDownloadAbandonedOnDisable = ({ scopeKey }: { scopeKey: string }): void => {
  reportScopeDownloadAbandonedOnDelist(scopeKey, 'abandoned-disabled', 'turned off');
};

// Fired once per board scope's initial download so the snapshot-bootstrap
// warm-up can be compared against the plain paged crawl in the field (which
// path actually got used, and how long it took).
// The phase breakdown rides on THIS event rather than a new one (issue #4310):
// the question it answers — "of a 2m55s Kilter download, how much is the
// artifact and how much is the grades crawl behind it?" — is a property of the
// download that just completed, and splitting it across two events would make
// every funnel query a join. Only the phases NOT already carried by the
// per-scope timings above are emitted: `phases` also holds cycle-scoped copies
// of download/import/artifact bytes, and the timings' absent-when-unknown
// versions are the honest ones (a 0 from a later-cycle completion would read as
// a real measurement). The same rule now covers the two grade row counts
// (issue #4393): the engine omits `gradesRows` when this cycle only picked up
// the tail of a crawl an earlier cycle started, and omits `gradesArtifactRows`
// when no grades artifact imported this cycle — a 0 for either would read as
// "this board has no grades".
// `bootstrapHealed` is emitted because the engine's own doc makes it the
// required filter for snapshot-vs-paged percentile comparisons (a healed scope's
// duration excludes the paged work earlier cycles did) — it was computed and
// then silently dropped here, which made that comparison unanswerable.
// The import split (issue #4310) follows the SAME absent-when-unknown rule, and
// for the same reason: a cycle that ran no import did not spend that time, and
// most completions are exactly that. `importLockMaxMs` is the longest single
// exclusive-transaction hold — the worst case a concurrent user write has to
// survive (#4314) — and is the number this change is judged on; query the six
// `import*` props with `importMs IS NOT NULL` or the p90 is dominated by
// import-free cycles.
// `gradesDownloadMs` / `gradesVerifyMs` / `gradesLockMs` close the other half:
// `importGradesForScope` runs its own transfer and its own exclusive
// transaction, and neither was visible in any phase field, which is most of the
// ~11s p50 gap between `durationMs` and the sum of the phases. Those three take
// their OWN `IS NOT NULL` filter, NOT `importMs` — the grades retrofit path fires
// them for an already-bootstrapped scope in a cycle with no whole-layout import,
// which is the still-crawling population of #4719.
const reportScopeDownloadComplete: ScopeDownloadCompleteReporter = ({
  scopeKey,
  method,
  durationMs,
  bootstrapHealed,
  bytes,
  rowCount,
  downloadMs,
  importMs,
  phases,
}) => {
  track(SHARED_EVENTS.OfflineBoardDownloadCompleted, {
    scopeKey,
    method,
    durationMs,
    // Spread rather than set: the engine omits these when the completing delta
    // pull landed in a later cycle than the import, and an omitted prop is the
    // honest answer where a 0 would look like a real measurement.
    ...(bootstrapHealed === undefined ? {} : { bootstrapHealed }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(rowCount === undefined ? {} : { rowCount }),
    ...(downloadMs === undefined ? {} : { downloadMs }),
    ...(importMs === undefined ? {} : { importMs }),
    manifestMs: phases.manifestMs,
    artifactReused: phases.artifactReused,
    climbsPullMs: phases.climbsPullMs,
    statsPullMs: phases.statsPullMs,
    gradesPullMs: phases.gradesPullMs,
    ...(phases.gradesRows === undefined ? {} : { gradesRows: phases.gradesRows }),
    ...(phases.gradesArtifactRows === undefined ? {} : { gradesArtifactRows: phases.gradesArtifactRows }),
    ...(phases.importVerifyMs === undefined ? {} : { importVerifyMs: phases.importVerifyMs }),
    ...(phases.importReconcileMs === undefined ? {} : { importReconcileMs: phases.importReconcileMs }),
    ...(phases.importRowsMs === undefined ? {} : { importRowsMs: phases.importRowsMs }),
    ...(phases.importLockMaxMs === undefined ? {} : { importLockMaxMs: phases.importLockMaxMs }),
    ...(phases.importLockWaitMs === undefined ? {} : { importLockWaitMs: phases.importLockWaitMs }),
    ...(phases.importBatches === undefined ? {} : { importBatches: phases.importBatches }),
    ...(phases.gradesDownloadMs === undefined ? {} : { gradesDownloadMs: phases.gradesDownloadMs }),
    ...(phases.gradesVerifyMs === undefined ? {} : { gradesVerifyMs: phases.gradesVerifyMs }),
    ...(phases.gradesLockMs === undefined ? {} : { gradesLockMs: phases.gradesLockMs }),
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

/**
 * Query keys that answer "which board scopes are on this device". They are read
 * by My Boards, the boards picker, More (the Storage row) and every download
 * affordance, and until now only `remove-offline-board.ts` ever invalidated
 * them — so a screen the user never left kept claiming a board was not
 * downloaded long after it had finished (issue #4318).
 *
 * Invalidating from this callback rather than from a hook is deliberate:
 * `useSyncStatus()` publishes a fresh object on every progress frame, so a
 * subscribing hook would churn the hottest virtualised screens. This fires once
 * per COMPLETED scope, so the cost is one SQLite read per completion.
 */
const DOWNLOAD_STATE_QUERY_KEYS: readonly (readonly string[])[] = [['downloadedScopeKeys'], ['offlineStorage']];

function combinedScopeDownloadCompleteReporter(
  onScopeDownloadComplete: ScopeDownloadCompleteReporter | undefined,
  queryClient?: QueryClient,
): ScopeDownloadCompleteReporter {
  return (info) => {
    reportScopeDownloadComplete(info);
    if (queryClient) {
      for (const queryKey of DOWNLOAD_STATE_QUERY_KEYS) {
        void queryClient.invalidateQueries({ queryKey });
      }
    }
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

/**
 * The cached verdict WITHOUT the probe — `null` until NetInfo has reported.
 * Telemetry-only (issue #4394's `Offline Artifact Transfer`), which is why it
 * never falls back to "unmetered" the way the gate above does: an absent prop is
 * honest, a fabricated `false` is not.
 */
export function getLastKnownMetered(): boolean | null {
  return isConnectionMetered;
}

/** Cold-launch state is per-process; tests re-arm it between cases. */
export function __resetMeteredStateForTests(): void {
  isConnectionMetered = null;
}

/**
 * The bucket a failed cycle is grouped by. `server_unavailable` (#4862) is the
 * one that had no home before: a 502/503/504, or any failure while the
 * connectivity store has already CONFIRMED the backend is down, used to land in
 * `server` or `exception` next to real defects. Splitting it out is what makes
 * "the backend was out for nine minutes" legible as an outage rather than a
 * spike of sync bugs — and it wins over `network`, because an outage we have
 * confirmed is a better answer than a transport guess made from error prose.
 */
function classifyCycleErrorKind(error: unknown, expected: boolean, status: number | null): string {
  if (error instanceof Error && error.name === 'AbortError') return 'aborted';
  // `reason`, not `backend`: it is already gated on the kill switch, and it has
  // resolved a captive portal or a dead uplink to `device_offline` rather than
  // blaming our server for the phone's problem.
  if (isServerUnavailableError(error) || getConnectivitySnapshot().reason === 'backend_unreachable') {
    return 'server_unavailable';
  }
  if (expected) return 'network';
  if (status !== null) return 'server';
  return error instanceof Error ? 'exception' : 'non-error';
}

// A failed cycle is recoverable — the scheduler retries after 30 seconds — but
// it still needs an operational terminal event. Artifact events alone cannot
// reveal whether the later deletion/user-data/board-data handoff failed, which
// made the multi-board "Waiting to download" incident look like a CDN wedge.
const warnCycleError = (error: unknown) => {
  const syncStatus = getSyncStatusSnapshot();
  // A drain can throw before this cycle emits progress. Do not attribute that
  // error to the idle frame left by the previous completed cycle.
  const progress = syncStatus.isSyncing ? syncStatus.progress : null;
  const expected = isNetworkError(error);
  const status = getErrorStatus(error);
  const errorKind = classifyCycleErrorKind(error, expected, status);
  const phase = progress?.phase ?? null;
  const currentTable = progress?.currentTable ?? null;
  const errorSignature = `${phase ?? 'unknown'}|${currentTable ?? 'none'}|${errorKind}|${status ?? 'none'}`;
  const now = Date.now();
  const shouldReport =
    errorSignature !== lastCycleErrorSignature || now < lastCycleErrorAt || now - lastCycleErrorAt >= 300_000;
  if (shouldReport) {
    track(SHARED_EVENTS.OfflineSyncCycleFailed, {
      phase,
      currentTable,
      documentsProcessed: progress?.documentsProcessed ?? 0,
      expected,
      status,
      errorKind,
      offlineEngineEnabled: isOfflineEngineEnabled(),
    });
    lastCycleErrorSignature = errorSignature;
    lastCycleErrorAt = now;
  }

  // Expected reachability failures remain out of Sentry: a phone moving between
  // networks is routine and PostHog now carries the retry/funnel signal. A
  // non-transport throw means the engine/database itself failed and deserves a
  // searchable handled exception as well.
  if (!expected && shouldReport) {
    reportHandledError(error, {
      tags: {
        source: 'offline-sync',
        kind: 'cycle',
        phase: progress?.phase ?? 'unknown',
      },
      extra: {
        currentTable: progress?.currentTable ?? null,
        documentsProcessed: progress?.documentsProcessed ?? 0,
      },
    });
  }

  if (__DEV__) {
    console.warn('[Sync] Sync cycle failed:', error instanceof Error ? error.message : 'unknown');
  }
};

let lastCycleErrorSignature: string | null = null;
let lastCycleErrorAt = 0;

/** Test-only reset for the cycle-error telemetry throttle. */
export function __resetCycleErrorDedupeForTests(): void {
  lastCycleErrorSignature = null;
  lastCycleErrorAt = 0;
}

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
    // Reachability, not just "a network is attached". `isConnected` is TRUE for
    // the whole of a captive portal or gym wifi with a dead upstream — the exact
    // connection `armBoardsOffline` exists for — so forwarding it alone gives
    // the scheduler no offline→online edge when that link starts working again:
    // an armed scope would sit pending until the user changed networks or
    // backgrounded and reopened the app. Since #4862 the store folds a confirmed
    // BACKEND outage into the same signal, so a scope armed during a server
    // outage gets its kick when the server returns, not just when the wifi does.
    let lastUsable = isUsableConnection();

    // Emit SYNCHRONOUSLY on subscribe, before returning. `startSyncScheduler`
    // seeds `wasConnected = true` and only runs a cycle on a false→true edge
    // (sync-scheduler.ts), so a scheduler started DURING an outage would never
    // see the recovery: from a seeded-true baseline, `usable` going true is not
    // an edge. Handing it the real current value at subscribe time is what makes
    // the recovery an edge again.
    callback(lastUsable);

    return subscribeConnectivityStore(() => {
      const usable = isUsableConnection();
      if (usable === lastUsable) return;
      lastUsable = usable;
      callback(usable);
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
    // A 5xx is not a reason to burn a queued write's retry budget (#4862): the
    // request was fine, the server was not. The store answers from its backoff
    // ladder when an outage is already known, so this costs a probe only when
    // the failure is the first news of one.
    confirmServerAvailability: options?.confirmServerAvailability ?? confirmBackendAvailability,
    // A probe that throws is "server down" for the drain's purposes, but never
    // silently: a probe broken on every call would end every 5xx cycle with no
    // strike and no operator signal. Warning level — it is handled — tagged so
    // it can be split from real network noise.
    onServerAvailabilityProbeError:
      options?.onServerAvailabilityProbeError ??
      ((error) =>
        reportHandledError(error, {
          level: 'warning',
          tags: { source: 'offline-sync', kind: 'availability-probe' },
        })),
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
  // Injected whenever the mobile build has a snapshot base URL (see
  // useSnapshotSource). Undefined retains the safe paged fallback for builds
  // without that URL.
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
    onScopeDownloadComplete: combinedScopeDownloadCompleteReporter(options?.onScopeDownloadComplete, queryClient),
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
    onScopeDownloadComplete: combinedScopeDownloadCompleteReporter(options?.onScopeDownloadComplete, queryClient),
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
    onScopeDownloadComplete: combinedScopeDownloadCompleteReporter(options?.onScopeDownloadComplete, queryClient),
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
