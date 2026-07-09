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
  retryDeadLetter,
  discardDeadLetter,
  clearAll,
} from './mutation-queue/queue';
export type { PendingMutation } from './mutation-queue/queue';
export { drainMutationQueue, isDraining, setSigningOut, isSigningOut, getWipeEpoch } from './mutation-queue/drainer';
export type { DrainOptions } from './mutation-queue/drainer';
export { ensureMutationQueueTable, MUTATION_QUEUE_SCHEMA } from './mutation-queue/schema';
export { processMutation } from './mutation-queue/handlers';
export type { GraphQLFetch } from './mutation-queue/handlers';
export { isRetryable, isNetworkError, getErrorStatus } from './mutation-queue/error-classification';

// --- Pull sync -----------------------------------------------------------------
export { pullSync, toSqliteValue, multiRowChunkSize } from './sync/pull-client';
export type { SyncProgress, SyncOptions, SchemaDriftReporter } from './sync/pull-client';
export {
  bootstrapScopeFromSnapshot,
  getBootstrapAttempts,
  recordBootstrapAttempt,
  markBootstrapDone,
  isBootstrapDone,
  MAX_BOOTSTRAP_ATTEMPTS,
  SnapshotWipedError,
  SnapshotSchemaStaleError,
  SnapshotPermanentMissError,
} from './sync/snapshot-bootstrap';
export type {
  SnapshotSource,
  SnapshotBootstrapResult,
  SnapshotBootstrapErrorReporter,
} from './sync/snapshot-bootstrap';
export { startSyncScheduler, triggerSync } from './sync/sync-scheduler';
export type { SyncProgressSink, SchedulerTriggers, SchedulerOptions, DrainQueue } from './sync/sync-scheduler';
export {
  getCheckpoint,
  setCheckpoint,
  deleteCheckpoint,
  deleteAllCheckpoints,
  deleteUserCheckpoints,
  getCheckpointKey,
  markScopeDownloadComplete,
  isScopeDownloadComplete,
  getDownloadedScopeKeys,
  // rewindDeletionsCheckpoint / compareCheckpoints / DELETIONS_CHECKPOINT_KEY
  // stay package-internal (only the bootstrap engine consumes them).
} from './sync/checkpoints';
export type { SyncCheckpoint } from './sync/checkpoints';
export { TABLE_CONFIGS, USER_DATA_TABLES, BOARD_DATA_TABLES } from './sync/table-config';
export type { TableSyncConfig } from './sync/table-config';

// --- Board-snapshot manifest (Phase 2 export ↔ Phase 3 bootstrap) ----------------
export { parseSnapshotManifest, SNAPSHOT_MANIFEST_FORMAT_VERSION } from './sync/snapshot-manifest';
export type {
  SnapshotManifest,
  SnapshotManifestEntry,
  SnapshotTableStats,
  SnapshotTableName,
} from './sync/snapshot-manifest';

// --- On-device schema ------------------------------------------------------------
export { SCHEMA_STATEMENTS } from './db/schema';
export { runMigrations, MIGRATIONS, LATEST_SCHEMA_VERSION } from './db/migrations';
export type { Migration } from './db/migrations';

// --- Offline board scope keys ----------------------------------------------------
export {
  offlineBoardKey,
  offlineBoardKeyForBoard,
  offlineBoardScopeForBoard,
  parseOfflineBoardKey,
} from './offline-board-key';
export type { OfflineBoardScope, OfflineBoardLike } from './offline-board-key';
