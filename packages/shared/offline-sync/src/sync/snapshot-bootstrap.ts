// Client-side snapshot bootstrap (offline-sync Phase 3).
//
// A freshly-enabled board would otherwise page its whole reference catalog
// (200k+ climbs) over GraphQL before it is browsable offline. Instead, this
// warms the scope from a pre-built SQLite artifact (the nightly export job in
// packages/backend/src/scripts/export-board-snapshots.ts), then lets the normal
// paged pull resume from the imported scope's watermarks — a ~1-day delta rather
// than the full crawl. The two paths are byte-identical by construction (the export
// reuses the client's `toSqliteValue` shaping); the backend snapshot-export-golden
// test pins that equivalence.
//
// Platform I/O is injected via `SnapshotSource`: the shared engine never fetches,
// downloads, or gunzips — it ATTACHes a decompressed artifact file the adapter
// hands it, imports the scope's rows, and stamps the resume checkpoints. The
// import filter is EXACTLY as wide as the sync resolvers' scope filter
// (packages/backend/.../sync/queries.ts): a row the resolver's scope would return
// with a cursor ≤ watermark but this import dropped would be lost forever (the
// strict `>` delta never revisits it), so when in doubt this imports MORE — extra
// rows are harmless because reads are scoped.

import type { OfflineDatabase, SqlExecutor } from '../database';
import { purgeNamespaceKey, type OfflineBoardScope } from '../offline-board-key';
import type { SnapshotGradesArtifact, SnapshotManifestEntry, SnapshotTableName } from './snapshot-manifest';
import { SNAPSHOT_MANIFEST_FORMAT_VERSION } from './snapshot-manifest';
import { climbsScopeFilter, isSizeScopedBoard } from './board-scope-sql';
import { TABLE_CONFIGS } from './table-config';
import {
  compareCheckpoints,
  getCheckpointKey,
  rewindDeletionsCheckpoint,
  SCOPE_COMPLETE_PREFIX,
  setCheckpoint,
  type SyncCheckpoint,
} from './checkpoints';
import { capturePurgeToken, hasPurgeLanded, isSigningOut } from '../mutation-queue/drainer';
import { LATEST_SCHEMA_VERSION } from '../db/migrations';
import { applyBulkImportPragmas, applyBusyTimeout } from '../db/pragmas';
import { isDatabaseLockedError } from '../db/lock-errors';
import {
  BOOTSTRAP_ATTEMPTS_PREFIX,
  BOOTSTRAP_PAGED_FALLBACK_PREFIX,
  BOOTSTRAP_RETRY_PREFIX,
  clearBootstrapPagedFallback,
  isTerminal,
  parseBootstrapRetryState,
  type BootstrapRetryState,
} from './bootstrap-retry';
import type { SchemaDriftReporter } from './pull-client';
import type { SnapshotBootstrapFailureReason } from './bootstrap-failure-reason';

/**
 * The two reference tables a WHOLE-LAYOUT snapshot carries; import order is
 * climbs → stats.
 *
 * Stays exactly two. `verifySnapshotMeta` iterates this list and throws
 * `snapshot_meta missing row for <table>` on a miss, and an import failure is
 * COUNTED — so widening it would make every newly-updated client reject every
 * artifact published before the change (live for the 14-day prune grace, plus
 * CDN-cached manifests), twice, and settle the scope onto the paged crawl.
 * Boardsesh grades therefore arrive in their OWN file, verified against their
 * own one-element list. See GRADES_SNAPSHOT_TABLES.
 */
const SNAPSHOT_TABLES = ['board_climbs', 'board_climb_stats'] as const;

/** The single table the separate per-layout grades artifact carries. */
const GRADES_SNAPSHOT_TABLES = ['board_climb_grades'] as const;

/** The ATTACH alias for the artifact; the only ATTACH the DB lifecycle performs. */
const SNAPSHOT_ALIAS = 'bs_snapshot';

/**
 * Rows one import transaction moves before it COMMITs and lets go of the write
 * lock (issue #4310). The whole-layout import used to be a single
 * `BEGIN EXCLUSIVE` around ~710k rows; it is now ceil(rows / this) short ones.
 *
 * SIZING, from the throughput the fleet actually reports on Kilter — 67,852
 * rows/s p50 on iOS, 33,631 rows/s p50 on Android. 5,000 rows is ~150ms p50,
 * comfortably inside the 2,500ms window a foreground write
 * (OFFLINE_DB_FOREGROUND_WRITE_TIMEOUT_MS) gets before it gives up. At the worst
 * import throughput ever observed (710,646 rows in 253,939ms = 2,798 rows/s) a
 * batch is ~1.8s — still inside that window, but only just.
 *
 * Do not lower it on a hunch: 5,000 already means ~142 commits for a Kilter
 * layout, and every commit is an fsync the batching only affords because
 * `applyBulkImportPragmas` drops the import connection to `synchronous =
 * NORMAL`. The number to read before changing it is `importLockMaxMs` p99 on
 * `Offline Board Download Completed`, which this import emits for exactly that.
 *
 * THE SECOND PER-COMMIT COST, which the fsync argument above does not cover:
 * SQLite attempts a WAL autocheckpoint at COMMIT, and nothing here overrides the
 * 1000-page default. The single pre-#4310 transaction paid that once, at the end;
 * batching moves it inside the holds, crossing the threshold roughly every 4 MB
 * of WAL, so a minority of batches COMMIT with a passive checkpoint (page copy-
 * back plus the WAL sync `synchronous = NORMAL` still performs before one) inside
 * `heldMs`. So the `importLockMaxMs` tail is set by checkpoint-carrying batches,
 * not by the ~150 ms typical batch this number is sized from, and that same cost
 * is the most likely way `importRowsMs` regresses against the single transaction.
 * `wal_autocheckpoint = 0` for the import would move it out of the holds at the
 * price of a WAL that grows to the size of the whole import on a phone — not a
 * trade worth making before `importLockMaxMs` says the tail is a problem.
 */
export const SNAPSHOT_IMPORT_BATCH_ROWS = 5_000;

/**
 * The connection-scoped staging table holding this scope's climb UUIDs. Built
 * once per import in autocommit, then read by every climbs batch (as a rowid
 * range) and every stats batch (as the semi-join the correlated EXISTS over the
 * artifact's `board_climbs` used to be).
 *
 * TEMP, so it lives on the import task's own connection and dies with it — the
 * expo wrapper tears that connection down after the task, and the DROP below
 * covers the same-connection test double where a second scope would otherwise
 * meet a table that already exists.
 */
const IMPORT_STAGING_TABLE = 'bs_import_climbs';

/**
 * Backoff before re-attempting a batch's `BEGIN EXCLUSIVE` that lost the lock
 * race outright (issue #4310).
 *
 * Batching turns the import from the lock's sole owner into a repeat contender:
 * one acquisition becomes ~143 against writers that genuinely exist — every tick
 * and favorite, plus a `removeBoardScopeData` for a DIFFERENT layout, which this
 * scope's purge guard does not cover and which scope-teardown.ts's own header
 * says "runs for seconds on a 40k-climb layout", i.e. longer than the import
 * connection's 5s `busy_timeout`. Throwing a whole 103 MB import away for one
 * lost race would be worse than the mega-transaction this replaces, so a lock
 * failure gets a short ladder before it becomes an import failure at all. What
 * happens if the ladder is also exhausted is `classifyBootstrapFailure`'s job:
 * a lock-shaped import failure is NOT charged to the structural budget.
 */
const IMPORT_LOCK_RETRY_DELAYS_MS = [250, 750, 2000] as const;

/** The ATTACH alias for the separate grades artifact (its own transaction, its own connection). */
const GRADES_ALIAS = 'bs_grades';

/**
 * Two grades-import attempts, counted SEPARATELY from the whole-layout
 * bootstrap's retry budgets (bootstrap-retry.ts). A grades import that fails
 * must never cost the scope its snapshot fast path: the worst case here is
 * exactly today's behaviour — the scope crawls `board_climb_grades` page by
 * page — so it gets its own plain counter rather than spending the transport or
 * structural budget the whole-layout artifact is bounded by.
 */
export const MAX_GRADES_BOOTSTRAP_ATTEMPTS = 2;
export const GRADES_BOOTSTRAP_ATTEMPTS_PREFIX = 'grades-bootstrap-attempts:';

// Package-internal (deliberately NOT re-exported from index.ts, same posture as
// checkpoints.ts's DELETIONS_CHECKPOINT_KEY): scope-teardown.ts must clear this
// alongside the rows it describes, so it needs the exact key spelling. The
// retry-accounting keys live in bootstrap-retry.ts, which owns their writes.
export const BOOTSTRAP_DONE_PREFIX = 'bootstrap-done:';
const EPOCH_WATERMARK: SyncCheckpoint = { updatedAt: '1970-01-01T00:00:00.000Z', syncSeq: '0' };

// Only snake_case identifiers may be spliced into the INSERT/SELECT column list.
// Every offline DDL column uses that contract (`board_type`, never the app-level
// `boardType`), and the snapshot exporter enforces the same regex. The names come
// from PRAGMA table_info over our own DDL (trusted), but validating keeps the
// string-built SQL provably injection-free.
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** Byte progress for one artifact download, as the transport observes it. */
export type SnapshotDownloadProgress = {
  bytesWritten: number;
  /** `null` when the server sent no Content-Length — never a negative sentinel. */
  totalBytes: number | null;
};

/** Per-download seams the engine may pass; every one is optional for a source. */
export type SnapshotDownloadOptions = {
  onProgress?: (progress: SnapshotDownloadProgress) => void;
  /**
   * Aborted when the cycle is torn down mid-transfer (sign-out, local purge, or
   * the app going to background). Without it the native transfer keeps running
   * — and keeps burning a metered connection — long after the engine stopped
   * caring about the result.
   */
  signal?: AbortSignal;
};

/** What a source hands back for one downloaded (or retained) artifact. */
export type SnapshotArtifactHandle = {
  filePath: string;
  /**
   * True when the file was already on disk from an earlier cycle and no bytes
   * were fetched. The engine treats an import failure on a REUSED artifact
   * differently: it deletes the file and spends NO retry budget, because a
   * corrupt retained file would otherwise spend the whole structural-artifact
   * budget against the same bytes and strand the scope on the paged crawl
   * forever (issue #4313's failure mode).
   */
  reused?: boolean;
};

/**
 * Platform-injected snapshot I/O. The adapter (mobile: Phase 4) owns the network
 * and gzip; the engine only consumes what these return.
 */
