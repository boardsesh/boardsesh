// @boardsesh/offline-sync — the offline-first sync engine shared by app clients.
//
// Pure TS with zero runtime dependencies. Everything platform-specific is
// injected: the SQLite handle (OfflineDatabase — expo-sqlite's SQLiteDatabase is
// structurally assignable; a web consumer would supply SQLite-WASM/OPFS, NOT
// IndexedDB, because the engine's SQL is SQLite dialect), the GraphQL fetch,
// cache invalidation (QueryInvalidator), connectivity (DrainOptions.isOnline),
// scheduler wake-ups (SchedulerTriggers), and telemetry (onSchemaDrift /
// onCycleError). Apps bind these once in an adapter — mobile's lives at
// packages/mobile/src/offline/offline-sync-adapter.ts.
//
// The client half of docs/sync-table-manifest.md lives here: the SQLite DDL
// (db/schema.ts), the per-table sync config (sync/table-config.ts), and the
// pull client that enforces them must agree with the backend resolvers to the
// character.
//
// KNOWN CONSTRAINT: the drain/scheduler guards (drain flag, sign-out flag,
// wipe epoch, single-flight sync) are module-level singletons — correct for
// exactly ONE app runtime per JS context. A future web consumer must use it
// client-side only; importing this under SSR would leak that state across
// requests.

// --- Seams -------------------------------------------------------------------
export type { SqlValue, SqlRunResult, SqlExecutor, OfflineDatabase, QueryInvalidator } from './database';
export type { SyncCursorInput, SyncCursor, SyncResult, SyncDeletionRecord, SyncDeletionsResult } from './types';

// --- Mutation outbox (offline writes) ------------------------------------------
export {
  enqueue,
  peekPending,
  getPendingCount,
  getDeadLetterCount,
  getDeadLetters,
  getOutboxSummary,
  retryDeadLetter,
  discardDeadLetter,
  clearAll,
} from './mutation-queue/queue';
export type { PendingMutation, EnqueueResult, OutboxSummary } from './mutation-queue/queue';
export { parseQueueTimestamp, queueTimestampAgeDays } from './mutation-queue/queue-timestamps';
export {
  drainMutationQueue,
  isDraining,
  setSigningOut,
  isSigningOut,
  getWipeEpoch,
  capturePurgeToken,
  hasPurgeLanded,
  beginScopePurge,
  beginGlobalPurge,
  setBackgrounded,
  isBackgrounded,
  // Subscribed by the mobile downloader so a transfer can record that the app
  // was suspended while it ran without opening a second AppState listener
  // (issue #4390).
  onTeardown,
} from './mutation-queue/drainer';
export type {
  PurgeToken,
  DrainOptions,
  MutationDeliveryEvent,
  MutationStatusListenerFailure,
  MutationDeadLetterInfo,
  MutationDeadLetterReporter,
} from './mutation-queue/drainer';
export { ensureMutationQueueTable, MUTATION_QUEUE_SCHEMA } from './mutation-queue/schema';
export { processMutation } from './mutation-queue/handlers';
export type { GraphQLFetch } from './mutation-queue/handlers';
export {
  GRAPHQL_EMPTY_RESPONSE_ERROR_NAME,
  BACKEND_UNAVAILABLE_ERROR_NAME,
  GRAPHQL_REQUEST_TIMEOUT_CODE,
  isRetryable,
  isNetworkError,
  getErrorStatus,
  hasGraphqlErrorCode,
  isServerUnavailableError,
  isServerFailureSignal,
} from './mutation-queue/error-classification';

// --- Pull sync -----------------------------------------------------------------
export { pullSync, toSqliteValue, multiRowChunkSize, emptyScopeDownloadPhases } from './sync/pull-client';
export type {
  SyncProgress,
  SyncOptions,
  SchemaDriftReporter,
  BootstrapMetadataChangedInfo,
  BootstrapMetadataChangedReporter,
  ScopeDownloadCompleteInfo,
  ScopeDownloadCompleteReporter,
  ScopeDownloadStartInfo,
  ScopeDownloadStartReporter,
  ScopeDownloadPhaseBreakdown,
  CoverageResetInfo,
  CoverageResetReporter,
  CoverageEvaluatedInfo,
  CoverageEvaluatedReporter,
  BootstrapRetryScheduledInfo,
  BootstrapRetryScheduledReporter,
  BootstrapRetryWakeInfo,
  BootstrapRetryWakeReporter,
  BootstrapPathRecoveredInfo,
  BootstrapPathRecoveredReporter,
} from './sync/pull-client';

