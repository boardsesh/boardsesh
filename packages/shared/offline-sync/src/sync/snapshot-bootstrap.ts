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
import { applyBusyTimeout } from '../db/pragmas';
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
// The names come from PRAGMA table_info over our own DDL (trusted), but validating
// keeps the string-built SQL provably injection-free — same guard the export uses.
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
   * transport/network error, which the engine counts as a bootstrap attempt so it
   * retries next cycle. (`unknown` already admits `null`; the return is `unknown`
   * rather than `unknown | null` only because the linter forbids that redundancy.)
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
  stage: 'manifest' | 'download' | 'import' | 'grades-download' | 'grades-import';
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

/**
 * Import one scope's rows from the ATTACHed artifact. Called INSIDE the exclusive
 * transaction. board_climbs is filtered by the resolver's scope; board_climb_stats
 * is scoped by a correlated EXISTS over the artifact's board_climbs — the same
 * semi-join `syncClimbStats` uses (queries.ts:426-434) — so stats land iff their
 * climb is in scope.
 */
async function importScope(
  txn: SqlExecutor,
  scope: OfflineBoardScope,
  onSchemaDrift: SchemaDriftReporter | undefined,
): Promise<{ climbsImported: number; statsImported: number }> {
  const climbColumns = await sharedColumns(txn, 'board_climbs', onSchemaDrift);
  const statsColumns = await sharedColumns(txn, 'board_climb_stats', onSchemaDrift);
  assertSafeColumns(climbColumns);
  assertSafeColumns(statsColumns);
  if (climbColumns.length === 0) throw new Error('snapshot bootstrap: no shared board_climbs columns');
  if (statsColumns.length === 0) throw new Error('snapshot bootstrap: no shared board_climb_stats columns');

  const climbScope = climbsScopeFilter(scope);
  const climbList = climbColumns.join(', ');
  const climbsResult = await txn.runAsync(
    `INSERT OR REPLACE INTO main.board_climbs (${climbList})
     SELECT ${climbList} FROM ${SNAPSHOT_ALIAS}.board_climbs WHERE ${climbScope.sql}`,
    climbScope.params,
  );

  // Stats semi-join: mirror the resolver's EXISTS over board_climbs, filtered by
  // the SAME scope conditions (board_type + layout + size). The inner size check
  // reuses the climbs filter but qualified to the correlated `bc` alias.
  const statsList = statsColumns.join(', ');
  const sizeScoped = isSizeScopedBoard(scope.boardType);
  const innerSize = sizeScoped
    ? ' AND bc.compatible_size_ids IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(bc.compatible_size_ids) WHERE value = ?)'
    : '';
  const statsParams: (string | number)[] = [scope.boardType, scope.boardType, scope.layoutId];
  if (sizeScoped) statsParams.push(scope.sizeId);
  const statsResult = await txn.runAsync(
    `INSERT OR REPLACE INTO main.board_climb_stats (${statsList})
     SELECT ${statsList} FROM ${SNAPSHOT_ALIAS}.board_climb_stats s
     WHERE s.board_type = ?
       AND EXISTS (
         SELECT 1 FROM ${SNAPSHOT_ALIAS}.board_climbs bc
         WHERE bc.uuid = s.climb_uuid AND bc.board_type = ? AND bc.layout_id = ?${innerSize}
       )`,
    statsParams,
  );

  return { climbsImported: climbsResult.changes, statsImported: statsResult.changes };
}

// --- Verification -------------------------------------------------------------

type SnapshotMetaRow = {
  table_name: string;
  watermark_updated_at: string;
  watermark_sync_seq: string;
  row_count: number;
  schema_version: number;
  format_version: number;
};

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
 * client's schema, and each recorded `row_count` equal to the artifact's ACTUAL
 * table count (a truncated/partial download is caught here before any row is
 * imported). Artifact-level watermarks are validation/export metadata; the
 * imported scope's checkpoints are computed from scoped artifact rows.
 */
async function verifySnapshotMeta(
  db: SqlExecutor,
  alias: string = SNAPSHOT_ALIAS,
  tables: readonly string[] = SNAPSHOT_TABLES,
): Promise<void> {
  for (const tableName of tables) {
    const meta = await db.getFirstAsync<SnapshotMetaRow>(
      `SELECT table_name, watermark_updated_at, watermark_sync_seq, row_count, schema_version, format_version
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
    const actual = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${alias}.${tableName}`);
    const actualCount = actual?.n ?? 0;
    if (actualCount !== meta.row_count) {
      throw new Error(
        `snapshot bootstrap: ${tableName} row_count ${meta.row_count} != actual ${actualCount} (truncated artifact?)`,
      );
    }
  }
}

// --- Bootstrap ----------------------------------------------------------------