export interface SnapshotSource {
  /**
   * Fetch the raw manifest JSON (the engine validates it via parseSnapshotManifest).
   * Return `null` when the manifest resource does not exist yet (e.g. a 404 before
   * the first export run) — a permanent miss this cycle, not a failure. THROW on a
   * transport/parse error so the engine applies its global, cap-exempt manifest
   * retry policy. (`unknown` already admits `null`; the return is `unknown` rather
   * than `unknown | null` only because the linter forbids that redundancy.)
   */
  fetchManifest(): Promise<unknown>;
  /**
   * Download (and decompress) one artifact to a local path ready to ATTACH as a
   * plain SQLite file. Return `null` or throw on retryable failure — both count
   * as a bootstrap attempt. Throw SnapshotPermanentMissError for a known
   * unusable artifact that should fall through to the paged pull immediately —
   * the crawl runs in the same cycle, and the engine charges it to the scope's
   * structural-device budget so an artifact this device can never use is not
   * downloaded again on every cycle.
   *
   * `options.onProgress` (issue #4311) is optional on BOTH sides: an
   * implementation written against the one-argument signature keeps compiling
   * and behaves exactly as before, and the engine tolerates a source that never
   * invokes the callback (the row keeps the static "Downloading board…"
   * caption). `bytesWritten` is whatever the platform downloader counts — which
   * may be DECODED bytes for a gzip artifact — and `totalBytes` is null when the
   * platform has no usable total (Android reports Content-Length -1 after
   * transparent gunzip). Reconciling those scales is the engine's job in
   * `resolveDownloadFraction`; a source must not attempt it.
   */
  downloadArtifact(
    entry: SnapshotManifestEntry,
    options?: SnapshotDownloadOptions,
  ): Promise<SnapshotArtifactHandle | null>;
  /**
   * Download the layout's SEPARATE Boardsesh-grades artifact (issue #4310).
   * Same failure contract as `downloadArtifact` — but NOT the same retention
   * contract: a grades file is never handed to `releaseArtifact`. The engine
   * deletes it through `deleteArtifact` at the end of every cycle, because
   * retention is sized and keyed for the ~100 MB whole-layout file (its
   * supersede sweep pairs a build with a `<board>-<layout>` filename prefix a
   * grades name does not carry). Re-fetching a few MB is the cheaper failure.
   *
   * OPTIONAL: a source that does not implement it — or a manifest entry with no
   * `grades` block — makes the engine take today's path verbatim, crawling
   * `board_climb_grades` page by page. An updated engine against an old
   * manifest and a new manifest against an old engine therefore both behave
   * exactly as before.
   */
  downloadGradesArtifact?(artifact: SnapshotGradesArtifact): Promise<{ filePath: string } | null>;
  /** Delete a downloaded artifact once the run is done with it. Best-effort. */
  deleteArtifact(filePath: string): Promise<void>;
  /**
   * Hand an artifact back at the end of the bootstrap phase. `imported: false`
   * means the phase never got to use it — a backgrounded cycle, a wipe, an
   * aborted download — and a source that supports retention should KEEP the
   * file so the next cycle can reuse it instead of re-fetching 100 MB (issue
   * #4310: `runBootstrapPhase` used to delete every artifact unconditionally,
   * so locking the phone mid-cycle cost the whole download).
   *
   * OPTIONAL, and the engine falls back to `deleteArtifact` when it is absent,
   * so a source written against the shipped contract behaves exactly as before.
   */
  releaseArtifact?(filePath: string, options: { imported: boolean }): Promise<void>;
}

/** Where a bootstrap failed, for telemetry. */
export type SnapshotBootstrapErrorReport = {
  scopeKey: string;
  /**
   * How far the attempt got. `board-removed` and `abandoned` are the two values
   * no bootstrap stage produces.
   *
   * `board-removed` is reported by the teardown when a board is removed
   * mid-download (issue #4406), which can happen at any stage — including the
   * paged delta crawl that runs long after the bootstrap phase has finished — so
   * naming a bootstrap stage there would invent a precision the teardown does
   * not have.
   *
   * `abandoned` is the same story for the de-listing paths (issue #4452):
   * sign-out, and the My Boards toggle-off. It is a SEPARATE value rather than
   * more `board-removed` on purpose — `board-removed` already ships in
   * dashboards and means "the rows were deleted", which is exactly what these
   * paths do NOT do. The `reason` says which de-listing it was.
   */
  stage: 'manifest' | 'download' | 'import' | 'grades-download' | 'grades-import' | 'board-removed' | 'abandoned';
  attempt: number;
  cause: unknown;
  /**
   * The coarse "why" (issue #4314). Always set — the engine fills it in from the
   * cause when a call site does not name one — so the funnel's Failed leg can be
   * grouped by reason instead of by unbounded error text.
   */
  reason: SnapshotBootstrapFailureReason;
  /**
   * True when the phase BAILED rather than failed: a sign-out, a board removal
   * (any purge of its namespace), or the app backgrounding. Nothing is broken and no
   * retry budget was spent — the same scope resumes on the next cycle.
   *
   * These used to emit NOTHING at all, which is why a download that stopped was
   * structurally invisible: `Offline Board Download Started` fired, the cycle was
   * torn down, and no terminal event ever arrived (issue #4314). They are
   * reported now so every Started has a terminal event, but they are NOT defects:
   * a consumer computing a failure RATE must exclude them, and the mobile
   * reporter deliberately keeps them out of Sentry.
   */
  aborted: boolean;
  /**
   * True when the failure is a transport/reachability one — the device was
   * offline or the connection dropped, which is the normal state of a phone on
   * a plane, not a defect in the artifact or the client. The mobile reporter
   * downgrades these to a warning instead of an error (issue #4238). False for
   * everything an engineer would actually want to look at: a corrupt artifact, a
   * row-count mismatch, a schema-stale import, a permanent miss.
   *
   * SEVERITY ONLY. Whether the failure burns a bootstrap attempt is a separate,
   * per-stage decision in `settleRetryableBootstrapFailure`: a transport-shaped
   * MANIFEST failure is free, a transport-shaped DOWNLOAD failure still counts
   * (the manifest already proved the device was online, and an unresumable
   * 272 MB retry loop is worse than the paged crawl).
   */
  expected: boolean;
};

export type SnapshotBootstrapErrorReporter = (report: SnapshotBootstrapErrorReport) => void;

export type SnapshotBootstrapResult = {
  climbsWatermark: SyncCheckpoint;
  statsWatermark: SyncCheckpoint;
  /**
   * Rows this scope actually imported out of the layout artifact (issue #4316).
   * Both are INSERT OR REPLACE `changes` counts, so a re-import of the same
   * scope reports the same numbers rather than zero — they measure the work
   * done, not the net row growth. Reported on the download-funnel's Completed
   * event so a slow download can be normalised against payload size.
   */
  climbsImported: number;
  statsImported: number;
  /**
   * Where the import's time went, and — the number this split exists for — how
   * long it actually HELD the write lock (issue #4310).
   *
   * `importMs` on `Offline Board Download Completed` is stamped around this
   * whole call, and most of it is autocommit work holding nothing: ATTACH,
   * `PRAGMA quick_check` over a 271 MB artifact, two full `COUNT(*)` truncation
   * checks, and the scoped watermark reads. `importVerifyMs` measures that
   * preamble. `importLockMaxMs` is the LONGEST single exclusive transaction —
   * i.e. the worst case a concurrent user write has to survive (#4314) — which
   * before batching was the entire import and had never been measured.
   *
   * `importLockMaxMs` covers the reconcile transaction, every row batch, and the
   * final checkpoint transaction. `reconcileScope` is still ONE unbatched
   * transaction, so on a heal-over-partial (#4313) or a second size of an
   * already-downloaded layout it can be the maximum rather than a batch — that
   * population is the named follow-up, and this number is how it gets read.
   *
   * HOLD vs WAIT, kept apart on purpose. `importLockMaxMs` starts after
   * `BEGIN EXCLUSIVE` succeeds, so it is a hold and nothing else. The time spent
   * WAITING to acquire — up to `busy_timeout` per attempt plus the 250/750/2000 ms
   * ladder — is accumulated into `importLockWaitMs` and SUBTRACTED from
   * `importReconcileMs` and `importRowsMs`, so those two are work-plus-hold. Left
   * in, a reconcile that executed in 40 ms behind a `removeBoardScopeData` would
   * report seconds, and the follow-up trigger for batching `reconcileScope`
   * (`importReconcileMs` p90 on `bootstrapHealed = true`) would fire on
   * contention rather than on reconcile cost — the same conflation between "time
   * elapsed" and "time holding the lock" that this whole split exists to undo.
   *
   * ONE COST STAYS INSIDE THE HOLD, unavoidably: SQLite attempts a WAL
   * autocheckpoint at COMMIT, and nothing in this engine overrides the 1000-page
   * default (grep `wal_autocheckpoint`: only the explicit TRUNCATE checkpoints in
   * vacuum.ts and remove-offline-board.ts exist). The single pre-#4310
   * transaction paid that once, after everything; ~142 commits cross the
   * threshold roughly every 4 MB of WAL, so some batches carry a passive
   * checkpoint — copying pages back into the main DB plus the WAL sync
   * `synchronous = NORMAL` still performs before one — inside their COMMIT, and
   * therefore inside `heldMs`. Read `importLockMaxMs` p90 knowing its tail is
   * checkpoint-carrying batches, not the ~150 ms typical batch
   * `SNAPSHOT_IMPORT_BATCH_ROWS` is sized from. Disabling the autocheckpoint for
   * the import would move that cost out of the holds but let the WAL grow to the
   * size of the whole import on a phone, which is a worse trade.
   */
  importVerifyMs: number;
  importReconcileMs: number;
  importRowsMs: number;
  importLockMaxMs: number;
  /**
   * Total time spent waiting for `BEGIN EXCLUSIVE` across every exclusive
   * transaction of this import: `busy_timeout` blocking plus the retry ladder's
   * sleeps. Non-zero means the import met real contention, which is what decides
   * whether `IMPORT_LOCK_RETRY_DELAYS_MS` and the batch size are tuned right.
   */
  importLockWaitMs: number;
  /** Exclusive transactions the row import committed: climbs batches + stats batches. */
  importBatches: number;
};

/**
 * Thrown when a sign-out wipe starts (or fully completes) mid-import. The
 * enclosing transaction rolls back — no rows, no checkpoints — and the pull
 * client treats it as a bail-out, NOT a counted failure (mirrors syncTable).
 */
export class SnapshotWipedError extends Error {
  constructor() {
    super('snapshot bootstrap aborted: local data wipe in progress');
    this.name = 'SnapshotWipedError';
  }
}