// --- Tombstone retention (issue #3474) --------------------------------------
// The backend prune job imports SYNC_DELETIONS_RETENTION_DAYS from here so the
// server's window and the client's staleness threshold can never fork.
// evaluateDeletionsCoverage / resetUserDataForLostCoverage stay package-internal
// on purpose (same reasoning as rewindDeletionsCheckpoint below): pull-client is
// their only caller, and no app should be able to trigger a local wipe directly.
export {
  SYNC_DELETIONS_RETENTION_DAYS,
  DELETIONS_COVERAGE_MARGIN_DAYS,
  DELETIONS_COVERAGE_MAX_AGE_MS,
} from './sync/retention';
export {
  bootstrapScopeFromSnapshot,
  bootstrapScopeGradesFromSnapshot,
  getBootstrapMetadataByScope,
  markBootstrapDone,
  isBootstrapDone,
  MAX_GRADES_BOOTSTRAP_ATTEMPTS,
  SNAPSHOT_IMPORT_BATCH_ROWS,
  SnapshotWipedError,
  SnapshotSchemaStaleError,
  SnapshotPermanentMissError,
  SnapshotWatermarkRegressionError,
  SnapshotArtifactTruncatedError,
  SnapshotBackgroundTransferInterruptedError,
} from './sync/snapshot-bootstrap';
export type {
  SnapshotSource,
  SnapshotArtifactHandle,
  SnapshotDownloadOptions,
  SnapshotDownloadProgress,
  SnapshotBootstrapResult,
  SnapshotImportBatchProgress,
  SnapshotBootstrapErrorReport,
  SnapshotBootstrapErrorReporter,
  BootstrapScopeMetadata,
} from './sync/snapshot-bootstrap';
export { classifySnapshotBootstrapFailure } from './sync/bootstrap-failure-reason';
export type { SnapshotBootstrapFailureReason } from './sync/bootstrap-failure-reason';

// --- Bootstrap retry budgets + cooldowns (issue #4313) ---------------------------
// The failure taxonomy that decides whether a snapshot failure is worth another
// artifact download, and when. `restoreBootstrapRetryBudget` is the user-facing
// escape from a settled scope ("Try the fast download again").
export {
  MAX_BOOTSTRAP_ATTEMPTS,
  MAX_TRANSPORT_DOWNLOAD_FAILURES,
  MAX_BOOTSTRAP_LOCK_FAILURES,
  MAX_STRUCTURAL_REARMS,
  EMPTY_BOOTSTRAP_RETRY_STATE,
  classifyBootstrapFailure,
  evaluateBootstrapEligibility,
  isTerminal as isBootstrapRetryTerminal,
  getBootstrapAttempts,
  readBootstrapRetryState,
  restoreBootstrapRetryBudget,
} from './sync/bootstrap-retry';
export type {
  BootstrapFailureKind,
  BootstrapRetryState,
  BootstrapRetryRead,
  BootstrapEligibility,
} from './sync/bootstrap-retry';
export { startSyncScheduler, triggerSync, isSyncInFlight } from './sync/sync-scheduler';
export type { SyncProgressSink, SchedulerTriggers, SchedulerOptions, DrainQueue } from './sync/sync-scheduler';
export {
  getCheckpoint,
  setCheckpoint,
  deleteCheckpoint,
  deleteAllCheckpoints,
  deleteUserCheckpoints,
  deleteAllSyncMeta,
  getCheckpointKey,
  markScopeDownloadComplete,
  isScopeDownloadComplete,
  isScopeDownloadStarted,
  getDownloadedScopeKeys,
  // The download funnel's other half (issue #4452): who still owes a terminal
  // event, and how to close their funnel once one has been emitted.
  getUnfinishedDownloadScopeKeys,
  clearScopeDownloadFunnelMarkers,
  // rewindDeletionsCheckpoint / compareCheckpoints / DELETIONS_CHECKPOINT_KEY
  // stay package-internal (only the bootstrap engine consumes them).
} from './sync/checkpoints';
export type { SyncCheckpoint } from './sync/checkpoints';
export { TABLE_CONFIGS, USER_DATA_TABLES, BOARD_DATA_TABLES } from './sync/table-config';
export type { TableSyncConfig } from './sync/table-config';
export { TABLE_INVALIDATE_KEYS, invalidateKeysForTable } from './sync/invalidate-keys';

// --- Live climb-stat write-through (issue #5227) ----------------------------------
// The second local writer of `board_climb_stats`: one gated statement per event
// from the layout-wide `climbStatsUpdated` stream, so a downloaded board's
// local-first reads see a recompute without waiting for the next pull.
export {
  writeClimbStatsEvent,
  parseClimbStatsRevision,
  CLIMB_STATS_WRITE_THROUGH_COLUMNS,
  CLIMB_STATS_WRITE_THROUGH_UNTOUCHED_COLUMNS,
  CLIMB_STATS_WRITE_THROUGH_LOCK_TIMEOUT_MS,
} from './sync/climb-stats-write-through';
export type {
  ClimbStatsWriteThroughInput,
  ClimbStatsWriteThroughResult,
  ClimbStatsWriteThroughStatus,
} from './sync/climb-stats-write-through';
export {
  LOCAL_USER_ID_KEY,
  USER_DATA_COMPLETE_KEY,
  getLocalUserId,
  stampLocalUserId,
  clearLocalUserId,
  assertLocalUserDataOwner,
  markUserDataComplete,
  isUserDataComplete,
  canServeLocalUserData,
} from './sync/local-user-owner';
export type { LocalUserOwnership } from './sync/local-user-owner';
export type { InvalidateKeys } from './sync/invalidate-keys';