/**
 * Warm one board scope from a downloaded artifact. ATTACHes the file, integrity-
 * checks it, verifies the meta, then in ONE exclusive transaction imports the
 * scoped climbs + stats, reconciles stale scoped rows absent from the artifact,
 * and stamps both resume checkpoints at the scoped imported-row watermarks.
 * A wipe that starts (or completes) mid-import rolls the transaction back and
 * throws SnapshotWipedError — no rows, no checkpoints.
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
 * the real `BEGIN EXCLUSIVE` — which the wrapper's trailing COMMIT/ROLLBACK
 * closes. The wrapper tears the connection down afterwards, which implicitly
 * detaches the artifact on every path (success, import failure, or wipe).
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
}): Promise<SnapshotBootstrapResult> {
  const { db, scope, scopeKey, filePath, onSchemaDrift, existingCheckpoints } = params;

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
  let imported = { climbsImported: 0, statsImported: 0 };
  try {
    await db.withExclusiveTransactionAsync(async (txn) => {
      // Close the wrapper's (empty, deferred) transaction so ATTACH is legal,
      // then re-open below. Every throw in this autocommit window must restore
      // an open transaction first — the wrapper's unconditional ROLLBACK would
      // otherwise itself fail and mask the real error (which the caller
      // dispatches on, e.g. SnapshotSchemaStaleError vs a counted failure).
      await txn.execAsync('COMMIT');
      try {
        await txn.execAsync(`ATTACH DATABASE '${filePath.replace(/'/g, "''")}' AS ${SNAPSHOT_ALIAS}`);

        const integrity = await txn.getAllAsync<{ quick_check: string }>(`PRAGMA ${SNAPSHOT_ALIAS}.quick_check`);
        if (integrity.length !== 1 || integrity[0].quick_check !== 'ok') {
          throw new Error(
            `snapshot bootstrap: quick_check failed: ${integrity.map((row) => row.quick_check).join('; ')}`,
          );
        }

        await verifySnapshotMeta(txn);
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
        await txn.execAsync('BEGIN EXCLUSIVE');
      } catch (preTransactionError) {
        await txn.execAsync('BEGIN').catch(() => {});
        throw preTransactionError;
      }

      await reconcileScope(txn, scope, watermarks);
      imported = await importScope(txn, scope, onSchemaDrift);

      // Re-check after the (awaited) imports: abort before committing any rows or
      // checkpoints if a wipe landed while they ran.
      if (isSigningOut() || hasPurgeLanded(startToken, purgeKey)) throw new SnapshotWipedError();

      await setCheckpoint(txn, getCheckpointKey('board_climbs', scopeKey), watermarks.board_climbs);
      await setCheckpoint(txn, getCheckpointKey('board_climb_stats', scopeKey), watermarks.board_climb_stats);

      // Rewind the global deletions cursor to the OLDER of the two table
      // watermarks IN THE SAME transaction as the import: once the board
      // checkpoints exist this scope is never bootstrap-eligible again, so a
      // crash between the import commit and a separate rewind would leave
      // board-row deletions in `(watermark, deletions-head]` permanently
      // unreplayed against the imported rows.
      const minWatermark =
        compareCheckpoints(watermarks.board_climbs, watermarks.board_climb_stats) <= 0
          ? watermarks.board_climbs
          : watermarks.board_climb_stats;
      await rewindDeletionsCheckpoint(txn, minWatermark);
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
    ...imported,
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
}): Promise<{ gradesWatermark: SyncCheckpoint; rowsImported: number }> {
  const { db, scope, scopeKey, filePath, onSchemaDrift } = params;
  // Same scoping argument as bootstrapScopeFromSnapshot: the INSERT is filtered
  // through gradesScopeFilter(scope) and the only checkpoint stamped is this
  // scope's grades cursor.
  const startToken = capturePurgeToken();
  const purgeKey = purgeNamespaceKey(scope);

  let watermark: SyncCheckpoint | null = null;
  let rowsImported = 0;
  try {
    await db.withExclusiveTransactionAsync(async (txn) => {
      await txn.execAsync('COMMIT');
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
        await txn.execAsync('BEGIN EXCLUSIVE');
      } catch (preTransactionError) {
        await txn.execAsync('BEGIN').catch(() => {});
        throw preTransactionError;
      }

      const gradeColumns = await sharedColumns(txn, GRADES_TABLE, onSchemaDrift, GRADES_ALIAS);
      assertSafeColumns(gradeColumns);
      if (gradeColumns.length === 0) throw new Error('snapshot grades bootstrap: no shared board_climb_grades columns');
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
    });
  } finally {
    await db.execAsync(`DETACH DATABASE ${GRADES_ALIAS}`).catch(() => {});
  }

  if (!watermark) throw new Error('snapshot grades bootstrap: transaction completed without a watermark');
  return { gradesWatermark: watermark, rowsImported };
}