/**
 * Thrown by a SnapshotSource when an artifact is known unusable for this client
 * but the normal paged crawl should run in the same cycle. Example: a mobile
 * downloader persisted a raw gzip stream and the shared engine has no gunzipper.
 *
 * Raised at the DOWNLOAD stage this costs the scope a structural-device slot:
 * the bytes were already spent, and the fault is the device's HTTP stack, which
 * tonight's export cannot fix. Raised before any bytes move (a missing manifest
 * entry) it is free — that is a different, cheap decision made by the caller.
 */
export class SnapshotPermanentMissError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotPermanentMissError';
  }
}

/**
 * The transfer finished but wrote a different number of bytes than the manifest
 * promises (issue #4394). `entry.uncompressedBytes` is exact — the export writes
 * the SQLite file's own byte length — so this is an unambiguous integrity gate
 * that the gzip magic-byte sniff (two bytes) and `quick_check` (after the file
 * has been retained and ATTACHed) do not give.
 *
 * Charged to the TRANSPORT budget, not `structural-device`: a short body IS a
 * cut-short response, and the structural ladder would durably settle a scope
 * onto the paged crawl after two occurrences with no `builtAt` re-arm.
 */
export class SnapshotArtifactTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotArtifactTruncatedError';
  }
}

/**
 * The iOS background URLSession was interrupted while decoding a response body.
 * Expo surfaces NSURLErrorCannotDecodeRawData as English prose without a stable
 * code, so the mobile adapter converts that one platform-shaped error into this
 * renderer-independent signal. It belongs on the bounded transport retry
 * ladder, not the structural artifact/device budget.
 */
export class SnapshotBackgroundTransferInterruptedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SnapshotBackgroundTransferInterruptedError';
  }
}

// --- Attempt / done markers (sync_meta, NOT under the checkpoint: prefix so the
// sign-out checkpoint wipe leaves them alone, matching the board rows they
// describe, which survive as the shared cache) ---------------------------------

export type BootstrapScopeMetadata = {
  /**
   * The legacy `bootstrap-attempts:` mirror. Kept for rollback compatibility and
   * for callers that only want "has this scope failed before"; the budgets the
   * engine actually enforces are `structuralFailures` / `isTerminal` below.
   */
  readonly attempts: number;
  /** The scope has imported a snapshot, even if its delta pull has not finished yet. */
  readonly isBootstrapDone: boolean;
  /** The latest bootstrap decision for this scope selected the ordinary paged crawl. */
  readonly isPagedFallback: boolean;
  /** Either board table has a checkpoint. */
  readonly hasBoardCheckpoint: boolean;
  /** The whole scope has reached the tail and can serve complete offline results. */
  readonly isScopeComplete: boolean;
  /** Epoch ms of the next scheduled snapshot retry, or null when none is pending. */
  readonly retryAfter: number | null;
  /** Structural (artifact/device) failures spent from the current budget. */
  readonly structuralFailures: number;
  /** Both budgets are spent: only a user-requested retry or a teardown revives it. */
  readonly isTerminal: boolean;
};

type MutableBootstrapScopeMetadata = {
  -readonly [Field in keyof BootstrapScopeMetadata]: BootstrapScopeMetadata[Field];
};

const BOARD_CLIMBS_CHECKPOINT_PREFIX = 'checkpoint:board_climbs:';
const BOARD_STATS_CHECKPOINT_PREFIX = 'checkpoint:board_climb_stats:';

export const BOOTSTRAP_METADATA_PATTERNS = [
  `${BOOTSTRAP_ATTEMPTS_PREFIX}*`,
  `${BOOTSTRAP_DONE_PREFIX}*`,
  `${BOOTSTRAP_PAGED_FALLBACK_PREFIX}*`,
  `${BOOTSTRAP_RETRY_PREFIX}*`,
  `${BOARD_CLIMBS_CHECKPOINT_PREFIX}*`,
  `${BOARD_STATS_CHECKPOINT_PREFIX}*`,
  `${SCOPE_COMPLETE_PREFIX}*`,
] as const;

// GRADES_BOOTSTRAP_ATTEMPTS_PREFIX is intentionally absent. That independent
// retry budget is read on demand by the grades importer and is not a field in
// BootstrapScopeMetadata; pulling it into this UI batch would create phantom
// metadata rows for scopes whose whole-layout bootstrap state is untouched.

// GLOB's literal-prefix optimization uses sync_meta's binary primary-key index.
// SQLite's default case-insensitive LIKE cannot use that index and scans every
// metadata row, which is especially expensive after years of sync checkpoints.
// Built FROM the pattern list rather than hand-written, so adding a prefix can
// never leave a dangling clause or drop one silently (a test pins the counts).
export const BOOTSTRAP_METADATA_QUERY = `SELECT key, value
  FROM sync_meta
  WHERE ${BOOTSTRAP_METADATA_PATTERNS.map(() => 'key GLOB ?').join('\n     OR ')}`;

function parseBootstrapAttempts(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Read bootstrap state for many board scopes in one indexed `sync_meta` query.
 *
 * My Boards needs this after the bootstrap phase, but reading one marker per row
 * would turn a virtualised list into N SQLite round trips. The returned map is
 * keyed by exact scope key, so rows can look up their immutable metadata in O(1).
 * Missing entries deliberately mean an untouched, still-eligible scope.
 */
export async function getBootstrapMetadataByScope(
  db: SqlExecutor,
  scopeKeys: readonly string[],
): Promise<ReadonlyMap<string, BootstrapScopeMetadata>> {
  const requestedScopes = new Set(scopeKeys);
  if (requestedScopes.size === 0) return new Map();

  // Scope keys are not interpolated into SQL. Prefix filtering avoids a
  // variable-length IN clause (and SQLite's bind limit) for large board lists.
  const rows = await db.getAllAsync<{ key: string; value: string }>(BOOTSTRAP_METADATA_QUERY, [
    ...BOOTSTRAP_METADATA_PATTERNS,
  ]);
  const metadataByScope = new Map<string, MutableBootstrapScopeMetadata>();

  for (const row of rows) {
    const attemptsScopeKey = row.key.startsWith(BOOTSTRAP_ATTEMPTS_PREFIX)
      ? row.key.slice(BOOTSTRAP_ATTEMPTS_PREFIX.length)
      : null;
    const doneScopeKey = row.key.startsWith(BOOTSTRAP_DONE_PREFIX) ? row.key.slice(BOOTSTRAP_DONE_PREFIX.length) : null;
    const fallbackScopeKey = row.key.startsWith(BOOTSTRAP_PAGED_FALLBACK_PREFIX)
      ? row.key.slice(BOOTSTRAP_PAGED_FALLBACK_PREFIX.length)
      : null;
    const retryScopeKey = row.key.startsWith(BOOTSTRAP_RETRY_PREFIX)
      ? row.key.slice(BOOTSTRAP_RETRY_PREFIX.length)
      : null;
    const climbsCheckpointScopeKey = row.key.startsWith(BOARD_CLIMBS_CHECKPOINT_PREFIX)
      ? row.key.slice(BOARD_CLIMBS_CHECKPOINT_PREFIX.length)
      : null;
    const statsCheckpointScopeKey = row.key.startsWith(BOARD_STATS_CHECKPOINT_PREFIX)
      ? row.key.slice(BOARD_STATS_CHECKPOINT_PREFIX.length)
      : null;
    const completeScopeKey = row.key.startsWith(SCOPE_COMPLETE_PREFIX)
      ? row.key.slice(SCOPE_COMPLETE_PREFIX.length)
      : null;
    const scopeKey =
      attemptsScopeKey ??
      doneScopeKey ??
      fallbackScopeKey ??
      retryScopeKey ??
      climbsCheckpointScopeKey ??
      statsCheckpointScopeKey ??
      completeScopeKey;
    if (!scopeKey || !requestedScopes.has(scopeKey)) continue;

    const existing = metadataByScope.get(scopeKey) ?? {
      attempts: 0,
      isBootstrapDone: false,
      isPagedFallback: false,
      hasBoardCheckpoint: false,
      isScopeComplete: false,
      retryAfter: null,
      structuralFailures: 0,
      isTerminal: false,
    };
    if (attemptsScopeKey) existing.attempts = parseBootstrapAttempts(row.value);
    if (doneScopeKey) existing.isBootstrapDone = true;
    if (fallbackScopeKey) existing.isPagedFallback = true;
    if (retryScopeKey) {
      const retryState: BootstrapRetryState | null = parseBootstrapRetryState(row.value);
      if (retryState) {
        existing.retryAfter = retryState.retryAfter;
        existing.structuralFailures = retryState.structuralFailures;
        existing.isTerminal = isTerminal(retryState);
      }
    }
    if (climbsCheckpointScopeKey || statsCheckpointScopeKey) existing.hasBoardCheckpoint = true;
    if (completeScopeKey) existing.isScopeComplete = true;
    metadataByScope.set(scopeKey, existing);
  }

  return metadataByScope;
}

/** Counted grades-import failures for this scope (separate budget — see MAX_GRADES_BOOTSTRAP_ATTEMPTS). */
export async function getGradesBootstrapAttempts(db: SqlExecutor, scopeKey: string): Promise<number> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
    `${GRADES_BOOTSTRAP_ATTEMPTS_PREFIX}${scopeKey}`,
  ]);
  return row ? parseBootstrapAttempts(row.value) : 0;
}

export async function recordGradesBootstrapAttempt(db: SqlExecutor, scopeKey: string): Promise<number> {
  const next = (await getGradesBootstrapAttempts(db, scopeKey)) + 1;
  await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
    `${GRADES_BOOTSTRAP_ATTEMPTS_PREFIX}${scopeKey}`,
    String(next),
  ]);
  return next;
}

/** The `bootstrap-done:` value that records a heal over a partly-crawled catalog. */
const BOOTSTRAP_DONE_HEAL_VALUE = 'heal';

/**
 * Permanent "this scope was warmed from a snapshot" marker (cheap, unambiguous).
 *
 * The VALUE carries whether the import landed on a scope that had already
 * crawled rows (`healed`), because `ScopeDownloadCompleteInfo.bootstrapHealed`
 * is read at scope completion — which is routinely a LATER cycle than the
 * import, since `board_climb_grades` is not a snapshot table and still crawls to
 * its tail. An in-memory per-cycle set would report `false` for exactly the
 * population the field exists to filter out. Legacy rows hold `'1'`, which reads
 * as done-and-not-healed — correct for every scope written before this marker
 * carried a value.
 */