// --- Reclaiming a downloaded board's disk space ----------------------------------
export { removeBoardScopeData, getScopeUsage, scopeSyncMetaKeys } from './sync/scope-teardown';
export type { AbandonedDownloadInfo, ScopeTeardownResult, ScopeUsage } from './sync/scope-teardown';
// Every path that ends a download for good claims its ONE terminal event here —
// the board removal above, plus the sign-out and de-list paths mobile owns
// (issue #4452). See download-terminal-registry.ts for why the claim is keyed on
// a teardown generation rather than a flag.
export { claimAbandonedDownloadTerminal } from './sync/download-terminal-registry';

// --- Board-snapshot manifest (Phase 2 export ↔ Phase 3 bootstrap) ----------------
export { parseSnapshotManifest, SNAPSHOT_MANIFEST_FORMAT_VERSION } from './sync/snapshot-manifest';
export type {
  SnapshotManifest,
  SnapshotManifestEntry,
  SnapshotTableStats,
  SnapshotTableName,
  SnapshotGradesArtifact,
  SnapshotGradesTableName,
} from './sync/snapshot-manifest';

// --- Pre-download size estimate (issue #3616) ------------------------------------
// Answers "how big is this download?" before the user commits. Shares its entry
// lookup + schema gate with runBootstrapPhase so the number can't contradict the
// engine.
export { estimateScopeDownload, findSnapshotEntry, isSnapshotEntryUsable } from './sync/snapshot-estimate';
export type { SnapshotDownloadEstimate } from './sync/snapshot-estimate';

// --- Snapshot download/import progress (issue #4311) -----------------------------
// The wire-scale frame the bootstrap phase emits while an artifact downloads and
// imports, plus the pure denominator + throttle rules behind it.
export {
  createDownloadFractionAnchor,
  createSnapshotProgressThrottle,
  resolveDownloadFraction,
  toWireProgress,
  DOWNLOAD_PROGRESS_THROTTLE_MS,
} from './sync/snapshot-progress';
export type {
  SnapshotBootstrapProgress,
  SnapshotBootstrapStage,
  DownloadFractionAnchor,
  SnapshotProgressThrottle,
} from './sync/snapshot-progress';

// --- On-device schema ------------------------------------------------------------
export { vacuumDatabase, measureReclaimableBytes } from './db/vacuum';
export { SCHEMA_STATEMENTS } from './db/schema';
export { runMigrations, MIGRATIONS, LATEST_SCHEMA_VERSION } from './db/migrations';
export type { Migration } from './db/migrations';
export {
  OFFLINE_DB_BUSY_TIMEOUT_MS,
  OFFLINE_DB_FOREGROUND_WRITE_TIMEOUT_MS,
  OFFLINE_DB_RETRY_BUSY_TIMEOUT_MS,
  OFFLINE_DB_FALLBACK_BUSY_TIMEOUT_MS,
  applyBusyTimeout,
  beginImmediateWrite,
  configureMainConnection,
} from './db/pragmas';

// --- Local write retry (issue #4315) ---------------------------------------------
// One ladder for every local SQLite write that can lose the single-writer lock.
// Silent when the first attempt succeeds, so `onSettled` fires only on a
// contended write; a terminal failure rethrows the ORIGINAL error object, which
// keeps Sentry grouping and lock classification unchanged.
export { runLocalWriteWithRetry, OFFLINE_LOCAL_WRITE_BUDGET_MS } from './db/write-retry';
export type { LocalWriteRetryOptions, LocalWriteRetryOutcome } from './db/write-retry';
// One predicate for "was this write-lock contention?", so reporting (#4329) and
// the sqlite-init retry loop (#4314) can never disagree about which failures
// count. `classifySqliteLockError` is the same verdict plus the SQLite result
// code, for callers that tag telemetry with it.
export { isDatabaseLockedError, classifySqliteLockError } from './db/lock-errors';
export type { SqliteLockClassification } from './db/lock-errors';

// --- Offline-usage telemetry (issue #4317) ---------------------------------------
// The rollup gate that turns "this read was served from the local DB" into a
// low-volume, chartable signal. `emit` is injected so the package keeps zero
// runtime deps and never imports an analytics client — mobile binds it in
// packages/mobile/src/offline/offline-usage-signal.ts.
export { createOfflineUsageSignal } from './telemetry/offline-usage-signal';
export type {
  OfflineConnectivityReason,
  OfflineReadLane,
  OfflineReadSurface,
  OfflineUnavailableReason,
  OfflineUsageEmission,
  OfflineUsageSignal,
  OfflineUsageSignalOptions,
} from './telemetry/offline-usage-signal';

// --- Offline board scope keys ----------------------------------------------------
export {
  offlineBoardKey,
  offlineBoardKeyForBoard,
  offlineBoardScopeForBoard,
  parseOfflineBoardKey,
  purgeNamespaceKey,
  purgeNamespaceForScopeKey,
} from './offline-board-key';
export type { OfflineBoardScope, OfflineBoardLike } from './offline-board-key';