export async function markBootstrapDone(
  db: SqlExecutor,
  scopeKey: string,
  options?: { healed: boolean },
): Promise<void> {
  await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
    `${BOOTSTRAP_DONE_PREFIX}${scopeKey}`,
    options?.healed ? BOOTSTRAP_DONE_HEAL_VALUE : '1',
  ]);
  // Write done first: if clearing the stale outcome fails, done still outranks
  // it in derivation. The reverse order has a crash window that mislabels a
  // successfully imported snapshot as a paged fallback after restart.
  await clearBootstrapPagedFallback(db, scopeKey);
}

export async function isBootstrapDone(db: SqlExecutor, scopeKey: string): Promise<boolean> {
  const row = await db.getFirstAsync<{ key: string }>('SELECT key FROM sync_meta WHERE key = ?', [
    `${BOOTSTRAP_DONE_PREFIX}${scopeKey}`,
  ]);
  return row !== null;
}

/**
 * The artifact build stamp whose REUSED import failure already took this
 * scope's one free (uncounted) round — see the `download.reused` arm in
 * `runBootstrapPhase`.
 *
 * That arm's whole safety argument is "the file is deleted, so the next cycle
 * downloads fresh and the free round cannot repeat". Deletion is best-effort on
 * every platform (mobile's `safeDeleteFile` swallows its errors by design), and
 * a file that survives with its completeness sidecar is handed straight back as
 * `reused: true` next cycle — the same bad bytes, another free round, forever,
 * with a fresh scope skipping its paged pull each time. This marker is what
 * makes the SECOND failure on the same build spend the structural budget like
 * any other on-disk failure, so a scope can always settle. Keyed by `builtAt`:
 * tonight's rebuilt artifact is a different bet and gets its own free round.
 *
 * Package-internal, like BOOTSTRAP_DONE_PREFIX — scope-teardown.ts clears it
 * alongside the scope's other markers.
 */
export const REUSED_IMPORT_FAILED_PREFIX = 'reused-import-failed:';

/** The build stamp that already took this scope's free reused-import round, if any. */
export async function getReusedImportFailure(db: SqlExecutor, scopeKey: string): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
    `${REUSED_IMPORT_FAILED_PREFIX}${scopeKey}`,
  ]);
  return row?.value ?? null;
}

export async function recordReusedImportFailure(db: SqlExecutor, scopeKey: string, builtAt: string): Promise<void> {
  await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
    `${REUSED_IMPORT_FAILED_PREFIX}${scopeKey}`,
    builtAt,
  ]);
}

export async function clearReusedImportFailure(db: SqlExecutor, scopeKey: string): Promise<void> {
  await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [`${REUSED_IMPORT_FAILED_PREFIX}${scopeKey}`]);
}

/** Whether this scope's snapshot import was a heal over an existing partial crawl. */
export async function wasBootstrapHealed(db: SqlExecutor, scopeKey: string): Promise<boolean> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
    `${BOOTSTRAP_DONE_PREFIX}${scopeKey}`,
  ]);
  return row?.value === BOOTSTRAP_DONE_HEAL_VALUE;
}

// --- Column helpers -----------------------------------------------------------

function assertSafeColumns(columns: readonly string[]): void {
  for (const column of columns) {
    if (!SAFE_IDENTIFIER.test(column)) {
      throw new Error(`snapshot bootstrap: refusing unsafe column identifier "${column}"`);
    }
  }
}

/** Column names of a table for the given schema (`main` or the snapshot alias). */
async function tableColumns(db: SqlExecutor, tableName: string, schema: string): Promise<string[]> {
  const rows =
    schema === 'main'
      ? await db.getAllAsync<{ name: string }>('SELECT name FROM pragma_table_info(?)', [tableName])
      : await db.getAllAsync<{ name: string }>('SELECT name FROM pragma_table_info(?, ?)', [tableName, schema]);
  return rows.map((row) => row.name);
}

/**
 * The columns present in BOTH the live table and the artifact's copy of it, in
 * live (main) order. A snapshot built at a different client schema than the live
 * DB is tolerated: a column only in the artifact is dropped from the copy (its
 * data is skipped); a column only in main is left out of the SELECT and thus
 * NULL-filled. Both directions are reported as drift telemetry.
 */
async function sharedColumns(
  db: SqlExecutor,
  tableName: string,
  onSchemaDrift: SchemaDriftReporter | undefined,
  alias: string = SNAPSHOT_ALIAS,
): Promise<string[]> {
  const mainColumns = await tableColumns(db, tableName, 'main');
  const snapshotColumns = await tableColumns(db, tableName, alias);
  const mainSet = new Set(mainColumns);
  const snapshotSet = new Set(snapshotColumns);
  for (const column of snapshotColumns) {
    if (!mainSet.has(column)) onSchemaDrift?.({ tableName, column });
  }
  for (const column of mainColumns) {
    if (!snapshotSet.has(column)) onSchemaDrift?.({ tableName, column });
  }
  return mainColumns.filter((column) => snapshotSet.has(column));
}

// --- Import SQL ---------------------------------------------------------------

function checkpointLeqSql(columnPrefix: string): string {
  return `(${columnPrefix}updated_at < ? OR (${columnPrefix}updated_at = ? AND ${columnPrefix}sync_seq <= ?))`;
}

function checkpointLeqParams(checkpoint: SyncCheckpoint): (string | number)[] {
  return [checkpoint.updatedAt, checkpoint.updatedAt, checkpoint.syncSeq];
}

async function tableWatermark(
  db: SqlExecutor,
  tableName: SnapshotTableName,
  whereClause: string,
  params: (string | number)[],
): Promise<SyncCheckpoint> {
  const row = await db.getFirstAsync<{ updated_at: string; sync_seq: number | string }>(
    `SELECT updated_at, sync_seq
     FROM ${SNAPSHOT_ALIAS}.${tableName}
     WHERE ${whereClause}
     ORDER BY updated_at DESC, sync_seq DESC
     LIMIT 1`,
    params,
  );
  if (!row) return EPOCH_WATERMARK;
  return { updatedAt: String(row.updated_at), syncSeq: String(row.sync_seq) };
}

async function scopedWatermarks(
  db: SqlExecutor,
  scope: OfflineBoardScope,
): Promise<Record<SnapshotTableName, SyncCheckpoint>> {
  const climbScope = climbsScopeFilter(scope);
  const climbWatermark = await tableWatermark(db, 'board_climbs', climbScope.sql, climbScope.params);

  const sizeScoped = isSizeScopedBoard(scope.boardType);
  const innerSize = sizeScoped
    ? ' AND bc.compatible_size_ids IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(bc.compatible_size_ids) WHERE value = ?)'
    : '';
  const statsParams: (string | number)[] = [scope.boardType, scope.boardType, scope.layoutId];
  if (sizeScoped) statsParams.push(scope.sizeId);
  const statsWatermark = await tableWatermark(
    db,
    'board_climb_stats',
    `board_type = ?
       AND EXISTS (
         SELECT 1 FROM ${SNAPSHOT_ALIAS}.board_climbs bc
         WHERE bc.uuid = board_climb_stats.climb_uuid AND bc.board_type = ? AND bc.layout_id = ?${innerSize}
       )`,
    statsParams,
  );

  return { board_climbs: climbWatermark, board_climb_stats: statsWatermark };
}

async function reconcileScope(
  txn: SqlExecutor,
  scope: OfflineBoardScope,
  watermarks: Record<SnapshotTableName, SyncCheckpoint>,
): Promise<void> {
  const mainClimbScope = climbsScopeFilter(scope, 'main_climb.');
  const snapshotClimbScope = climbsScopeFilter(scope, 'snapshot_climb.');

  const sizeScoped = isSizeScopedBoard(scope.boardType);
  const localStatsSize = sizeScoped
    ? ' AND main_climb.compatible_size_ids IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(main_climb.compatible_size_ids) WHERE value = ?)'
    : '';
  const snapshotStatsSize = sizeScoped
    ? ' AND snapshot_climb.compatible_size_ids IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(snapshot_climb.compatible_size_ids) WHERE value = ?)'
    : '';

  const statsParams: (string | number)[] = [
    scope.boardType,
    ...checkpointLeqParams(watermarks.board_climb_stats),
    scope.boardType,
    scope.layoutId,
  ];
  if (sizeScoped) statsParams.push(scope.sizeId);
  statsParams.push(scope.boardType, scope.layoutId);
  if (sizeScoped) statsParams.push(scope.sizeId);

  await txn.runAsync(
    `DELETE FROM main.board_climb_stats AS main_stats
     WHERE main_stats.board_type = ?
       AND ${checkpointLeqSql('main_stats.')}
       AND EXISTS (
         SELECT 1 FROM main.board_climbs main_climb
         WHERE main_climb.uuid = main_stats.climb_uuid
           AND main_climb.board_type = ?
           AND main_climb.layout_id = ?${localStatsSize}
       )
       AND NOT EXISTS (
         SELECT 1 FROM ${SNAPSHOT_ALIAS}.board_climb_stats snapshot_stats
         WHERE snapshot_stats.board_type = main_stats.board_type
           AND snapshot_stats.climb_uuid = main_stats.climb_uuid
           AND snapshot_stats.angle = main_stats.angle
           AND EXISTS (
             SELECT 1 FROM ${SNAPSHOT_ALIAS}.board_climbs snapshot_climb
             WHERE snapshot_climb.uuid = snapshot_stats.climb_uuid
               AND snapshot_climb.board_type = ?
               AND snapshot_climb.layout_id = ?${snapshotStatsSize}
           )
       )`,
    statsParams,
  );

  await txn.runAsync(
    `DELETE FROM main.board_climbs AS main_climb
     WHERE ${mainClimbScope.sql}
       AND ${checkpointLeqSql('main_climb.')}
       AND NOT EXISTS (
         SELECT 1 FROM ${SNAPSHOT_ALIAS}.board_climbs snapshot_climb
         WHERE snapshot_climb.uuid = main_climb.uuid
           AND ${snapshotClimbScope.sql}
       )`,
    [...mainClimbScope.params, ...checkpointLeqParams(watermarks.board_climbs), ...snapshotClimbScope.params],
  );
}

/** One batch's committed progress, as the import observes it between locks. */
export type SnapshotImportBatchProgress = {
  /** Rows written so far this import, climbs + stats. */
  rowsImported: number;
  /** Exclusive transactions the row import has committed so far. */
  batches: number;
};

type SnapshotImportBatchOptions = {
  /** Rows per exclusive transaction. Defaults to SNAPSHOT_IMPORT_BATCH_ROWS. */
  batchRows: number;
  /**
   * Runs `body` inside one short `BEGIN EXCLUSIVE ... COMMIT`, re-checking the
   * purge guard after the lock is held and recording the hold.
   */
  runExclusive: (body: () => Promise<void>) => Promise<void>;
  /**
   * Fired after each batch COMMITs, with the lock RELEASED.
   *
   * A throw from here is swallowed. The consumer is the download UI's progress
   * sink, and this call now sits inside the import's own try/catch — where an
   * escaping throw would be indistinguishable from an import failure, spend a
   * lifetime structural-budget slot, and (on the retained-artifact path) delete
   * a ~103 MB file. Same discipline as `runLocalWriteWithRetry`'s `onSettled`
   * and the drainer's `onMutationStatusError`.
   */
  onBatch?: (progress: SnapshotImportBatchProgress) => void;
};

/** The keyset a stats batch resumes from, in `board_climb_stats` PK order. */
type StatsKey = { climb_uuid: string; angle: number };

/**
 * The lower bound that selects the whole partition. `climb_uuid` is TEXT NOT
 * NULL and `angle` INTEGER NOT NULL, so every real key sorts after `('', -1)`
 * — which keeps ONE statement shape (and one query plan) for the first batch and
 * every batch after it.
 */
const STATS_KEYSET_START: StatsKey = { climb_uuid: '', angle: -1 };

/**
 * The stats keyset predicate, as SQLite ROW VALUES rather than the expanded
 * `a > ? OR (a = ? AND b > ?)` form used elsewhere in this file.
 *
 * This is load-bearing, not style. `board_climb_stats`' PK is
 * `(board_type, climb_uuid, angle)`, and measured with EXPLAIN QUERY PLAN on
 * SQLite 3.53.3 against that index:
 *   OR-form:  SEARCH s USING INDEX ... (board_type=?)
 *   row-value: SEARCH s USING INDEX ... (board_type=? AND (climb_uuid,angle)>(?,?))
 * The OR-form re-scans the whole board_type partition on EVERY batch — ~142
 * passes over 306k rows for a Kilter layout — so a "batched" import written that
 * way is O(n^2) and slower than the single statement it replaces. The leading
 * `board_type = ?` equality is part of the seek and must not be dropped.
 * `snapshot-import-batching.test.ts` pins the plan string.
 */
function statsKeysetSql(withUpperBound: boolean): string {
  return (
    `s.board_type = ?
       AND (s.climb_uuid, s.angle) > (?, ?)` +
    (withUpperBound ? `\n       AND (s.climb_uuid, s.angle) <= (?, ?)` : '') +
    `
       AND EXISTS (SELECT 1 FROM temp.${IMPORT_STAGING_TABLE} t WHERE t.uuid = s.climb_uuid)`
  );
}

function statsKeysetParams(boardType: string, from: StatsKey, upper?: StatsKey): (string | number)[] {
  const params: (string | number)[] = [boardType, from.climb_uuid, from.angle];
  if (upper) params.push(upper.climb_uuid, upper.angle);
  return params;
}

/**
 * Open one short exclusive transaction, retrying a lost lock race on the ladder
 * above. A `BEGIN EXCLUSIVE` that fails leaves NO transaction open, so retrying
 * it is safe and cannot double-apply anything.
 */
async function beginExclusiveWithRetry(db: SqlExecutor, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await db.execAsync('BEGIN EXCLUSIVE');
      return;
    } catch (error) {
      if (attempt >= IMPORT_LOCK_RETRY_DELAYS_MS.length || !isDatabaseLockedError(error)) throw error;
      await sleep(IMPORT_LOCK_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/**
 * Import one scope's rows from the ATTACHed artifact, in bounded batches that
 * each hold the write lock for one `BEGIN EXCLUSIVE ... COMMIT` (issue #4310).
 * Everything that does NOT write — the column intersection, the staging table,
 * and each batch's keyset probes — runs in AUTOCOMMIT, holding nothing.
 *
 * The scope filter is unchanged, and deliberately so: `board_climbs` is filtered
 * by the resolver's scope, and `board_climb_stats` by a semi-join over exactly
 * those climbs — the same one `syncClimbStats` uses (queries.ts:426-434). What
 * changed is only WHERE that semi-join reads from: the staging table is
 * populated by `climbsScopeFilter(scope)`, the same predicate the old correlated
 * EXISTS inlined, so the two select the same rows by construction. An import
 * filter NARROWER than the resolver's scope loses rows forever (see this file's
 * header), so the equivalence is pinned by a test that runs both forms against
 * one artifact and compares the selected keys.
 */
async function importScopeBatched(
  txn: SqlExecutor,
  scope: OfflineBoardScope,
  onSchemaDrift: SchemaDriftReporter | undefined,
  options: SnapshotImportBatchOptions,
): Promise<{ climbsImported: number; statsImported: number; batches: number }> {
  const climbColumns = await sharedColumns(txn, 'board_climbs', onSchemaDrift);
  const statsColumns = await sharedColumns(txn, 'board_climb_stats', onSchemaDrift);
  assertSafeColumns(climbColumns);
  assertSafeColumns(statsColumns);
  if (climbColumns.length === 0) throw new Error('snapshot bootstrap: no shared board_climbs columns');
  if (statsColumns.length === 0) throw new Error('snapshot bootstrap: no shared board_climb_stats columns');

  // Stage the scope's climb UUIDs once, in autocommit. This pays the size-scoped
  // `json_each` membership parse ONE time instead of once per stats row, and
  // gives the climbs import a dense rowid to batch on.
  const climbScope = climbsScopeFilter(scope);
  await txn.execAsync(`DROP TABLE IF EXISTS temp.${IMPORT_STAGING_TABLE}`);
  await txn.execAsync(`CREATE TEMP TABLE ${IMPORT_STAGING_TABLE} (uuid TEXT PRIMARY KEY)`);
  await txn.runAsync(
    `INSERT OR IGNORE INTO temp.${IMPORT_STAGING_TABLE} (uuid)
     SELECT uuid FROM ${SNAPSHOT_ALIAS}.board_climbs WHERE ${climbScope.sql}`,
    climbScope.params,
  );
  const stagedRow = await txn.getFirstAsync<{ max_rowid: number }>(
    `SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM temp.${IMPORT_STAGING_TABLE}`,
  );
  const maxStagedRowid = stagedRow?.max_rowid ?? 0;

  let climbsImported = 0;
  let statsImported = 0;
  let batches = 0;

  const emitBatch = (): void => {
    if (!options.onBatch) return;
    try {
      options.onBatch({ rowsImported: climbsImported + statsImported, batches });
    } catch {
      // See SnapshotImportBatchOptions.onBatch: a broken progress consumer must
      // never be reported as a failed import.
    }
  };

  const climbTargetList = climbColumns.join(', ');
  const climbSelectList = climbColumns.map((column) => `c.${column}`).join(', ');
  for (let cursor = 0; cursor < maxStagedRowid; cursor += options.batchRows) {
    const upperRowid = Math.min(cursor + options.batchRows, maxStagedRowid);
    const lowerRowid = cursor;
    await options.runExclusive(async () => {
      const result = await txn.runAsync(
        `INSERT OR REPLACE INTO main.board_climbs (${climbTargetList})
         SELECT ${climbSelectList} FROM ${SNAPSHOT_ALIAS}.board_climbs c
         JOIN temp.${IMPORT_STAGING_TABLE} t ON t.uuid = c.uuid
         WHERE t.rowid > ? AND t.rowid <= ?`,
        [lowerRowid, upperRowid],
      );
      climbsImported += result.changes;
    });
    batches += 1;
    emitBatch();
  }

  const statsTargetList = statsColumns.join(', ');
  const statsSelectList = statsColumns.map((column) => `s.${column}`).join(', ');
  let statsCursor: StatsKey = STATS_KEYSET_START;
  for (;;) {
    // Two index seeks in autocommit, holding nothing: "is anything left?" and
    // "which key ends this batch?". The second is what bounds the transaction
    // below to `batchRows` rows without needing a COUNT over the partition.
    const probeSql = `SELECT s.climb_uuid AS climb_uuid, s.angle AS angle
       FROM ${SNAPSHOT_ALIAS}.board_climb_stats s
       WHERE ${statsKeysetSql(false)}
       ORDER BY s.climb_uuid, s.angle
       LIMIT 1 OFFSET ?`;
    const remaining = await txn.getFirstAsync<StatsKey>(probeSql, [
      ...statsKeysetParams(scope.boardType, statsCursor),
      0,
    ]);
    if (!remaining) break;
    const boundary = await txn.getFirstAsync<StatsKey>(probeSql, [
      ...statsKeysetParams(scope.boardType, statsCursor),
      options.batchRows - 1,
    ]);

    const batchFrom = statsCursor;
    await options.runExclusive(async () => {
      const result = await txn.runAsync(
        `INSERT OR REPLACE INTO main.board_climb_stats (${statsTargetList})
         SELECT ${statsSelectList} FROM ${SNAPSHOT_ALIAS}.board_climb_stats s
         WHERE ${statsKeysetSql(boundary !== null)}`,
        statsKeysetParams(scope.boardType, batchFrom, boundary ?? undefined),
      );
      statsImported += result.changes;
    });
    batches += 1;
    emitBatch();

    if (!boundary) break;
    statsCursor = boundary;
  }

  await txn.execAsync(`DROP TABLE IF EXISTS temp.${IMPORT_STAGING_TABLE}`);

  return { climbsImported, statsImported, batches };
}

// --- Verification -------------------------------------------------------------

type SnapshotMetaRow = {
  table_name: string;
  watermark_updated_at: string;
  watermark_sync_seq: string;
  row_count: number;
  built_at: string;
  schema_version: number;
  format_version: number;
};

const DELETIONS_SNAPSHOT_META_TABLE = 'sync_deletions';

type VerifiedSnapshotMeta = {
  builtAt: string;
  /**
   * Optional for backwards compatibility. Artifacts published before this
   * metadata row shipped fall back to the older scoped-row watermark rewind.
   */
  deletionsReplayFrom: SyncCheckpoint | null;
};

function normalizeSnapshotTimestamp(rawTimestamp: unknown): string | null {
  if (typeof rawTimestamp !== 'string') return null;
  const timestampMs = Date.parse(rawTimestamp);
  return Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : null;
}

/**
 * Read the optional metadata-only sync_deletions row. Any defect degrades to
 * the legacy scoped-watermark rewind instead of rejecting an otherwise valid
 * artifact: old artifacts have no row, and a boundary after artifact builtAt is
 * unsafe. This preserves the legacy scoped-watermark behaviour for already
 * published artifacts; new live gzip exports are gated on carrying this row.
 */
async function readDeletionsReplayFrom(
  db: SqlExecutor,
  alias: string,
  artifactBuiltAt: string,
): Promise<SyncCheckpoint | null> {
  const meta = await db.getFirstAsync<SnapshotMetaRow>(
    `SELECT table_name, watermark_updated_at, watermark_sync_seq, row_count, built_at, schema_version, format_version
     FROM ${alias}.snapshot_meta WHERE table_name = ?`,
    [DELETIONS_SNAPSHOT_META_TABLE],
  );
  if (!meta) return null;

  const metaBuiltAt = normalizeSnapshotTimestamp(meta.built_at);
  const replayFrom = normalizeSnapshotTimestamp(meta.watermark_updated_at);
  const replayFromMs = replayFrom ? Date.parse(replayFrom) : Number.NaN;
  const artifactBuiltAtMs = Date.parse(artifactBuiltAt);
  if (
    meta.table_name !== DELETIONS_SNAPSHOT_META_TABLE ||
    meta.format_version !== SNAPSHOT_MANIFEST_FORMAT_VERSION ||
    meta.schema_version < LATEST_SCHEMA_VERSION ||
    meta.row_count !== 0 ||
    String(meta.watermark_sync_seq) !== '0' ||
    metaBuiltAt !== artifactBuiltAt ||
    !replayFrom ||
    replayFromMs > artifactBuiltAtMs
  ) {
    return null;
  }

  return { updatedAt: replayFrom, syncSeq: '0' };
}

/**
 * Thrown when the artifact was built at an older client schema version than this
 * app runs. Importing it would NULL-fill columns the newer schema added and then
 * stamp the cursor PAST those rows — the strict-`>` delta pull would never
 * backfill them, silently degrading data a paged crawl would have delivered.
 * The caller treats this as a permanent miss for this run (no attempt burned):
 * the nightly export rebuilds artifacts at the new schema within a day, but a
 * fresh scope enabled TODAY falls back to the always-correct paged crawl.
 */
export class SnapshotSchemaStaleError extends Error {
  constructor(artifactVersion: number) {
    super(`snapshot bootstrap: artifact schema_version ${artifactVersion} < client ${LATEST_SCHEMA_VERSION}`);
    this.name = 'SnapshotSchemaStaleError';
  }
}

/**
 * Thrown when the artifact's scoped watermark sits BEHIND the checkpoint this
 * scope has already crawled to. Importing anyway would lower
 * `checkpoint:board_climbs:<scope>` — destroying exactly the crawl progress a
 * heal-over-partial exists to rescue — and rewind the single global deletions
 * cursor with it. Two reachable causes, both refused for the same reason:
 *
 *  - the artifact holds NO row matching this scope's filter, so `tableWatermark`
 *    returns the epoch (a size whose `compatible_size_ids` never matches, or any
 *    scope-filter drift between export and client), and
 *  - the local crawl already ran past the artifact's watermark.
 *
 * Nothing is written on this path: no rows, no checkpoint, no deletions rewind.
 * Reported at full severity — it means the export's scope filter and the
 * client's disagree, which is a real signal, not a flaky network.
 */
export class SnapshotWatermarkRegressionError extends Error {
  constructor(tableName: SnapshotTableName, artifact: SyncCheckpoint, local: SyncCheckpoint) {
    super(
      `snapshot bootstrap: ${tableName} artifact watermark ${artifact.updatedAt}/${artifact.syncSeq} is behind local checkpoint ${local.updatedAt}/${local.syncSeq}`,
    );
    this.name = 'SnapshotWatermarkRegressionError';
  }
}

/**
 * Read + validate the artifact's `snapshot_meta`: every snapshot table present,
 * `format_version` matching this client, `schema_version` not older than this
 * client's schema, one consistent parseable `built_at`, and each recorded
 * `row_count` equal to the artifact's ACTUAL table count (a truncated/partial
 * download is caught here before any row is imported). Artifact-level
 * watermarks are validation/export metadata; the imported scope's checkpoints
 * are computed from scoped artifact rows. A valid optional sync_deletions meta
 * row supplies the narrower replay boundary; missing/malformed rows fall back
 * to the legacy scoped-watermark rewind.
 */
async function verifySnapshotMeta(
  db: SqlExecutor,
  alias: string = SNAPSHOT_ALIAS,
  tables: readonly string[] = SNAPSHOT_TABLES,
): Promise<VerifiedSnapshotMeta> {
  let artifactBuiltAt: string | null = null;
  for (const tableName of tables) {
    const meta = await db.getFirstAsync<SnapshotMetaRow>(
      `SELECT table_name, watermark_updated_at, watermark_sync_seq, row_count, built_at, schema_version, format_version
       FROM ${alias}.snapshot_meta WHERE table_name = ?`,
      [tableName],
    );
    if (!meta) throw new Error(`snapshot bootstrap: snapshot_meta missing row for ${tableName}`);
    if (meta.format_version !== SNAPSHOT_MANIFEST_FORMAT_VERSION) {
      throw new Error(
        `snapshot bootstrap: format_version ${meta.format_version} != ${SNAPSHOT_MANIFEST_FORMAT_VERSION} for ${tableName}`,
      );
    }
    // A NEWER artifact schema is fine (extra columns are dropped by the shared-
    // column intersection); an OLDER one is not — see SnapshotSchemaStaleError.
    if (meta.schema_version < LATEST_SCHEMA_VERSION) {
      throw new SnapshotSchemaStaleError(meta.schema_version);
    }
    const rowBuiltAt = normalizeSnapshotTimestamp(meta.built_at);
    if (!rowBuiltAt) {
      throw new Error(`snapshot bootstrap: invalid snapshot_meta built_at for ${tableName}`);
    }
    if (artifactBuiltAt !== null && artifactBuiltAt !== rowBuiltAt) {
      throw new Error(`snapshot bootstrap: inconsistent snapshot_meta built_at for ${tableName}`);
    }
    artifactBuiltAt = rowBuiltAt;
    const actual = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${alias}.${tableName}`);
    const actualCount = actual?.n ?? 0;
    if (actualCount !== meta.row_count) {
      throw new Error(
        `snapshot bootstrap: ${tableName} row_count ${meta.row_count} != actual ${actualCount} (truncated artifact?)`,
      );
    }
  }

  if (!artifactBuiltAt) throw new Error('snapshot bootstrap: snapshot_meta did not contain a built_at');
  return {
    builtAt: artifactBuiltAt,
    deletionsReplayFrom: await readDeletionsReplayFrom(db, alias, artifactBuiltAt),
  };
}

// --- Bootstrap ----------------------------------------------------------------

function defaultImportSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Warm one board scope from a downloaded artifact. ATTACHes the file, integrity-
 * checks it, verifies the meta, then imports the scoped climbs + stats,
 * reconciles stale scoped rows absent from the artifact, and stamps both resume
 * checkpoints at the scoped imported-row watermarks.
 *
 * NO LONGER ONE TRANSACTION (issue #4310). It is: an autocommit preamble
 * (COMMIT the wrapper's empty transaction, ATTACH, quick_check, meta verify,
 * scoped watermarks, regression guard, staging table), then a reconcile
 * transaction, then ceil(rows / SNAPSHOT_IMPORT_BATCH_ROWS) row transactions,
 * then a final transaction holding both checkpoints and the deletions rewind.
 * The lock is released between every one of them.
 *
 * WHAT REPLACES ALL-OR-NOTHING. A wipe or a crash mid-import can now leave rows
 * committed. It can NEVER leave a checkpoint: the two `setCheckpoint` calls and
 * `rewindDeletionsCheckpoint` live only in the final transaction, after every
 * row batch has committed. That asymmetry is the one scope-teardown.ts's header
 * is written around — rows without markers is benign (the next bootstrap
 * re-imports over them, `INSERT OR REPLACE` is idempotent, and a teardown still
 * removes them), markers without rows is unrecoverable, because the strict `>`
 * delta pull never revisits anything at or below a stamped cursor. So the wipe
 * contract is now "possibly some rows, never a checkpoint" rather than "no rows,
 * no checkpoints", and `SnapshotWipedError` still means nothing was stamped.
 *
 * CONNECTION INVARIANT (BOARDSESH-AA): expo-sqlite's
 * `withExclusiveTransactionAsync` runs its task on a NEW native connection
 * (`useNewConnection: true`), and SQLite ATTACHes are per-connection — an
 * ATTACH issued on the main connection does not exist inside the task. So
 * EVERYTHING that touches the snapshot alias (attach, quick_check, meta
 * verification, watermarks, reconcile, import) runs inside the task, on the
 * transaction's own connection. SQLite forbids ATTACH inside a transaction and
 * the expo wrapper opens a deferred BEGIN before the task runs, so the task
 * first COMMITs that empty transaction, attaches in autocommit mode, then opens
 * the real `BEGIN EXCLUSIVE`s in autocommit mode. Each of those is COMMITted
 * here rather than by the wrapper — including the last one, which is why the
 * task hands the wrapper a fresh empty `BEGIN` to close: it keeps every
 * exclusive hold measurable end to end, and keeps the wrapper's unconditional
 * ROLLBACK from meeting a connection with no transaction at all. The wrapper
 * tears the connection down afterwards, which implicitly detaches the artifact
 * (and drops the staging table) on every path.
 */
export async function bootstrapScopeFromSnapshot(params: {
  db: OfflineDatabase;
  scope: OfflineBoardScope;
  scopeKey: string;
  filePath: string;
  onSchemaDrift?: SchemaDriftReporter;
  /**
   * The scope's CURRENT board-table checkpoints, when it already has any (the
   * heal-over-partial path — the caller read them for its eligibility check).
   * Supplying them arms the watermark-regression guard; omitting them is the
   * fresh-scope case, where there is no progress to protect.
   */
  existingCheckpoints?: Partial<Record<SnapshotTableName, SyncCheckpoint>>;
  /**
   * Fired after each row batch COMMITs, with the lock released — what the
   * download UI's `import` stage now draws a real progress bar from instead of
   * the indeterminate spinner it showed while one transaction ran. A throw from
   * this callback is swallowed; see SnapshotImportBatchOptions.onBatch.
   */
  onBatch?: (progress: SnapshotImportBatchProgress) => void;
  /** Rows per exclusive transaction. Defaults to SNAPSHOT_IMPORT_BATCH_ROWS. */
  batchRows?: number;
  /**
   * Sleep seam for the lost-lock ladder, so tests need no real timers — the same
   * injection `runLocalWriteWithRetry` takes. Defaults to a real setTimeout.
   */
  sleep?: (ms: number) => Promise<void>;
}): Promise<SnapshotBootstrapResult> {
  const {
    db,
    scope,
    scopeKey,
    filePath,
    onSchemaDrift,
    existingCheckpoints,
    onBatch,
    batchRows = SNAPSHOT_IMPORT_BATCH_ROWS,
    sleep = defaultImportSleep,
  } = params;

  // The whole import + checkpoint stamping is all-or-nothing. A wipe that runs
  // (or starts AND finishes) across ANY await below — including the ATTACH,
  // quick_check, and snapshot_meta reads — would otherwise resurrect the
  // artifact's rows into a wiped DB and write checkpoints past the next
  // account's data. Capture the token before the FIRST await so even a wipe
  // cycle that completes during the integrity checks is caught.
  //
  // SCOPED (issue #4370): this transaction writes only rows filtered through
  // climbsScopeFilter(scope), this scope's two checkpoints, and a deletions
  // rewind that moves the global cursor BACKWARDS (replaying more tombstones is
  // always safe under any purge). Only a purge covering this scope's layout can
  // invalidate any of it.
  const startToken = capturePurgeToken();
  const purgeKey = purgeNamespaceKey(scope);

  let watermarks: Record<SnapshotTableName, SyncCheckpoint> | null = null;
  let deletionsReplayFrom: SyncCheckpoint | null = null;
  let imported = { climbsImported: 0, statsImported: 0, batches: 0 };
  let importVerifyMs = 0;
  let importReconcileMs = 0;
  let importRowsMs = 0;
  let importLockMaxMs = 0;
  let importLockWaitMs = 0;
  try {
    await db.withExclusiveTransactionAsync(async (txn) => {
      // Close the wrapper's (empty, deferred) transaction so ATTACH is legal,
      // then re-open below. Every throw in this autocommit window must restore
      // an open transaction first — the wrapper's unconditional ROLLBACK would
      // otherwise itself fail and mask the real error (which the caller
      // dispatches on, e.g. SnapshotSchemaStaleError vs a counted failure).
      await txn.execAsync('COMMIT');
      // Everything from here to the first BEGIN EXCLUSIVE runs in AUTOCOMMIT,
      // holding no lock: the ATTACH, quick_check over the whole artifact, the
      // two COUNT(*) truncation checks in verifySnapshotMeta, and the scoped
      // watermark reads. That is the bulk of what `importMs` has always
      // measured, and none of it is a lock hold — hence its own number.
      const verifyStartedAt = Date.now();
      try {
        await txn.execAsync(`ATTACH DATABASE '${filePath.replace(/'/g, "''")}' AS ${SNAPSHOT_ALIAS}`);

        const integrity = await txn.getAllAsync<{ quick_check: string }>(`PRAGMA ${SNAPSHOT_ALIAS}.quick_check`);
        if (integrity.length !== 1 || integrity[0].quick_check !== 'ok') {
          throw new Error(
            `snapshot bootstrap: quick_check failed: ${integrity.map((row) => row.quick_check).join('; ')}`,
          );
        }

        const snapshotMeta = await verifySnapshotMeta(txn);
        deletionsReplayFrom = snapshotMeta.deletionsReplayFrom;
        watermarks = await scopedWatermarks(txn, scope);

        // Refuse BEFORE the exclusive transaction opens, so a regression writes
        // nothing at all — see SnapshotWatermarkRegressionError.
        if (existingCheckpoints) {
          for (const tableName of SNAPSHOT_TABLES) {
            const localCheckpoint = existingCheckpoints[tableName];
            if (!localCheckpoint) continue;
            if (compareCheckpoints(watermarks[tableName], localCheckpoint) < 0) {
              throw new SnapshotWatermarkRegressionError(tableName, watermarks[tableName], localCheckpoint);
            }
          }
        }

        if (isSigningOut() || hasPurgeLanded(startToken, purgeKey)) throw new SnapshotWipedError();

        // The import can take seconds on a big layout; don't let a concurrent
        // write on the app's main connection fail it with SQLITE_BUSY.
        await applyBusyTimeout(txn);
        // Autocommit-only, and it must run before the first BEGIN EXCLUSIVE:
        // SQLite rejects the pragma inside a transaction. Without it the ~142
        // commits below would each pay an fsync and batching would be a
        // regression rather than a fix. See applyBulkImportPragmas.
        await applyBulkImportPragmas(txn);
        importVerifyMs = Date.now() - verifyStartedAt;
      } catch (preTransactionError) {
        await txn.execAsync('BEGIN').catch(() => {});
        throw preTransactionError;
      }

      // From here the task drives its OWN transactions. Every throw must still
      // leave the wrapper something to ROLLBACK: an open batch transaction if
      // the throw happened inside one, or a fresh empty BEGIN if it happened
      // between two. Otherwise expo's unconditional ROLLBACK throws "cannot
      // rollback - no transaction is active" and MASKS the real error, which
      // the caller dispatches on (SnapshotSchemaStaleError vs SnapshotWipedError
      // vs a counted failure). The `.catch` covers the already-open case.
      try {
        const stampedWatermarks: Record<SnapshotTableName, SyncCheckpoint> = watermarks;

        /** One short exclusive transaction: take the lock, re-check, write, let go. */
        const runExclusive = async (body: () => Promise<void>): Promise<void> => {
          // Acquisition is measured separately from the hold, and the phase
          // stamps below subtract it. `busy_timeout` blocking plus the ladder's
          // sleeps can run to seconds behind a `removeBoardScopeData`, and
          // charging that to "reconcile" or "rows" would repeat, one level down,
          // exactly the elapsed-vs-hold conflation this split exists to undo.
          const acquireFrom = Date.now();
          await beginExclusiveWithRetry(txn, sleep);
          const heldFrom = Date.now();
          importLockWaitMs += heldFrom - acquireFrom;
          try {
            // INSIDE the lock, deliberately. A purge that wins the lock between
            // two batches deletes this scope's rows; a batch that then re-ran
            // its INSERT would resurrect a removed board's catalog, which the
            // old single transaction prevented structurally. `beginScopePurge`
            // latches BEFORE its delete transaction takes the lock, so the two
            // possible orderings are: this batch wins the lock and commits, and
            // the purge's own DELETE then removes what it wrote; or the purge
            // wins, and this read sees the latch and bails. Both are consistent.
            if (isSigningOut() || hasPurgeLanded(startToken, purgeKey)) throw new SnapshotWipedError();
            await body();
            await txn.execAsync('COMMIT');
          } finally {
            // Measured to the throw, not to the wrapper's later ROLLBACK, on a
            // failing batch. `importLockMaxMs` answers "what is the worst hold a
            // concurrent write had to survive" on the path that COMMITs; a batch
            // that threw is a failed import the caller settles, and the ROLLBACK
            // that follows is teardown rather than work this metric is sizing.
            const heldMs = Date.now() - heldFrom;
            if (heldMs > importLockMaxMs) importLockMaxMs = heldMs;
          }
        };

        // Reconcile FIRST and in its own transaction, keeping today's
        // delete-then-insert order. Still unbatched: two DELETEs with nested
        // correlated EXISTS/NOT EXISTS. Cheap on a fresh scope (nothing local to
        // delete), NOT bounded on a heal-over-partial (#4313) or a second size
        // of an already-downloaded layout — which is why it is measured
        // separately and counted into importLockMaxMs rather than hidden.
        // `importReconcileMs` is work-plus-hold: the lock-acquisition wait is
        // subtracted, so the follow-up trigger for batching this reads reconcile
        // cost rather than whoever else held the lock.
        const reconcileStartedAt = Date.now();
        const waitBeforeReconcile = importLockWaitMs;
        await runExclusive(async () => {
          await reconcileScope(txn, scope, stampedWatermarks);
        });
        importReconcileMs = Date.now() - reconcileStartedAt - (importLockWaitMs - waitBeforeReconcile);

        const rowsStartedAt = Date.now();
        const waitBeforeRows = importLockWaitMs;
        imported = await importScopeBatched(txn, scope, onSchemaDrift, { batchRows, runExclusive, onBatch });
        importRowsMs = Date.now() - rowsStartedAt - (importLockWaitMs - waitBeforeRows);

        // CHECKPOINTS LAST, in their own transaction, after every row batch has
        // committed. This is the invariant that makes partial rows survivable:
        // rows without markers re-import idempotently, markers without rows are
        // unrecoverable (see this function's docblock and scope-teardown.ts).
        await runExclusive(async () => {
          await setCheckpoint(txn, getCheckpointKey('board_climbs', scopeKey), stampedWatermarks.board_climbs);
          await setCheckpoint(
            txn,
            getCheckpointKey('board_climb_stats', scopeKey),
            stampedWatermarks.board_climb_stats,
          );

          // Rewind the global deletions cursor IN THE SAME transaction as the
          // checkpoints: once the board checkpoints exist this scope is never
          // bootstrap-eligible again, so a crash between them and a separate
          // rewind would leave board-row deletions in `(replay boundary,
          // deletions-head]` permanently unreplayed against the imported rows.
          //
          // New artifacts carry a metadata-only sync_deletions row whose
          // timestamp is the oldest of run builtAt, the export transaction's
          // stability boundary, and every visible same-role active transaction
          // start. That covers a long DELETE transaction which was invisible to
          // the artifact's REPEATABLE READ snapshot but later commits with an
          // older deleted_at. Old/malformed artifacts retain the pre-existing
          // min(scoped watermarks) compatibility path. New live gzip exports
          // refuse publication without the stronger boundary above.
          const minWatermark =
            compareCheckpoints(stampedWatermarks.board_climbs, stampedWatermarks.board_climb_stats) <= 0
              ? stampedWatermarks.board_climbs
              : stampedWatermarks.board_climb_stats;
          await rewindDeletionsCheckpoint(txn, deletionsReplayFrom ?? minWatermark);
        });

        // Hand the wrapper an empty transaction to close. Committing the final
        // one here rather than leaving it open is what keeps every exclusive
        // hold measured end to end, COMMIT included.
        await txn.execAsync('BEGIN');
      } catch (importError) {
        await txn.execAsync('BEGIN').catch(() => {});
        throw importError;
      }
    });
  } finally {
    // On expo the wrapper's connection teardown already detached; this covers
    // same-connection OfflineDatabase implementations (the node test double's
    // in-memory mode), where the alias would otherwise leak across scopes.
    await db.execAsync(`DETACH DATABASE ${SNAPSHOT_ALIAS}`).catch(() => {});
  }

  // Unreachable null: the transaction either set watermarks or threw.
  if (!watermarks) throw new Error('snapshot bootstrap: transaction completed without watermarks');
  const finalWatermarks: Record<SnapshotTableName, SyncCheckpoint> = watermarks;
  return {
    climbsWatermark: finalWatermarks.board_climbs,
    statsWatermark: finalWatermarks.board_climb_stats,
    climbsImported: imported.climbsImported,
    statsImported: imported.statsImported,
    importBatches: imported.batches,
    importVerifyMs,
    importReconcileMs,
    importRowsMs,
    importLockMaxMs,
    importLockWaitMs,
  };
}

// --- Grades bootstrap (issue #4310) -------------------------------------------

const GRADES_TABLE = 'board_climb_grades';
const GRADES_CURSOR_COLUMN = TABLE_CONFIGS[GRADES_TABLE].cursorColumn;

/**
 * The scope filter for `board_climb_grades`, evaluated against the layout's
 * climbs. Grades carry no `layout_id`, so this is the same correlated EXISTS
 * over `board_climbs` that `syncClimbGrades` uses (queries.ts) — and it MUST
 * NOT be narrower: a grade row inside the stamped watermark that this import
 * dropped is lost forever, because the strict `>` delta never revisits it.
 *
 * `climbsSchema` is `main` for both the import and the watermark (the climbs
 * this scope just committed); the watermark additionally reads its ROWS from
 * the attached artifact, not from main, so what gets stamped can only cover
 * what this import actually selected — see the comment at the watermark query.
 */
function gradesScopeFilter(
  scope: OfflineBoardScope,
  gradesTableRef: string,
  climbsSchema: string,
): { sql: string; params: (string | number)[] } {
  const sizeScoped = isSizeScopedBoard(scope.boardType);
  const innerSize = sizeScoped
    ? ' AND bc.compatible_size_ids IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(bc.compatible_size_ids) WHERE value = ?)'
    : '';
  const params: (string | number)[] = [scope.boardType, scope.boardType, scope.layoutId];
  if (sizeScoped) params.push(scope.sizeId);
  return {
    sql: `${gradesTableRef}.board_type = ?
       AND EXISTS (
         SELECT 1 FROM ${climbsSchema}.board_climbs bc
         WHERE bc.uuid = ${gradesTableRef}.climb_uuid AND bc.board_type = ? AND bc.layout_id = ?${innerSize}
       )`,
    params,
  };
}

/**
 * Warm one scope's `board_climb_grades` rows from the layout's separate grades
 * artifact, and stamp the grades resume checkpoint at the imported rows'
 * watermark — replacing hundreds of serial authenticated GraphQL pages with one
 * file and one transaction.
 *
 * DELIBERATELY ITS OWN EXCLUSIVE TRANSACTION, not merged into
 * `bootstrapScopeFromSnapshot`'s. Merging would close a crash window but
 * lengthen a single `BEGIN EXCLUSIVE` hold on a database the app is also
 * reading (issue #4314). Splitting keeps each hold short, and the worst case is
 * exactly today's behaviour: if this fails, or the app dies between the two
 * transactions, no grades checkpoint is stamped and the scope crawls grades as
 * it always did. No data is at risk either way, so the shorter lock wins.
 *
 * No reconcile: `board_climb_grades` has no delete trigger at all (see
 * deletions-coverage.ts), so there is no tombstone stream to reconcile against
 * and `INSERT OR REPLACE` is the whole import. `rewindDeletionsCheckpoint` is
 * likewise untouched — it stays min(climbs, stats) on purpose.
 *
 * Same per-connection ATTACH invariant as `bootstrapScopeFromSnapshot`
 * (BOARDSESH-AA): everything touching the alias runs inside the transaction
 * task, on the transaction's own connection.
 */
export async function bootstrapScopeGradesFromSnapshot(params: {
  db: OfflineDatabase;
  scope: OfflineBoardScope;
  scopeKey: string;
  filePath: string;
  onSchemaDrift?: SchemaDriftReporter;
  /** Sleep seam for the lost-lock ladder. Defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}): Promise<{
  gradesWatermark: SyncCheckpoint;
  rowsImported: number;
  /**
   * ATTACH + quick_check + meta verify, all in AUTOCOMMIT holding nothing, and
   * the exclusive hold that follows it — split for the same reason the
   * whole-layout import splits `importVerifyMs` from `importLockMaxMs` (issue
   * #4310). This transaction is still UNBATCHED: one `INSERT OR REPLACE ...
   * SELECT` over the layout's grades with a correlated EXISTS and a per-row
   * `json_each`, plus a second descending scan for the watermark. Its docblock
   * asserts the hold is short; `gradesLockMs` is what turns that into a
   * measurement, and batching it is a follow-up only if the number says so.
   */
  gradesVerifyMs: number;
  gradesLockMs: number;
}> {
  const { db, scope, scopeKey, filePath, onSchemaDrift, sleep = defaultImportSleep } = params;
  // Same scoping argument as bootstrapScopeFromSnapshot: the INSERT is filtered
  // through gradesScopeFilter(scope) and the only checkpoint stamped is this
  // scope's grades cursor.
  const startToken = capturePurgeToken();
  const purgeKey = purgeNamespaceKey(scope);

  let watermark: SyncCheckpoint | null = null;
  let rowsImported = 0;
  let gradesVerifyMs = 0;
  let gradesLockMs = 0;
  try {
    await db.withExclusiveTransactionAsync(async (txn) => {
      await txn.execAsync('COMMIT');
      const verifyStartedAt = Date.now();
      try {
        await txn.execAsync(`ATTACH DATABASE '${filePath.replace(/'/g, "''")}' AS ${GRADES_ALIAS}`);

        const integrity = await txn.getAllAsync<{ quick_check: string }>(`PRAGMA ${GRADES_ALIAS}.quick_check`);
        if (integrity.length !== 1 || integrity[0].quick_check !== 'ok') {
          throw new Error(
            `snapshot grades bootstrap: quick_check failed: ${integrity.map((row) => row.quick_check).join('; ')}`,
          );
        }

        // Verified against the ONE-ELEMENT grades list. The client's
        // whole-layout SNAPSHOT_TABLES is untouched, which is what keeps this
        // change invisible to every pre-change artifact still on the CDN.
        await verifySnapshotMeta(txn, GRADES_ALIAS, GRADES_SNAPSHOT_TABLES);

        if (isSigningOut() || hasPurgeLanded(startToken, purgeKey)) throw new SnapshotWipedError();

        await applyBusyTimeout(txn);
        // Deliberately NOT applyBulkImportPragmas: that exists to stop ~142 batch
        // commits each paying an fsync, and this is ONE transaction, so a single
        // durable commit is the cheaper end of the trade. If `gradesLockMs` says
        // this needs batching too, the pragma comes with it.
        gradesVerifyMs = Date.now() - verifyStartedAt;
        await beginExclusiveWithRetry(txn, sleep);
      } catch (preTransactionError) {
        await txn.execAsync('BEGIN').catch(() => {});
        throw preTransactionError;
      }

      // Same restore-BEGIN discipline as bootstrapScopeFromSnapshot's row loop,
      // and needed for the same reason: this function now COMMITs its own
      // transaction (so `gradesLockMs` covers the COMMIT) and hands the wrapper a
      // fresh empty one. That opens a window the pre-#4310 shape did not have —
      // a throw from the trailing `BEGIN` would meet expo's unconditional
      // ROLLBACK with no transaction active, and "cannot rollback - no
      // transaction is active" would MASK the real error the caller dispatches
      // on (SnapshotWipedError vs a counted grades failure). The `.catch` covers
      // the case where the throw happened while the exclusive transaction was
      // still open.
      try {
        const lockHeldFrom = Date.now();
        const gradeColumns = await sharedColumns(txn, GRADES_TABLE, onSchemaDrift, GRADES_ALIAS);
        assertSafeColumns(gradeColumns);
        if (gradeColumns.length === 0)
          throw new Error('snapshot grades bootstrap: no shared board_climb_grades columns');
        const columnList = gradeColumns.join(', ');

        const importFilter = gradesScopeFilter(scope, 'g', 'main');
        const inserted = await txn.runAsync(
          `INSERT OR REPLACE INTO main.${GRADES_TABLE} (${columnList})
         SELECT ${columnList} FROM ${GRADES_ALIAS}.${GRADES_TABLE} g
         WHERE ${importFilter.sql}`,
          importFilter.params,
        );
        rowsImported = inserted.changes;

        // Stamp at the watermark of the rows the INSERT above actually selected:
        // the ARTIFACT's rows, under the same scope filter (mirroring
        // scopedWatermarks' artifact-side reads for climbs/stats). Two wrong
        // alternatives, both a permanent silent gap because the strict `>` delta
        // never revisits anything at-or-below the stamp:
        //  - the artifact's snapshot_meta watermark could stamp past a row the
        //    scope filter excluded (its climb outside this scope);
        //  - main.board_climb_grades could stamp past rows this scope NEVER
        //    received — the table is shared across scopes, so a sibling scope's
        //    earlier crawl (e.g. kilter:1:7 synced for months when kilter:1:10 is
        //    added) leaves rows for shared climbs with cursors far beyond this
        //    artifact, and stamping there skips every grade row computed since
        //    the artifact was built for climbs exclusive to THIS scope.
        const watermarkRow = await txn.getFirstAsync<{ cursor_at: string; sync_seq: number | string }>(
          `SELECT ${GRADES_CURSOR_COLUMN} AS cursor_at, sync_seq
         FROM ${GRADES_ALIAS}.${GRADES_TABLE} g
         WHERE ${importFilter.sql}
         ORDER BY ${GRADES_CURSOR_COLUMN} DESC, sync_seq DESC
         LIMIT 1`,
          importFilter.params,
        );
        watermark = watermarkRow
          ? { updatedAt: String(watermarkRow.cursor_at), syncSeq: String(watermarkRow.sync_seq) }
          : EPOCH_WATERMARK;

        if (isSigningOut() || hasPurgeLanded(startToken, purgeKey)) throw new SnapshotWipedError();

        await setCheckpoint(txn, getCheckpointKey(GRADES_TABLE, scopeKey), watermark);
        // COMMIT here rather than leaving it for the wrapper, so gradesLockMs
        // covers the whole hold, then hand the wrapper an empty transaction.
        await txn.execAsync('COMMIT');
        gradesLockMs = Date.now() - lockHeldFrom;
        await txn.execAsync('BEGIN');
      } catch (gradesImportError) {
        await txn.execAsync('BEGIN').catch(() => {});
        throw gradesImportError;
      }
    });
  } finally {
    await db.execAsync(`DETACH DATABASE ${GRADES_ALIAS}`).catch(() => {});
  }

  if (!watermark) throw new Error('snapshot grades bootstrap: transaction completed without a watermark');
  return { gradesWatermark: watermark, rowsImported, gradesVerifyMs, gradesLockMs };
}
