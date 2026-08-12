import type { OfflineDatabase, QueryInvalidator, SqlValue } from '../database';
import type { SyncCursorInput, SyncResult, SyncDeletionsResult } from '../types';
import { TABLE_CONFIGS, USER_DATA_TABLES, BOARD_DATA_TABLES } from './table-config';
import {
  getCheckpoint,
  setCheckpoint,
  getCheckpointKey,
  markScopeDownloadComplete,
  isScopeDownloadComplete,
  markScopeDownloadStarted,
  isScopeDownloadStarted,
  DELETIONS_CHECKPOINT_KEY,
} from './checkpoints';
import { markUserDataComplete } from './local-user-owner';
import {
  bootstrapScopeFromSnapshot,
  markBootstrapDone,
  isBootstrapDone,
  wasBootstrapHealed,
  SnapshotWipedError,
  SnapshotSchemaStaleError,
  SnapshotPermanentMissError,
  type SnapshotSource,
  type SnapshotBootstrapErrorReporter,
} from './snapshot-bootstrap';
import {
  classifyBootstrapFailure,
  clearBootstrapPagedFallback,
  clearTransportFailures,
  deferHeal,
  evaluateBootstrapEligibility,
  isTerminal,
  markBootstrapPagedFallback,
  nextRetryState,
  readBootstrapRetryState,
  rearmForNewArtifact,
  shouldSkipPagedPull,
  spendUserRequest,
  writeBootstrapRetryState,
  type BootstrapFailureKind,
  type BootstrapRetryState,
} from './bootstrap-retry';
import { parseSnapshotManifest, type SnapshotManifest } from './snapshot-manifest';
import { findSnapshotEntry, isSnapshotEntryUsable } from './snapshot-estimate';
import {
  createDownloadFractionAnchor,
  createSnapshotProgressThrottle,
  resolveDownloadFraction,
  toWireProgress,
  type DownloadFractionAnchor,
  type SnapshotBootstrapProgress,
} from './snapshot-progress';
import {
  evaluateDeletionsCoverage,
  getDeletionsCoverageAt,
  setDeletionsCoverageAt,
  resetUserDataForLostCoverage,
} from './deletions-coverage';
import { applyBusyTimeout } from '../db/pragmas';
import { getPendingCount } from '../mutation-queue/queue';
import { isNetworkError } from '../mutation-queue/error-classification';
import { isSigningOut, getWipeEpoch, isBackgrounded } from '../mutation-queue/drainer';
import { parseOfflineBoardKey, type OfflineBoardScope } from '../offline-board-key';

/**
 * Telemetry hook for schema drift: a sync document carried a column the local
 * allowlist doesn't know. The app adapter reports it (mobile → Sentry, tags
 * source: 'offline-sync', kind: 'schema-drift'); tests and headless callers omit it.
 */
export type SchemaDriftReporter = (drift: { tableName: string; column: string }) => void;

export type SyncProgress = {
  phase: 'bootstrap' | 'user_data' | 'board_data' | 'deletions' | 'idle';
  currentTable: string | null;
  documentsProcessed: number;
  /**
   * Rows processed for the current table only (resets per table), so a per-board
   * download can show its own live count. Undefined for phases without a table.
   */
  currentTableProcessed?: number;
  /**
   * Set on the terminal idle frame the SCHEDULER emits after a cycle threw —
   * it still clears the in-flight UI state, but must not stamp lastSyncedAt
   * (the cycle did not complete). pullSync's own success idle omits it.
   */
  failed?: boolean;
  /**
   * Live snapshot download/import detail (issue #4311). Only ever attached to a
   * `phase: 'bootstrap'` frame whose `currentTable` IS the scope key it
   * describes, so a row matches it exactly the way it already matches the
   * bootstrapping flag. Never present on the phase's own `currentTable: null`
   * frame, nor on the terminal idle frame, and the throttle behind it is
   * cancelled before the phase ends — so no late frame can re-light a row whose
   * download already finished.
   */
  snapshot?: SnapshotBootstrapProgress;
};

/**
 * Fired once a board scope's initial download completes this cycle (every
 * BOARD_DATA_TABLES entry reached its tail — the same gate as
 * `markScopeDownloadComplete`). Lets the app compare the two download paths in
 * the field: `method` is `'snapshot'` when a bootstrap warm-up ever succeeded
 * for this scope (the persisted `isBootstrapDone` marker — the import and the
 * completing delta pull may land in different cycles when connectivity drops
 * between them), `'paged'` otherwise (fresh paged crawl, a resumed mid-crawl
 * scope, or bootstrap unavailable/exhausted).
 * `durationMs` is measured from when this pullSync cycle FIRST touched the
 * scope — a snapshot-eligible scope is stamped at its bootstrap eligibility
 * check (so the duration includes its manifest/download/import time, not just
 * the trailing delta pull), a paged-only scope at its turn in the board-data
 * loop. Per-scope stamping keeps a multi-board cycle honest: scope B's
 * duration never includes scope A's download time, so `'snapshot'` vs
 * `'paged'` percentiles stay apples-to-apples.
 */
export type ScopeDownloadCompleteInfo = {
  scopeKey: string;
  method: 'snapshot' | 'paged';
  /**
   * NOTE for path comparisons: a scope that was HEALED (an artifact imported
   * over a partly-crawled catalog, issue #4313) reports `method: 'snapshot'` but
   * a duration that EXCLUDES the paged work earlier cycles already did. Filter on
   * `bootstrapHealed` before comparing snapshot-vs-paged percentiles.
   */
  durationMs: number;
  /** The snapshot import landed on a scope that had already crawled some rows. */
  bootstrapHealed?: boolean;
  /**
   * Wire size of the artifact this scope imported, and the rows it actually
   * wrote (issue #4316) — what a slow download has to be normalised against
   * before "Kilter is slow" means anything.
   *
   * All four are ABSENT rather than faked when the completing delta pull lands
   * in a LATER cycle than the import (the dropped-connection tail), because this
   * run has no record of work it did not do. That biases these props toward the
   * healthy population; `durationMs`, `method`, and the Started→Completed ratio
   * itself are unaffected.
   */
  bytes?: number;
  rowCount?: number;
  downloadMs?: number;
  importMs?: number;
};
export type ScopeDownloadCompleteReporter = (info: ScopeDownloadCompleteInfo) => void;

/**
 * Fired ONCE EVER per board scope, the first time any cycle starts pulling it —
 * the missing anchor that makes abandonment measurable (issue #4316). Guarded by
 * a durable `scope-started:` marker, the mirror of the `scope-complete:` one, so
 * a retrying snapshot cannot emit twice and a multi-cycle paged crawl cannot be
 * skipped. Both markers are cleared by scope teardown, so removing and re-adding
 * a board starts a fresh funnel.
 *
 * `pathIntent` is an INTENT decided from cheap local facts at emission time, not
 * an outcome: a scope that looks snapshot-eligible can still fall back to the
 * paged crawl after the manifest resolves. Funnel splits by resolved path must
 * use Completed's `method`; reading `pathIntent` as ground truth would overstate
 * the snapshot population.
 *
 * `artifactBytes` is the wire size of the artifact about to be downloaded, and
 * is null on the paged path (a crawl has no byte total at all). It is on Started
 * precisely because an ABANDONED download never emits Completed — without it,
 * the size of the downloads people give up on is unknowable.
 */
export type ScopeDownloadStartInfo = {
  scopeKey: string;
  pathIntent: 'snapshot' | 'paged';
  artifactBytes: number | null;
};
export type ScopeDownloadStartReporter = (info: ScopeDownloadStartInfo) => void;

/**
 * Fired after one bootstrap scope reaches a coherent persisted decision (or is
 * found ineligible because an existing checkpoint already made that decision).
 * The callback runs before the next scope begins, so a UI can refresh scope A
 * while a slower scope B is still in the bootstrap phase instead of reusing the
 * cycle's pre-run metadata.
 */
export type BootstrapMetadataChangedInfo = { scopeKey: string };
export type BootstrapMetadataChangedReporter = (info: BootstrapMetadataChangedInfo) => void;

/**
 * Fired when the deletions-coverage guard forced a from-scratch user-data
 * resync (issue #3474) — the device went longer than the tombstone retention
 * window without completing a deletions pull, so tombstones it never saw may
 * already be pruned server-side.
 *
 * This is an EXPECTED operational event, not an error: its rate across the
 * fleet is the only thing anyone will ask about, which is why the mobile
 * adapter routes it to `track()` rather than Sentry. `markerAgeDays` is the age
 * of the coverage marker that tripped the guard, `rowsCleared` the number of
 * local user-data rows dropped, and `pendingMutations` the outbox depth at that
 * moment (which the reset leaves untouched — a non-zero value here is normal,
 * not a loss).
 */
export type CoverageResetInfo = {
  markerAgeDays: number;
  rowsCleared: number;
  pendingMutations: number;
};
export type CoverageResetReporter = (info: CoverageResetInfo) => void;

/**
 * Every deletions-coverage evaluation, not just the ones that force a reset.
 *
 * The reset event alone is a censored instrument. `enforceDeletionsCoverage`
 * returns early on `coverageAt === null`, and the marker only exists after a
 * COMPLETED deletions pull — so a device that can never finish one (the paged
 * crawl stranded in #4313, say) stays `unknown` forever and emits nothing. The
 * reset-only view therefore samples exactly the devices healthy enough not to
 * be at risk. Reporting the verdict for every cycle makes `unknown` a
 * first-class value and turns "zero resets" into evidence rather than a shrug.
 *
 * `markerAgeDays` is a number only for `fresh` and `stale`. It is null for
 * `unknown` (no marker at all, or one below the epoch floor — a phone that
 * booted to 1970) and for `future` (a marker dated after now, i.e. a clock
 * corrected backwards): the arithmetic still produces a value for those two,
 * but it is ~20,000 days or a negative number, and either would poison an
 * average over this property. `outcome: 'probe_failed'` is the reachability
 * probe rejecting on a stale device, which today vanishes into a dev-only
 * console.warn.
 */
export type CoverageEvaluatedInfo = {
  verdict: 'unknown' | 'future' | 'fresh' | 'stale';
  markerAgeDays: number | null;
  outcome: 'evaluated' | 'reset' | 'probe_failed';
};
export type CoverageEvaluatedReporter = (info: CoverageEvaluatedInfo) => void;

/**
 * Fired when a bootstrap failure schedules the scope's next snapshot attempt
 * (issue #4313). Operational, not an error — `onSnapshotBootstrapError` still
 * carries the failure itself at its existing severity. `terminal` means both
 * budgets are spent, so the scope has settled onto the paged crawl until the
 * user asks for a retry or removes the board.
 */
export type BootstrapRetryScheduledInfo = {
  scopeKey: string;
  boardType: string;
  stage: 'manifest' | 'download' | 'import';
  failureKind: BootstrapFailureKind;
  /** Milliseconds until the scheduled retry; 0 when the scope went terminal. */
  retryAfterMs: number;
  transportFailures: number;
  structuralFailures: number;
  terminal: boolean;
};
export type BootstrapRetryScheduledReporter = (info: BootstrapRetryScheduledInfo) => void;

/**
 * Fired when a scope that had previously failed the snapshot path gets back on
 * it — the measurement that tells us whether #4313's recovery actually reaches
 * stranded installs.
 */
export type BootstrapPathRecoveredInfo = {
  scopeKey: string;
  boardType: string;
  trigger: 'cooldown' | 'new-artifact' | 'legacy-migration' | 'user-request';
  /** True when this is a heal over a partly-crawled catalog, not a fresh scope. */
  hadBoardCheckpoint: boolean;
};
export type BootstrapPathRecoveredReporter = (info: BootstrapPathRecoveredInfo) => void;

export type SyncOptions = {
  /** Encoded board scope keys ("boardType:layoutId:sizeId") to download offline. */
  enabledBoards?: string[];
  /**
   * Connectivity probe, mirroring `DrainOptions.isOnline` (drainer.ts). A pull
   * that starts with no connection can only fail every request it makes, and
   * the snapshot bootstrap phase would report each enabled-but-undownloaded
   * scope's manifest failure as telemetry on the way (issue #4238).
   *
   * DEFAULTS TO `() => true`, so every existing caller — web included — behaves
   * exactly as it did before this seam existed. Only the mobile adapter injects
   * a real probe (React Query's onlineManager, wired to NetInfo).
   */
  isOnline?: () => boolean;
  onProgress?: (progress: SyncProgress) => void;
  onSchemaDrift?: SchemaDriftReporter;
  /**
   * Injected snapshot I/O. When present, an eligible fresh board scope is warmed
   * from a pre-built artifact before the paged crawl (see the bootstrap phase in
   * pullSync). Omitted → behaviour is identical to a pure paged pull.
   */
  snapshotSource?: SnapshotSource;
  /** Telemetry for a counted bootstrap failure (manifest/download/import). */
  onSnapshotBootstrapError?: SnapshotBootstrapErrorReporter;
  /** UI invalidation after each scope's persisted bootstrap decision settles. */
  onBootstrapMetadataChanged?: BootstrapMetadataChangedReporter;
  /** Telemetry for comparing the snapshot vs paged download paths. See ScopeDownloadCompleteInfo. */
  onScopeDownloadComplete?: ScopeDownloadCompleteReporter;
  onScopeDownloadStart?: ScopeDownloadStartReporter;
  /** Telemetry for a forced deletions-coverage resync. See CoverageResetInfo. */
  onCoverageReset?: CoverageResetReporter;
  /**
   * Telemetry for EVERY deletions-coverage evaluation. Fires once per pullSync
   * cycle with no interval of its own — dedupe belongs in the platform binding,
   * so the engine seam stays deterministic and testable.
   */
  onCoverageEvaluated?: CoverageEvaluatedReporter;
  /** Telemetry for a scheduled snapshot retry (issue #4313). */
  onBootstrapRetryScheduled?: BootstrapRetryScheduledReporter;
  /** Telemetry for a scope getting back onto the snapshot path (issue #4313). */
  onBootstrapPathRecovered?: BootstrapPathRecoveredReporter;
  /**
   * Whether the device is on an unmetered link. Consulted for ONE decision: the
   * automatic heal of a partly-crawled scope, which is a ~100 MB download the
   * user did not ask for today. A fresh bootstrap (they just enabled the board,
   * behind a size-disclosing confirm) and a user-requested retry both ignore it.
   *
   * DEFAULTS TO `() => true`, so web and every existing caller are unchanged.
   */
  isOnUnmeteredNetwork?: () => boolean;
  /**
   * Wall clock for the bootstrap retry ladder. Injected so the cooldown schedule
   * is testable without fake timers fighting the SQLite test double.
   * Defaults to `Date.now`.
   */
  now?: () => number;
  /** Jitter source for the retry ladder. Defaults to `Math.random`. */
  random?: () => number;
};

/** A per-board download target: the parsed scope plus its encoded key. */
type BoardScope = OfflineBoardScope & { scopeKey: string };

const PAGE_LIMIT = 500;

// One schema-drift report per (table, column) per app launch — a 500-row page
// must not emit 500 identical telemetry events.
const reportedUnknownSyncColumns = new Set<string>();

function buildSyncQuery(queryName: string, isPerBoard: boolean): string {
  // Per-board pulls carry the board type plus optional layout/size scope so a
  // downloaded board is a fixed (boardType, layout, size) superset — all sets.
  // layoutId/sizeId are nullable server-side, so passing them undefined is a no-op.
  const boardScopeParam = isPerBoard ? '$boardType: String!, $layoutId: Int, $sizeId: Int, ' : '';
  const boardScopeArg = isPerBoard ? 'boardType: $boardType, layoutId: $layoutId, sizeId: $sizeId, ' : '';
  return `
    query ${queryName[0].toUpperCase()}${queryName.slice(1)}(${boardScopeParam}$cursor: SyncCursorInput, $limit: Int! = ${PAGE_LIMIT}) {
      ${queryName}(${boardScopeArg}cursor: $cursor, limit: $limit) {
        documents
        cursor {
          updatedAt
          syncSeq
        }
        hasMore
      }
    }
  `;
}

const SYNC_DELETIONS_QUERY = `
  query SyncDeletions($cursor: SyncCursorInput, $limit: Int! = ${PAGE_LIMIT}) {
    syncDeletions(cursor: $cursor, limit: $limit) {
      deletions {
        tableName
        recordId
        deletedAt
      }
      cursor {
        updatedAt
        syncSeq
      }
      hasMore
    }
  }
`;

// SQLite's default compile-time limit on bound parameters per statement
// (SQLITE_MAX_VARIABLE_NUMBER's pre-3.32 default, still the safe floor across
// the SQLite builds we run on — bundled iOS/Android sqlite3, node:sqlite).
// Batching must never bind more than this per INSERT.
const SQLITE_MAX_BIND_VARIABLES = 999;

/**
 * Coerces a synced document value to what the SQLite bridge accepts:
 * booleans as 0/1 (SQLite has no BOOLEAN type), Date values as ISO strings,
 * objects/arrays as their JSON string (frames, characteristics, etc. are stored
 * as TEXT), null/undefined as NULL (undefined means "document omitted this
 * column" — same bind as an explicit null), everything else passed through
 * unchanged. Exported so the snapshot export job can reuse the exact same
 * coercion off the same synced documents without re-deriving it.
 */
export function toSqliteValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value as SqlValue;
}

/**
 * How many rows fit in one multi-row `INSERT OR REPLACE ... VALUES (...),(...)`
 * statement without exceeding SQLite's bound-parameter ceiling. Always at
 * least 1 (a table wider than the ceiling still gets one row per statement —
 * it just can't batch).
 */
export function multiRowChunkSize(columnCount: number): number {
  return Math.max(1, Math.floor(SQLITE_MAX_BIND_VARIABLES / columnCount));
}

function buildMultiRowInsertSql(tableName: string, columns: readonly string[], rowCount: number): string {
  const columnList = columns.join(', ');
  const rowPlaceholder = `(${columns.map(() => '?').join(', ')})`;
  const valuesClause = Array.from({ length: rowCount }, () => rowPlaceholder).join(', ');
  return `INSERT OR REPLACE INTO ${tableName} (${columnList}) VALUES ${valuesClause}`;
}

async function upsertDocuments(
  db: OfflineDatabase,
  tableName: string,
  documents: Record<string, unknown>[],
  allowedColumns: readonly string[],
  onSchemaDrift?: SchemaDriftReporter,
): Promise<void> {
  if (documents.length === 0) return;

  // Unknown columns are SKIPPED, not fatal: the backend deploys before OTA
  // clients update, so a newly-added server column must not brick every older
  // client's sync loop. SQL safety is unaffected — the statement's column list
  // below is derived from the allowlist intersection, never from document keys.
  // Drift still surfaces in telemetry (once per table+column per app launch),
  // so a resolver emitting a misnamed column stays observable.
  const allowedColumnSet = new Set(allowedColumns);
  for (const document of documents) {
    const unknownColumns = Object.keys(document).filter((column) => !allowedColumnSet.has(column));
    for (const unknownColumn of unknownColumns) {
      const driftKey = `${tableName}.${unknownColumn}`;
      if (reportedUnknownSyncColumns.has(driftKey)) continue;
      reportedUnknownSyncColumns.add(driftKey);
      onSchemaDrift?.({ tableName, column: unknownColumn });
    }
  }

  // Columns are the union of allowed columns present anywhere in the page (not
  // per-document) — this was already true before batching, since this filter
  // ran once over the whole `documents` array. Batching depends on it: every
  // row in a multi-row VALUES clause must bind the same column list. A
  // document missing a page-wide column binds NULL for it below, same as the
  // single-row INSERT OR REPLACE did (INSERT OR REPLACE still does a whole-row
  // replace, so this matches today's semantics, not just today's SQL shape).
  const columns = allowedColumns.filter((column) =>
    documents.some((document) => Object.prototype.hasOwnProperty.call(document, column)),
  );
  if (columns.length === 0) {
    throw new Error(`Sync document for ${tableName} did not contain any allowed columns`);
  }

  const chunkSize = multiRowChunkSize(columns.length);
  // At most two distinct row counts occur in a page (full chunks + a smaller
  // final chunk), so caching the built SQL by row count avoids rebuilding the
  // same multi-row VALUES string for every full chunk.
  const sqlByRowCount = new Map<number, string>();
  const sqlForRowCount = (rowCount: number): string => {
    let sql = sqlByRowCount.get(rowCount);
    if (!sql) {
      sql = buildMultiRowInsertSql(tableName, columns, rowCount);
      sqlByRowCount.set(rowCount, sql);
    }
    return sql;
  };

  // One exclusive transaction per page (≤ PAGE_LIMIT rows): a big board pull is
  // thousands of pages, and a per-50-row transaction multiplied every page's
  // commit overhead by 10 while giving the drainer no meaningful extra window —
  // it can interleave between pages either way.
  await db.withExclusiveTransactionAsync(async (transaction) => {
    // This page's insert runs on its own connection (busy_timeout defaults to 0);
    // wait for a held lock instead of losing the whole page to an instant SQLITE_BUSY.
    await applyBusyTimeout(transaction);
    for (let chunkStart = 0; chunkStart < documents.length; chunkStart += chunkSize) {
      const chunk = documents.slice(chunkStart, chunkStart + chunkSize);
      const values: SqlValue[] = [];
      for (const document of chunk) {
        for (const column of columns) {
          values.push(toSqliteValue(document[column]));
        }
      }
      await transaction.runAsync(sqlForRowCount(chunk.length), values);
    }
  });
}

async function syncTable(
  db: OfflineDatabase,
  queryClient: QueryInvalidator,
  graphqlFetch: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>,
  tableName: string,
  /** The epoch pullSync captured at CYCLE start — see `cycleAborted` there. */
  cycleEpoch: number,
  boardScope?: BoardScope,
  onProgress?: (documentsProcessed: number) => void,
  onSchemaDrift?: SchemaDriftReporter,
): Promise<{ reachedTail: boolean }> {
  const config = TABLE_CONFIGS[tableName];
  if (!config) throw new Error(`No sync config for table: ${tableName}`);

  const checkpointKey = getCheckpointKey(tableName, boardScope?.scopeKey);
  const checkpoint = await getCheckpoint(db, checkpointKey);
  const query = buildSyncQuery(config.queryName, config.isPerBoard);

  let cursor: SyncCursorInput | undefined = checkpoint
    ? { updatedAt: checkpoint.updatedAt, syncSeq: checkpoint.syncSeq }
    : undefined;
  let totalProcessed = 0;

  // The signing-out boolean is only true for the milliseconds the wipe takes;
  // a page fetch in flight across that window sees `false` on both sides and
  // would write the old user's rows (and checkpoints!) back into the wiped DB
  // — a cross-account leak, plus checkpoints past the new user's data. The
  // epoch is monotonic, so comparing it catches a wipe that started AND
  // finished while we were awaiting the network.
  //
  // The epoch compared against is the CYCLE's, passed in — never one captured
  // here. Capturing locally would make each table re-baseline against the
  // post-wipe value and carry on, so a purge would only ever abort whichever
  // table happened to be mid-flight (see `cycleAborted` in pullSync).

  let hasMore = true;
  while (hasMore) {
    // Sign-out is wiping local data: stop before this page writes the old
    // user's rows back (mirrors the drainer's guard).
    if (isSigningOut() || getWipeEpoch() !== cycleEpoch || isBackgrounded()) return { reachedTail: false };
    const variables: Record<string, unknown> = { cursor, limit: PAGE_LIMIT };
    if (config.isPerBoard && boardScope) {
      variables.boardType = boardScope.boardType;
      variables.layoutId = boardScope.layoutId;
      variables.sizeId = boardScope.sizeId;
    }

    const response = await graphqlFetch<Record<string, SyncResult>>(query, variables);
    const result = response[config.queryName];

    // Re-check after the await: the wipe may have started (or fully completed)
    // while this page was on the wire.
    if (isSigningOut() || getWipeEpoch() !== cycleEpoch || isBackgrounded()) return { reachedTail: false };

    // An empty page would not advance the cursor; if the backend ever returns
    // documents:[] with hasMore:true we'd spin forever. Stop here (I2).
    if (result.documents.length === 0) break;

    await upsertDocuments(db, tableName, result.documents, config.localColumns, onSchemaDrift);
    await setCheckpoint(db, checkpointKey, result.cursor);

    totalProcessed += result.documents.length;
    onProgress?.(totalProcessed);

    cursor = { updatedAt: result.cursor.updatedAt, syncSeq: result.cursor.syncSeq };
    hasMore = result.hasMore;
  }

  // Only bust caches when this table actually changed. Sync runs on every
  // foreground + reconnect, and an unconditional invalidation here refetches
  // every active climb/logbook/playlist query over the network even when zero
  // rows moved (matching processDeletions, which only invalidates on arrivals).
  if (totalProcessed > 0) {
    for (const key of config.invalidateKeys) {
      queryClient.invalidateQueries({ queryKey: key });
    }
  }

  // Both loop exits here mean the server has nothing more for this cursor:
  // hasMore === false, or an empty page (the tail). Aborts return early above.
  return { reachedTail: true };
}

async function processDeletions(
  db: OfflineDatabase,
  queryClient: QueryInvalidator,
  graphqlFetch: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>,
  /** The epoch pullSync captured at CYCLE start — see `cycleAborted` there. */
  cycleEpoch: number,
  onProgress?: (documentsProcessed: number) => void,
): Promise<{ reachedTail: boolean }> {
  const checkpointKey = DELETIONS_CHECKPOINT_KEY;
  const checkpoint = await getCheckpoint(db, checkpointKey);

  let cursor: SyncCursorInput | undefined = checkpoint
    ? { updatedAt: checkpoint.updatedAt, syncSeq: checkpoint.syncSeq }
    : undefined;
  let totalProcessed = 0;
  const invalidatedKeys = new Set<string>();

  // See syncTable: catch a wipe that ran while a page was on the wire, and why the
  // epoch is the cycle's rather than one captured here.

  let hasMore = true;
  while (hasMore) {
    // Sign-out is wiping local data: stop before this page writes the old
    // user's rows back (mirrors the drainer's guard).
    if (isSigningOut() || getWipeEpoch() !== cycleEpoch || isBackgrounded()) return { reachedTail: false };
    const response = await graphqlFetch<{ syncDeletions: SyncDeletionsResult }>(SYNC_DELETIONS_QUERY, {
      cursor,
      limit: PAGE_LIMIT,
    });
    const result = response.syncDeletions;

    if (isSigningOut() || getWipeEpoch() !== cycleEpoch || isBackgrounded()) return { reachedTail: false };

    // Empty page can't advance the cursor; break to avoid an infinite loop if
    // the backend returns deletions:[] with hasMore:true (I2).
    if (result.deletions.length === 0) break;

    for (const deletion of result.deletions) {
      const config = TABLE_CONFIGS[deletion.tableName];
      if (!config) continue;

      const pkColumns = config.primaryKeyColumns;

      // Resurrection guard: a tombstone must not delete a row NEWER than the
      // deletion (delete-then-re-add on another device — the re-added row and
      // the stale tombstone can arrive in the same pull). Rows the tombstone
      // post-dates are deleted; ties delete too (same-transaction recreate),
      // which converges because deletions are applied BEFORE the table pulls.
      const hasUpdatedAt = config.localColumns.includes('updated_at');
      const guardClause = hasUpdatedAt ? ' AND (updated_at IS NULL OR updated_at <= ?)' : '';
      const guardParams = hasUpdatedAt ? [deletion.deletedAt] : [];

      if (pkColumns.length === 1) {
        const deleteResult = await db.runAsync(
          `DELETE FROM ${deletion.tableName} WHERE ${pkColumns[0]} = ?${guardClause}`,
          [deletion.recordId, ...guardParams],
        );
        // Local cascade: the server's whole-playlist delete cascades
        // playlist_climbs in Postgres but deliberately emits NO child
        // tombstones (see 0144's NULL-parent guard), and the local SQLite has
        // no FK cascade — without this, a deleted playlist's climb rows would
        // accumulate as invisible orphans forever. Gated on the parent delete
        // actually removing a row so a resurrection-guarded (stale) playlist
        // tombstone doesn't strip a live playlist's climbs.
        if (deletion.tableName === 'playlists' && (deleteResult?.changes ?? 0) > 0) {
          await db.runAsync(`DELETE FROM playlist_climbs WHERE playlist_uuid = ?`, [deletion.recordId]);
        }
      } else {
        // Backend encodes composite PKs as exactly N colon-separated segments
        // matching primaryKeyColumns order (e.g. "kilter:uuid:40" for
        // board_climb_stats with PK [board_type, climb_uuid, angle]). The split
        // must produce exactly pkColumns.length parts — if not, skip the deletion
        // rather than silently deleting the wrong row.
        const recordIdParts = deletion.recordId.split(':');
        if (recordIdParts.length !== pkColumns.length) {
          console.warn(
            `[Sync] Skipping deletion: expected ${pkColumns.length} PK parts for ${deletion.tableName}, got ${recordIdParts.length} from "${deletion.recordId}"`,
          );
          continue;
        }
        const whereClause = pkColumns.map((col) => `${col} = ?`).join(' AND ');
        await db.runAsync(`DELETE FROM ${deletion.tableName} WHERE ${whereClause}${guardClause}`, [
          ...recordIdParts,
          ...guardParams,
        ]);
      }

      for (const key of config.invalidateKeys) {
        invalidatedKeys.add(JSON.stringify(key));
      }
    }

    await setCheckpoint(db, checkpointKey, result.cursor);
    totalProcessed += result.deletions.length;
    onProgress?.(totalProcessed);

    cursor = { updatedAt: result.cursor.updatedAt, syncSeq: result.cursor.syncSeq };
    hasMore = result.hasMore;
  }

  for (const serializedKey of invalidatedKeys) {
    queryClient.invalidateQueries({ queryKey: JSON.parse(serializedKey) as string[] });
  }

  // Both loop exits mean the server has nothing more past this cursor:
  // hasMore === false, or an empty page (the tail). Only THIS outcome licenses
  // stamping the coverage marker — the aborts above return false, because a
  // pull that was backgrounded on its first page has consumed nothing and must
  // not claim a full retention window of coverage (mirrors syncTable).
  return { reachedTail: true };
}

// The manifest is fetched at most once per pullSync run and its outcome cached
// across scopes. `absent` = no usable manifest THIS cycle (missing 404 or
// unparseable) → a permanent miss that burns NO attempt (a layout not yet
// exported must not disqualify bootstrap two cycles from now). `error` = a
// transport failure reaching the manifest → a counted attempt, retried next
// cycle. `ok` carries the parsed manifest.
type ManifestResolution =
  | { status: 'ok'; manifest: SnapshotManifest }
  | { status: 'absent' }
  | { status: 'error'; cause: unknown };

/**
 * Settle one bootstrap failure: burn the budget its KIND spends, schedule the
 * next attempt on that budget's ladder, and mirror the legacy markers.
 *
 * Two independent decisions come out of a failure, and #4313 is the story of
 * them having been fused. `expected` is purely a SEVERITY signal — a
 * transport-shaped cause (offline, DNS, TLS, timeout; `isNetworkError`, the same
 * predicate the drainer uses to keep a mutation off the dead-letter path) is
 * routine on a phone and the mobile reporter downgrades it to a warning. Which
 * budget it spends is `classifyBootstrapFailure`'s call, and a transport failure
 * now spends the transport budget instead of the structural one.
 *
 * The MANIFEST stage stays entirely free for transport failures (issue #4238):
 * it is a few KB of JSON and the stage an offline launch dies at. Everything
 * else — a 500 from the CDN, a short artifact, a disk-full device — is charged.
 */
async function settleBootstrapFailure(
  db: OfflineDatabase,
  scopeKey: string,
  input: {
    state: BootstrapRetryState;
    cause: unknown;
    stage: 'manifest' | 'download' | 'import';
    builtAt: string | null;
    now: number;
    random: () => number;
  },
): Promise<{
  state: BootstrapRetryState;
  failureKind: BootstrapFailureKind;
  expected: boolean;
  cause: unknown;
  /** False for the free manifest-transport case: nothing was written to sync_meta. */
  persisted: boolean;
}> {
  const { state, cause, stage, builtAt, now, random } = input;
  const failureKind = classifyBootstrapFailure({ cause, stage });
  const expected = isNetworkError(cause);
  if (stage === 'manifest' && failureKind === 'transport') {
    // Cap-exempt and cooldown-exempt: nothing is persisted, so the scope is
    // exactly as eligible on the next cycle as it was on this one.
    return { state, failureKind, expected, cause, persisted: false };
  }
  const scheduled = nextRetryState({ state, failureKind, builtAt, now, random });
  const written = await writeBootstrapRetryState(db, scopeKey, scheduled);
  if (isTerminal(written)) {
    await markBootstrapPagedFallback(db, scopeKey);
  } else {
    // Preserve the prior fallback marker until the new attempt has a durable
    // outcome. Clearing it here avoids an abort window where the UI observes a
    // transient decision that this run never finished making.
    await clearBootstrapPagedFallback(db, scopeKey);
  }
  return { state: written, failureKind, expected, cause, persisted: true };
}

async function resolveManifestOnce(
  source: SnapshotSource,
  cache: { value?: ManifestResolution },
): Promise<ManifestResolution> {
  if (cache.value) return cache.value;
  let raw: unknown;
  try {
    raw = await source.fetchManifest();
  } catch (error) {
    cache.value = { status: 'error', cause: error };
    return cache.value;
  }
  if (raw == null) {
    cache.value = { status: 'absent' };
    return cache.value;
  }
  const manifest = parseSnapshotManifest(raw);
  cache.value = manifest ? { status: 'ok', manifest } : { status: 'absent' };
  return cache.value;
}

/**
 * Snapshot-bootstrap phase (runs BEFORE deletions). For each enabled scope the
 * shared eligibility gate vouches for, warm it from a pre-built artifact instead
 * of paging the whole catalog. Returns the scope keys whose paged board-table
 * pull must be SKIPPED this cycle. Whether an import was a HEAL over a
 * partly-crawled catalog is persisted on the `bootstrap-done:` marker instead of
 * returned, because the scope's completion event usually fires cycles later (see
 * ScopeDownloadCompleteInfo.bootstrapHealed).
 *
 * ELIGIBILITY lives in `bootstrap-retry.ts`'s `evaluateBootstrapEligibility`,
 * which `estimateScopeDownload` calls too so the size the UI quotes can never
 * disagree with what this function does. Two kinds pass it:
 *   - `fresh` — no checkpoint on either board table (the original rule).
 *   - `heal-over-partial` — a scope that HAS checkpoints but never finished its
 *     crawl and carries snapshot-path failures behind it. This is the un-strand
 *     for issue #4313's victims: their board data is a fraction of the catalog
 *     and the paged crawl that was going to finish it is 400+ serial round trips.
 *     A `scope-complete:` scope is never healed — it already serves the whole
 *     catalog locally, so an artifact buys it nothing.
 *
 * FAILURE ACCOUNTING is `classifyBootstrapFailure` + `nextRetryState` (same
 * module). Per stage:
 *   - manifest `absent` (missing/unparseable) → permanent miss, NO burn →
 *     normal paged pull.
 *   - manifest `error`, TRANSPORT-shaped → NO burn, nothing persisted, no
 *     cooldown → SKIP paged pull this cycle, reported as `expected` (#4238).
 *   - manifest `error`, anything else → structural-device burn + cooldown.
 *   - manifest `ok` but no entry for (boardType, layoutId) → permanent miss, NO
 *     burn → normal paged pull (layout not exported yet).
 *   - download fails/returns null, TRANSPORT-shaped → transport burn + the
 *     2 min → 15 min → 2 h ladder. THIS is what #4313 changed: it used to burn
 *     the same 2-slot counter a corrupt artifact does, so two bad-reception
 *     launches condemned the board to the crawl for the life of the install.
 *   - download fails otherwise → structural-device burn (6 h → 24 h ladder), and
 *     a device-side fault is never re-armed by a nightly rebuild.
 *   - download throws SnapshotPermanentMissError → NO burn → normal paged pull.
 *   - import throws → structural-artifact burn. The bytes are on disk and
 *     provably bad, so tonight's export MIGHT fix it: a terminal scope of this
 *     one kind consults the manifest again and a differently-built artifact
 *     re-arms its budget exactly once per scope, ever.
 *   - import throws SnapshotSchemaStaleError → permanent miss, NO burn: the next
 *     cycle's manifest pre-check filters the rebuilt entry out before any bytes
 *     move, so nothing can loop on it.
 *   - import throws SnapshotWatermarkRegressionError → structural-artifact burn,
 *     same as any other import failure. The artifact's scoped watermark is behind
 *     what this scope already crawled; importing would lower a checkpoint (and the
 *     global deletions cursor) below local progress, so nothing was written.
 *     Charging it is what stops the loop: the refusal is deterministic for that
 *     artifact, and before #4313's fix the scope stayed eligible and pulled the
 *     whole ~100 MB again every cycle, forever. Reported at full severity because
 *     it means the export's scope filter and the client's disagree.
 *   - success → mark done, rewind deletions to min(watermarks), clear the
 *     consecutive-transport counter; the paged pull runs normally, now a ~1-day
 *     delta from the scoped watermark checkpoints.
 *
 * WORST-CASE LIFETIME SPEND per scope: 3 transport + 2 structural + 2 for the
 * single re-armed structural round = 7 artifact downloads, each separated by at
 * least one cooldown rung. A test pins that count.
 *
 * SKIPPING THE PAGED PULL is now a grace window, not all-or-nothing: only a
 * FRESH, non-terminal scope whose retry is within 30 minutes waits for it. A
 * scope that already holds rows always crawls, so a failed heal can never stall
 * progress that was already being made.
 *
 * A wipe detected mid-phase bails the whole phase with no burn (mirrors
 * syncTable). One artifact is downloaded per (boardType, layoutId) and reused
 * across that layout's sizes; all downloads are deleted in a finally.
 *
 * Snapshot attribution for ScopeDownloadCompleteInfo.method and .bootstrapHealed
 * is NOT threaded through here — both read the persisted `bootstrap-done:` marker
 * (its presence, and whether its value records a heal), because the completing
 * delta pull can land cycles after the import.
 */
async function runBootstrapPhase(params: {
  db: OfflineDatabase;
  queryClient: QueryInvalidator;
  source: SnapshotSource;
  scopes: BoardScope[];
  /** The epoch pullSync captured at CYCLE start — see `cycleAborted` there. */
  cycleEpoch: number;
  stampScopeStart: (scopeKey: string) => void;
  /** Once-ever Started emitter, shared with the board-data loop (issue #4316). */
  emitScopeDownloadStartOnce: (info: ScopeDownloadStartInfo) => Promise<void>;
  /** Per-scope download/import timings + payload size, read back by the Completed event. */
  bootstrapTimings: Map<string, { bytes: number; downloadMs?: number; importMs?: number; rowCount?: number }>;
  options: SyncOptions | undefined;
  now: () => number;
  random: () => number;
}): Promise<{ skipPagedPull: Set<string> }> {
  const {
    db,
    queryClient,
    source,
    scopes,
    cycleEpoch,
    stampScopeStart,
    emitScopeDownloadStartOnce,
    bootstrapTimings,
    options,
    now,
    random,
  } = params;
  const onProgress = options?.onProgress;
  const onSchemaDrift = options?.onSchemaDrift;
  const onSnapshotBootstrapError = options?.onSnapshotBootstrapError;
  const onBootstrapMetadataChanged = options?.onBootstrapMetadataChanged;
  const isOnUnmeteredNetwork = options?.isOnUnmeteredNetwork ?? (() => true);

  const skipPagedPull = new Set<string>();
  const manifestCache: { value?: ManifestResolution } = {};
  // Progress frames (issue #4311). Every emission below is SYNCHRONOUS — the
  // throttle is a pure state machine — so none of this introduces a new `await`
  // and none of it shifts where a wipe can land relative to the epoch checks.
  const progressThrottle = createSnapshotProgressThrottle({ now: () => Date.now() });
  const emitSnapshotFrame = (frame: SnapshotBootstrapProgress | null): void => {
    if (!frame) return;
    onProgress?.({
      phase: 'bootstrap',
      currentTable: frame.scopeKey,
      documentsProcessed: 0,
      snapshot: frame,
    });
  };
  // Absent = not yet attempted; `file: null` = download failed (with its cause).
  const downloadByLayout = new Map<
    string,
    { file: { filePath: string } | null; cause: unknown; permanentMiss: boolean }
  >();
  const downloadedPaths = new Set<string>();

  const reportSettledFailure = (
    scope: BoardScope,
    stage: 'manifest' | 'download' | 'import',
    settled: Awaited<ReturnType<typeof settleBootstrapFailure>>,
    evaluatedAt: number,
  ): void => {
    const burned =
      settled.failureKind === 'transport' ? settled.state.transportFailures : settled.state.structuralFailures;
    onSnapshotBootstrapError?.({
      scopeKey: scope.scopeKey,
      stage,
      attempt: settled.persisted ? burned : 0,
      cause: settled.cause,
      expected: settled.expected,
    });
    if (!settled.persisted) return;
    const terminal = isTerminal(settled.state);
    options?.onBootstrapRetryScheduled?.({
      scopeKey: scope.scopeKey,
      boardType: scope.boardType,
      stage,
      failureKind: settled.failureKind,
      retryAfterMs:
        terminal || settled.state.retryAfter === null ? 0 : Math.max(0, settled.state.retryAfter - evaluatedAt),
      transportFailures: settled.state.transportFailures,
      structuralFailures: settled.state.structuralFailures,
      terminal,
    });
  };

  try {
    for (const scope of scopes) {
      let metadataSettled = false;
      try {
        if (isSigningOut() || getWipeEpoch() !== cycleEpoch || isBackgrounded()) break;

        // Duration telemetry starts here — before the eligibility check — so a
        // snapshot scope's durationMs covers its manifest/download/import work.
        stampScopeStart(scope.scopeKey);

        const climbsCheckpoint = await getCheckpoint(db, getCheckpointKey('board_climbs', scope.scopeKey));
        const statsCheckpoint = await getCheckpoint(db, getCheckpointKey('board_climb_stats', scope.scopeKey));
        const hasBoardCheckpoint = climbsCheckpoint !== null || statsCheckpoint !== null;
        const isScopeComplete = await isScopeDownloadComplete(db, scope.scopeKey);
        const isAlreadyBootstrapped = await isBootstrapDone(db, scope.scopeKey);
        // ONE clock reading for this scope's whole decision: the cooldown
        // comparison, the ladder it schedules, and the reported retryAfterMs must
        // all be made against the same instant or a slow download would report a
        // delay it never waited.
        const evaluatedAt = now();
        const { state: migratedState, migratedFromLegacy } = await readBootstrapRetryState(
          db,
          scope.scopeKey,
          { now: evaluatedAt, random },
          hasBoardCheckpoint,
        );
        let retryState = migratedState;
        // Persist the derived state on first touch so the spread-out post-OTA
        // retryAfter is stable across launches instead of being re-rolled every
        // cycle. The legacy ROWS survive (a rolled-back bundle still finds them),
        // but this write does re-stamp `bootstrap-attempts:` down to the mirrored
        // value — the migration grants one clean pass, and the mirror has to say
        // so or a rollback would re-read the pre-migration count.
        if (migratedFromLegacy && retryState.hasPriorSnapshotFailure) {
          retryState = await writeBootstrapRetryState(db, scope.scopeKey, retryState);
          metadataSettled = true;
        }

        const verdict = evaluateBootstrapEligibility({
          retryState,
          hasBoardCheckpoint,
          isScopeComplete,
          isBootstrapDone: isAlreadyBootstrapped,
          now: evaluatedAt,
        });
        // A terminal scope whose last failure was the ARTIFACT's fault is the one
        // case worth spending a manifest request on: a differently-built artifact
        // re-arms it. Everything else terminal skips the fetch entirely, which is
        // cheaper than the pre-#4313 over-cap path that consulted it every cycle.
        const isRearmCandidate = !verdict.eligible && verdict.reason === 'terminal' && verdict.canRearm;
        if (!verdict.eligible && !isRearmCandidate) {
          if (verdict.reason === 'terminal') await markBootstrapPagedFallback(db, scope.scopeKey);
          // Set on BOTH not-eligible arms deliberately: the pre-#4313 bail did
          // the same for a checkpointed scope so My Boards re-reads the row even
          // though this run did not mutate its markers.
          metadataSettled = true;
          if (shouldSkipPagedPull({ retryState, hasBoardCheckpoint, now: evaluatedAt })) {
            skipPagedPull.add(scope.scopeKey);
          }
          continue;
        }

        onProgress?.({ phase: 'bootstrap', currentTable: scope.scopeKey, documentsProcessed: 0 });
        // Stage 1 of 3. The manifest fetch is usually instant off the React
        // Query cache, but on a cold start behind a slow connection it is the
        // first thing the climber waits on, so it gets its own caption.
        emitSnapshotFrame(
          progressThrottle.flush({
            scopeKey: scope.scopeKey,
            stage: 'manifest',
            fraction: null,
            wireBytes: null,
            wireBytesDone: null,
          }),
        );

        const resolution = await resolveManifestOnce(source, manifestCache);
        // Re-check after the manifest network await: every branch below either
        // writes to SQLite or leads to one further down.
        if (isSigningOut() || getWipeEpoch() !== cycleEpoch || isBackgrounded()) break;

        // Shared with the pre-download size estimate (snapshot-estimate.ts) so the
        // UI can never quote a number for an artifact this phase would skip.
        const entry =
          resolution.status === 'ok' ? findSnapshotEntry(resolution.manifest, scope.boardType, scope.layoutId) : null;
        // Pre-check the manifest's schemaVersion so a schema-stale artifact is
        // skipped BEFORE the multi-MB download; verifySnapshotMeta re-checks the
        // authoritative value inside the file. Same permanent-miss semantics as
        // SnapshotSchemaStaleError: no burn, paged crawl runs this cycle, and
        // tonight's export rebuilds at the new schema.
        const isEntryUsable = entry !== null && isSnapshotEntryUsable(entry);

        if (isRearmCandidate) {
          // Only a genuinely DIFFERENT build is worth another round; the same
          // artifact would fail the same way.
          if (!isEntryUsable || entry.builtAt === retryState.failedBuiltAt) {
            await markBootstrapPagedFallback(db, scope.scopeKey);
            metadataSettled = true;
            continue;
          }
          retryState = await writeBootstrapRetryState(
            db,
            scope.scopeKey,
            rearmForNewArtifact(retryState, entry.builtAt),
          );
          // The scope was carrying a paged-fallback marker that My Boards renders
          // as "using the slower download". It is back on the snapshot path as of
          // this line, and the download below can run for 18 minutes — leaving the
          // marker up would tell the climber the wrong story for the whole of it.
          // A later failure re-stamps it.
          await clearBootstrapPagedFallback(db, scope.scopeKey);
          metadataSettled = true;
        }

        if (resolution.status === 'absent') {
          await markBootstrapPagedFallback(db, scope.scopeKey);
          metadataSettled = true;
          continue; // permanent miss, no burn
        }
        if (resolution.status === 'error') {
          const settled = await settleBootstrapFailure(db, scope.scopeKey, {
            state: retryState,
            cause: resolution.cause,
            stage: 'manifest',
            builtAt: null,
            now: evaluatedAt,
            random,
          });
          retryState = settled.state;
          // A cap-exempt transport failure persists nothing, so there is no settled
          // decision for the UI to re-read — only a counted one changed sync_meta.
          metadataSettled = metadataSettled || settled.persisted;
          reportSettledFailure(scope, 'manifest', settled, evaluatedAt);
          if (shouldSkipPagedPull({ retryState, hasBoardCheckpoint, now: evaluatedAt })) {
            skipPagedPull.add(scope.scopeKey);
          }
          continue;
        }
        if (!entry) {
          await markBootstrapPagedFallback(db, scope.scopeKey);
          metadataSettled = true;
          continue; // layout not exported yet — permanent miss, no burn
        }
        if (!isEntryUsable) {
          await markBootstrapPagedFallback(db, scope.scopeKey);
          metadataSettled = true;
          continue;
        }

        // A re-arm makes a terminal scope eligible as of this cycle; its kind is
        // whatever it would have been had the budget never run out.
        const bootstrapKind = verdict.eligible
          ? verdict.kind
          : hasBoardCheckpoint
            ? ('heal-over-partial' as const)
            : ('fresh' as const);

        // The one path the climber DID ask for today: "Try the fast download
        // again", behind the same size-disclosing confirm the enable toggle
        // uses. It reads as consent for this one download, so it overrides the
        // metered defer below — without it the tap is a silent no-op on
        // cellular, because a settled scope always carries board checkpoints and
        // therefore always heals rather than bootstrapping fresh.
        const isUserRequested = retryState.userRequested;

        // The automatic heal is the one path that downloads ~100 MB for a board
        // the user enabled on some earlier day. Defer it on a metered link; a
        // fresh bootstrap (confirmed behind a size-disclosing dialog moments ago)
        // and a user-requested retry are consented and ignore the probe.
        if (bootstrapKind === 'heal-over-partial' && !isUserRequested && !isOnUnmeteredNetwork()) {
          retryState = await writeBootstrapRetryState(db, scope.scopeKey, deferHeal(retryState, evaluatedAt));
          metadataSettled = true;
          continue;
        }

        // Spend the request BEFORE the download: one tap buys one artifact, so a
        // failure schedules an ordinary cooldown instead of leaving a standing
        // metered-link override that keeps pulling ~100 MB over cellular.
        if (isUserRequested) {
          retryState = await writeBootstrapRetryState(db, scope.scopeKey, spendUserRequest(retryState));
          metadataSettled = true;
        }

        if (retryState.hasPriorSnapshotFailure) {
          options?.onBootstrapPathRecovered?.({
            scopeKey: scope.scopeKey,
            boardType: scope.boardType,
            trigger: isUserRequested
              ? 'user-request'
              : isRearmCandidate
                ? 'new-artifact'
                : migratedFromLegacy
                  ? 'legacy-migration'
                  : 'cooldown',
            hadBoardCheckpoint: hasBoardCheckpoint,
          });
        }

        // Started (issue #4316), the snapshot half. Emitted HERE — below every
        // `continue` that means this scope does no snapshot work this cycle, and
        // once the entry proved usable — so it can carry the artifact's wire
        // size, which is the one thing an ABANDONED download never gets to
        // report (it emits no Completed at all). The durable marker makes the
        // board-data loop's emission below a no-op for this scope; every path
        // that `continue`s above (including the metered heal defer) reaches that
        // one instead and is correctly attributed to the paged crawl.
        await emitScopeDownloadStartOnce({
          scopeKey: scope.scopeKey,
          pathIntent: 'snapshot',
          artifactBytes: entry.bytes,
        });
        if (isSigningOut() || getWipeEpoch() !== cycleEpoch || isBackgrounded()) break;

        const layoutKey = `${scope.boardType}:${scope.layoutId}`;
        // The failure cause is cached alongside the result so a second size of the
        // same layout (which reuses this entry instead of re-downloading) still
        // reports the real error, not null.
        let cachedDownload = downloadByLayout.get(layoutKey);
        if (!cachedDownload) {
          cachedDownload = { file: null, cause: null, permanentMiss: false };
          // Stage 2 of 3, the multi-minute one. A second SIZE of the same layout
          // reuses this cache entry, so it never re-runs and never re-emits
          // download frames for bytes that already came down.
          let fractionAnchor: DownloadFractionAnchor = createDownloadFractionAnchor();
          const downloadStartedAt = Date.now();
          emitSnapshotFrame(
            progressThrottle.flush({
              scopeKey: scope.scopeKey,
              stage: 'download',
              fraction: 0,
              wireBytes: entry.bytes,
              wireBytesDone: 0,
            }),
          );
          try {
            cachedDownload.file =
              (await source.downloadArtifact(entry, {
                onProgress: ({ bytesWritten, totalBytes }) => {
                  const resolved = resolveDownloadFraction({
                    entry,
                    bytesWritten,
                    reportedTotalBytes: totalBytes,
                    anchor: fractionAnchor,
                  });
                  fractionAnchor = resolved.anchor;
                  emitSnapshotFrame(
                    progressThrottle.offer({
                      scopeKey: scope.scopeKey,
                      stage: 'download',
                      fraction: resolved.fraction,
                      ...toWireProgress(resolved.fraction, entry.bytes),
                    }),
                  );
                },
              })) ?? null;
          } catch (error) {
            cachedDownload.cause = error;
            cachedDownload.permanentMiss = error instanceof SnapshotPermanentMissError;
          }
          downloadByLayout.set(layoutKey, cachedDownload);
          if (cachedDownload.file) downloadedPaths.add(cachedDownload.file.filePath);
          if (cachedDownload.file) {
            bootstrapTimings.set(scope.scopeKey, {
              bytes: entry.bytes,
              downloadMs: Date.now() - downloadStartedAt,
            });
          }
        }
        // Re-check after the (potentially multi-MB) artifact download await, same
        // reason as the manifest check above.
        if (isSigningOut() || getWipeEpoch() !== cycleEpoch || isBackgrounded()) break;
        const download = cachedDownload.file;
        if (!download) {
          if (cachedDownload.permanentMiss) {
            await markBootstrapPagedFallback(db, scope.scopeKey);
            metadataSettled = true;
            onSnapshotBootstrapError?.({
              scopeKey: scope.scopeKey,
              stage: 'download',
              attempt: 0,
              cause: cachedDownload.cause,
              expected: false,
            });
            continue;
          }
          const settled = await settleBootstrapFailure(db, scope.scopeKey, {
            state: retryState,
            cause: cachedDownload.cause,
            stage: 'download',
            builtAt: entry.builtAt,
            now: evaluatedAt,
            random,
          });
          retryState = settled.state;
          metadataSettled = true;
          reportSettledFailure(scope, 'download', settled, evaluatedAt);
          if (shouldSkipPagedPull({ retryState, hasBoardCheckpoint, now: evaluatedAt })) {
            skipPagedPull.add(scope.scopeKey);
          }
          continue;
        }

        // The artifact came down: the link works, so the consecutive-transport
        // counter (and any cooldown it scheduled) no longer describes anything.
        const withTransportCleared = clearTransportFailures(retryState);
        if (withTransportCleared !== retryState) {
          retryState = await writeBootstrapRetryState(db, scope.scopeKey, withTransportCleared);
          metadataSettled = true;
        }

        // Stage 3 of 3. Indeterminate by construction: the import is one
        // exclusive SQLite transaction with no safe place to emit from inside it.
        emitSnapshotFrame(
          progressThrottle.flush({
            scopeKey: scope.scopeKey,
            stage: 'import',
            fraction: null,
            wireBytes: entry.bytes,
            wireBytesDone: null,
          }),
        );

        try {
          // Imports the scope's rows, stamps both table checkpoints, and rewinds
          // the global deletions cursor to the older table watermark — all in one
          // transaction, so no crash point can separate the imported rows from
          // the tombstone-replay window that must cover them.
          const importStartedAt = Date.now();
          const imported = await bootstrapScopeFromSnapshot({
            db,
            scope,
            scopeKey: scope.scopeKey,
            filePath: download.filePath,
            onSchemaDrift,
            // Arms the watermark-regression guard on the heal path: the artifact
            // may not stamp a checkpoint BELOW what this scope already crawled.
            existingCheckpoints: hasBoardCheckpoint
              ? { board_climbs: climbsCheckpoint ?? undefined, board_climb_stats: statsCheckpoint ?? undefined }
              : undefined,
          });
          const timings = bootstrapTimings.get(scope.scopeKey) ?? { bytes: entry.bytes };
          bootstrapTimings.set(scope.scopeKey, {
            ...timings,
            importMs: Date.now() - importStartedAt,
            rowCount: imported.climbsImported + imported.statsImported,
          });
          // The heal flag rides the persisted marker, not a per-cycle set: the
          // scope usually reaches completion in a LATER cycle (board_climb_grades
          // is not a snapshot table and still crawls), and an in-memory set
          // reports false for exactly the runs the flag exists to filter out.
          await markBootstrapDone(db, scope.scopeKey, { healed: hasBoardCheckpoint });
          metadataSettled = true;
          // Bust the board-table query caches now: if the snapshot fully satisfies
          // the scope, the delta pull returns zero documents and syncTable's
          // arrivals-only invalidation never fires — an active search/detail query
          // would keep serving the pre-import (empty) result set.
          for (const tableName of ['board_climbs', 'board_climb_stats'] as const) {
            for (const key of TABLE_CONFIGS[tableName].invalidateKeys) {
              queryClient.invalidateQueries({ queryKey: key });
            }
          }
          // Not skipped: the board-data phase delta-pulls from the watermark
          // checkpoints and fires markScopeDownloadComplete through the tail logic.
        } catch (error) {
          // A wipe mid-import rolls the transaction back and bails the phase — no
          // burn (the pull is being torn down, not failing).
          if (
            error instanceof SnapshotWipedError ||
            isSigningOut() ||
            getWipeEpoch() !== cycleEpoch ||
            isBackgrounded()
          )
            break;
          if (error instanceof SnapshotSchemaStaleError) {
            // Permanent miss for this run, no burn: the artifact predates this
            // client's schema and tonight's export rebuilds it at the new one, so
            // the next cycle's cheap manifest pre-check (isSnapshotEntryUsable)
            // filters it out before any bytes move. The scope's paged pull runs
            // NOW, which is always correct.
            //
            // The watermark regression deliberately does NOT land here — it is a
            // structural failure, charged below. Refusing without recording the
            // refusal left the scope exactly as eligible as it was, so the same
            // ~100 MB artifact came down again on every cycle, forever.
            await markBootstrapPagedFallback(db, scope.scopeKey);
            metadataSettled = true;
            onSnapshotBootstrapError?.({
              scopeKey: scope.scopeKey,
              stage: 'import',
              attempt: 0,
              cause: error,
              expected: false,
            });
            continue;
          }
          // The bytes are already on disk, so nothing about this failure is a
          // network problem: it burns the structural budget, and a differently
          // built artifact is the only thing that can re-arm it. A watermark
          // regression is charged here too — the artifact on offer provably
          // cannot serve this scope, and only a rebuilt one (with a watermark
          // past the local checkpoint, or a fixed scope filter) can change that.
          const settled = await settleBootstrapFailure(db, scope.scopeKey, {
            state: retryState,
            cause: error,
            stage: 'import',
            builtAt: entry.builtAt,
            now: evaluatedAt,
            random,
          });
          retryState = settled.state;
          metadataSettled = true;
          reportSettledFailure(scope, 'import', settled, evaluatedAt);
          if (shouldSkipPagedPull({ retryState, hasBoardCheckpoint, now: evaluatedAt })) {
            skipPagedPull.add(scope.scopeKey);
          }
        }
      } finally {
        if (metadataSettled) onBootstrapMetadataChanged?.({ scopeKey: scope.scopeKey });
      }
    }
  } finally {
    // Before the artifact cleanup awaits, so an onProgress callback still queued
    // behind them cannot emit a frame after the phase is over and re-light a row
    // the UI already moved past.
    progressThrottle.cancel();
    for (const filePath of downloadedPaths) {
      await source.deleteArtifact(filePath).catch(() => {});
    }
  }

  return { skipPagedPull };
}

/**
 * Deletions-coverage guard: force a from-scratch user-data resync when this
 * device went longer than the tombstone retention window without completing a
 * deletions pull, so tombstones it never saw are already pruned server-side
 * (issue #3474).
 *
 * Three of the four verdicts do NOTHING AT ALL — no reset, and no stamp either.
 * The marker is written in exactly one place, after the deletions pull below
 * reaches its tail, because that is the only moment coverage is actually
 * established. Claiming it here would be a lie a failed or backgrounded first
 * pull could never take back:
 *  - `unknown` (no marker, or one below the plausibility floor): the key is new,
 *    so EVERY existing install lacks it on the first launch after the update,
 *    and there is no persisted last-sync wall clock to seed from (mobile's
 *    lastSyncedAt is an in-memory store that resets each launch). Treating
 *    absence as "stale" would detonate a fleet-wide reset on the rollout. A
 *    device that has ALREADY been away longer than the window therefore keeps
 *    its stale rows — status quo, not a regression, and the only design that
 *    cannot mass-wipe the fleet on rollout. It stays `unknown` until a pull
 *    actually completes, so a device that can never finish one never claims a
 *    window it did not have.
 *  - `future` (marker dated after now): a clock corrected backwards. The
 *    completed-pass stamp overwrites it with a real `now`, which unfreezes it
 *    without inventing coverage on a cycle that failed.
 *  - `fresh`: the common path — one sync_meta read and nothing else.
 *
 * A `stale` verdict PROBES the network before touching anything. pullSync runs
 * on every foreground, including offline ones; wiping first and only then
 * discovering there is no connection would leave the user staring at an empty
 * app until connectivity returns. The probe is a one-row syncDeletions request
 * whose result is discarded — it proves reachability AND the credential, so an
 * expired-token device can't wipe itself either. A throw propagates to the
 * scheduler's catch, which retries on the next trigger with local data intact.
 *
 * `beginLocalPurge()` is deliberately NOT called: it bumps the wipe epoch, which
 * would abort the very cycle that is supposed to rebuild. It isn't needed here —
 * the scheduler single-flights pullSync, so no other pull page is on the wire,
 * and the drainer writes only to pending_mutations, which this reset never
 * touches.
 */
async function enforceDeletionsCoverage(
  db: OfflineDatabase,
  queryClient: QueryInvalidator,
  graphqlFetch: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>,
  cycleEpoch: number,
  options?: SyncOptions,
): Promise<void> {
  // Sign-out is (or is about to be) wiping local user data on its own terms;
  // don't write sync_meta into a DB mid-teardown, and don't spend a probe on an
  // account that is going away. Its deleteUserCheckpoints drops the coverage
  // marker and rewinds the deletions cursor to the epoch anyway, so the next
  // signed-in pull re-reads the whole retained tombstone window and re-stamps.
  if (isSigningOut()) return;

  // One clock reading for the whole decision. The probe below is a network
  // round-trip, so re-reading Date.now() after it would report a marker age
  // that isn't the one the verdict was made on.
  const evaluatedAt = Date.now();
  const coverageAt = await getDeletionsCoverageAt(db);
  const verdict = evaluateDeletionsCoverage(coverageAt, evaluatedAt);

  // floor, not round, everywhere this age is reported: a 79.6-day marker must
  // not read as 80 (the threshold value) when the decision was made on exact
  // milliseconds.
  //
  // Null for the two verdicts whose age is not a coverage age. That is a data
  // rule, not cosmetics: `future` is a marker dated after now (a clock
  // corrected backwards) and would report a NEGATIVE age, and `unknown` covers
  // both an absent marker AND one below DELETIONS_COVERAGE_EPOCH_FLOOR_MS (a
  // phone that booted to 1970 before NTP landed), which would report ~20,000
  // days. Either value poisons an average or a percentile over this property.
  const markerAgeDays =
    coverageAt === null || verdict === 'unknown' || verdict === 'future'
      ? null
      : Math.floor((evaluatedAt - coverageAt) / 86_400_000);

  // Reported BEFORE the early return below, so `unknown` and `future` are
  // first-class values rather than silence. That is the whole point: the
  // devices that never complete a deletions pull are the at-risk population,
  // and a reset-only instrument can never see them.
  options?.onCoverageEvaluated?.({ verdict, markerAgeDays, outcome: 'evaluated' });

  // Only 'stale' does anything. Keeping the explicit `coverageAt === null`
  // disjunct means an absent marker can never structurally reach the wipe below,
  // whatever the classifier is later taught to return — and it narrows
  // coverageAt to a number, so markerAgeDays needs no fallback for a case that
  // cannot happen.
  // (markerAgeDays is null for every verdict except `fresh` and `stale`;
  // naming it in the guard narrows it to a number for the reset report below.)
  if (coverageAt === null || markerAgeDays === null || verdict !== 'stale') return;

  // Reachability + auth probe. Its payload is irrelevant; only "did it resolve"
  // matters, so it asks for a single row. A rejection is reported and then
  // RETHROWN unchanged: the throw is what leaves local data intact and defers
  // to the next cycle, and swallowing it here would wipe a stale device's user
  // data without a verified connection — the exact catastrophe the probe exists
  // to prevent.
  try {
    await graphqlFetch<{ syncDeletions: SyncDeletionsResult }>(SYNC_DELETIONS_QUERY, { cursor: undefined, limit: 1 });
  } catch (error) {
    options?.onCoverageEvaluated?.({ verdict, markerAgeDays, outcome: 'probe_failed' });
    throw error;
  }

  // Re-check the teardown flags after the network await — the probe may have
  // been in flight across a sign-out or a backgrounding, and neither wants a
  // multi-table DELETE dispatched at it. The epoch check catches the third
  // teardown: a board removal (or any beginLocalPurge) that landed while the
  // probe was on the wire is about to abort this cycle at its first
  // cycleAborted(), so a wipe here would clear user data with no rebuild behind it.
  if (isSigningOut() || isBackgrounded() || getWipeEpoch() !== cycleEpoch) return;

  const pendingMutations = await getPendingCount(db);
  // The STAMP is read fresh — it claims coverage as of the wipe itself, which is
  // after the probe. Only the reported age below uses the decision's clock.
  const { rowsCleared } = await resetUserDataForLostCoverage(db, Date.now());

  // Bust every user-data cache the wipe just invalidated. The rebuild below
  // cannot be relied on to do it: syncTable only invalidates when it pulled at
  // least one document and processDeletions only on arrivals, so a table the
  // user had emptied server-side re-pulls nothing and a mounted screen would
  // keep serving the pre-wipe react-query cache — the exact #3474 symptom
  // surviving the fix. Deduped by serialized key, same shape as processDeletions.
  const invalidatedKeys = new Set<string>();
  for (const tableName of USER_DATA_TABLES) {
    for (const key of TABLE_CONFIGS[tableName].invalidateKeys) {
      invalidatedKeys.add(JSON.stringify(key));
    }
  }
  for (const serializedKey of invalidatedKeys) {
    queryClient.invalidateQueries({ queryKey: JSON.parse(serializedKey) as string[] });
  }

  options?.onCoverageReset?.({ markerAgeDays, rowsCleared, pendingMutations });
  // Alongside the reset event, not instead of it: onCoverageReset stays the
  // dedicated "a wipe happened" signal, while the verdict stream carries the
  // denominator that makes its rate readable.
  options?.onCoverageEvaluated?.({ verdict, markerAgeDays, outcome: 'reset' });
}

export async function pullSync(
  db: OfflineDatabase,
  queryClient: QueryInvalidator,
  graphqlFetch: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>,
  options?: SyncOptions,
): Promise<void> {
  // Mirrors drainMutationQueue's entry guard: don't even start the snapshot
  // bootstrap phase below (which runs before the first cycleAborted() check)
  // when the app is already backgrounded.
  if (isBackgrounded()) return;

  // Offline: every request this cycle would make is already lost, and the
  // bootstrap phase would spend a Sentry event per enabled-but-undownloaded
  // scope announcing it (issue #4238). Skip; the scheduler's offline→online
  // edge and the next foreground both retrigger a cycle. Same posture as
  // drainMutationQueue's `if (!options.isOnline()) return`.
  const isOnline = options?.isOnline ?? (() => true);
  if (!isOnline()) return;

  // Captured ONCE for the whole cycle and threaded into every phase, so a wipe or a
  // local purge aborts the entire pull rather than just whichever table is mid-flight.
  //
  // This matters because `enabledBoards` is a snapshot taken before the cycle began.
  // Removing a board (see removeBoardScopeData) drops it from that setting and bumps
  // the epoch — but this cycle is still iterating the STALE list. If each table
  // re-baselined its own epoch, every table after the one that aborted would capture
  // the post-bump value, sail through its guard, and happily re-download the scope
  // whose rows are being deleted right now, writing checkpoints past them. The user
  // taps Remove and the catalog comes back.
  //
  // Sign-out never hit this because `isSigningOut()` is a persistent flag that stays
  // true for every subsequent table; the epoch alone is not a substitute for it.
  //
  // Captured immediately after the entry guard and BEFORE the coverage phase's
  // awaits: that phase can spend a network probe plus a multi-table wipe, and a
  // purge landing inside that window must read as "not my epoch" rather than be
  // adopted as this cycle's own baseline.
  const cycleEpoch = getWipeEpoch();
  // Unlike the other two checks, isBackgrounded() and isOnline() are live, not latched —
  // a background dip (or a connectivity blip) that clears before the next check runs
  // won't abort a cycle it can no longer affect. Connectivity is checked between phases
  // rather than inside the bootstrap phase deliberately: an artifact that finished
  // downloading must still get imported, and re-downloading 272 MB because NetInfo
  // flapped during the import would be the worse failure.
  const cycleAborted = (): boolean =>
    isSigningOut() || getWipeEpoch() !== cycleEpoch || isBackgrounded() || !isOnline();

  // Phase -1: deletions-coverage guard (issue #3474). Runs BEFORE the bootstrap
  // phase, so the reset and the rebuild that follows belong to the same cycle.
  // See deletions-coverage.ts for the invariant and for exactly what the reset
  // does (and does not) clear.
  await enforceDeletionsCoverage(db, queryClient, graphqlFetch, cycleEpoch, options);
  // The phase can spend a probe and a multi-table wipe; the bootstrap phase below
  // starts downloading before the deletions phase's own cycleAborted(), so check
  // here rather than let a teardown that landed during it kick off a download.
  if (cycleAborted()) return;

  const enabledBoards = options?.enabledBoards ?? [];
  const onProgress = options?.onProgress;
  let totalDocuments = 0;

  // Parse the enabled scope keys once; malformed keys are dropped (a stray value
  // can't crash the pull) so both the bootstrap phase and the paged board loop
  // iterate the same validated set.
  const boardScopes: BoardScope[] = [];
  for (const scopeKey of enabledBoards) {
    const scope = parseOfflineBoardKey(scopeKey);
    if (scope) boardScopes.push({ ...scope, scopeKey });
  }

  // Per-scope start timestamp for ScopeDownloadCompleteInfo.durationMs, stamped
  // when the cycle FIRST touches that scope (bootstrap eligibility check, or
  // its turn in the board-data loop) — NOT once at cycle start, which would
  // fold scope A's entire download time into scope B's duration whenever a
  // cycle processes several boards.
  const scopeStartedAt = new Map<string, number>();
  const stampScopeStart = (scopeKey: string): void => {
    if (!scopeStartedAt.has(scopeKey)) scopeStartedAt.set(scopeKey, Date.now());
  };

  // Download-funnel Started (issue #4316). Once ever per scope, guarded by the
  // durable `scope-started:` marker rather than by anything cycle-local, so a
  // snapshot that fails and retries emits one event and a paged crawl that spans
  // cycles is not skipped. Both are how the naive in-cycle version broke.
  const emitScopeDownloadStartOnce = async (info: ScopeDownloadStartInfo): Promise<void> => {
    if (await isScopeDownloadStarted(db, info.scopeKey)) return;
    await markScopeDownloadStarted(db, info.scopeKey);
    // BACKFILL, NOT A START. A scope whose download already completed — every
    // board on a device that upgrades into this build — is not starting one now,
    // and it can never emit Completed again either (that event is guarded by the
    // `scope-complete:` marker it already carries). Emitting here would give the
    // funnel one unmatched Started per already-downloaded board on the first
    // cycle after release: a phantom abandonment spike, in exactly the window
    // the baseline is read from. Write the marker (so this is still once-ever)
    // and stay silent.
    if (await isScopeDownloadComplete(db, info.scopeKey)) return;
    options?.onScopeDownloadStart?.(info);
  };
  // Per-scope payload size and stage timings, recorded by the bootstrap phase and
  // read back by Completed below. Run-local on purpose: a cycle that did not do
  // the import has nothing honest to report (see ScopeDownloadCompleteInfo).
  const bootstrapTimings = new Map<
    string,
    { bytes: number; downloadMs?: number; importMs?: number; rowCount?: number }
  >();

  // Phase 0: snapshot bootstrap (BEFORE deletions). Only when an adapter injected
  // snapshot I/O; otherwise this is a pure paged pull, byte-identical to before.
  let skipBootstrapPagedPull: Set<string> = new Set();
  if (options?.snapshotSource && boardScopes.length > 0) {
    onProgress?.({ phase: 'bootstrap', currentTable: null, documentsProcessed: 0 });
    const bootstrapPhase = await runBootstrapPhase({
      db,
      queryClient,
      source: options.snapshotSource,
      scopes: boardScopes,
      cycleEpoch,
      stampScopeStart,
      emitScopeDownloadStartOnce,
      bootstrapTimings,
      options,
      now: options.now ?? Date.now,
      random: options.random ?? Math.random,
    });
    skipBootstrapPagedPull = bootstrapPhase.skipPagedPull;
  }

  // Deletions FIRST, table pulls second. This ordering is what makes a
  // delete-then-recreate on the server converge: the tombstone removes the old
  // local row, then the same cycle's table pull upserts the recreated one.
  // Applied after the pulls, a tombstone sharing the recreated row's timestamp
  // would delete data this cycle just wrote, and the strict > cursor would
  // never fetch it again.
  if (cycleAborted()) return;
  onProgress?.({ phase: 'deletions', currentTable: null, documentsProcessed: 0 });
  const deletionsResult = await processDeletions(db, queryClient, graphqlFetch, cycleEpoch, (deletionsProcessed) => {
    totalDocuments = deletionsProcessed;
    onProgress?.({ phase: 'deletions', currentTable: null, documentsProcessed: totalDocuments });
  });
  // The coverage marker advances ONLY on a completed pass. An aborted one (sign-out,
  // purge, backgrounding) consumed an unknown prefix of the stream, so claiming a
  // fresh retention window off it would hide a real gap. See deletions-coverage.ts.
  if (deletionsResult.reachedTail) await setDeletionsCoverageAt(db, Date.now());

  let allUserTablesReachedTail = true;
  for (const tableName of USER_DATA_TABLES) {
    if (cycleAborted()) return;
    onProgress?.({ phase: 'user_data', currentTable: tableName, documentsProcessed: totalDocuments });
    const baseCount = totalDocuments;
    const userTableResult = await syncTable(
      db,
      queryClient,
      graphqlFetch,
      tableName,
      cycleEpoch,
      undefined,
      (tableProcessed) => {
        totalDocuments = baseCount + tableProcessed;
        onProgress?.({ phase: 'user_data', currentTable: tableName, documentsProcessed: totalDocuments });
      },
      options?.onSchemaDrift,
    );
    if (!userTableResult.reachedTail) allUserTablesReachedTail = false;
  }

  // Only now are the user tables complete enough for a local reader to serve
  // from — a checkpoint alone proves the first page landed, and a logbook built
  // from a fraction of the rows reads as "you never climbed that". Mirrors
  // markScopeDownloadComplete for board scopes. Cleared on sign-out for free:
  // the key is `checkpoint:`-prefixed, so deleteUserCheckpoints takes it.
  if (allUserTablesReachedTail) await markUserDataComplete(db);

  // Each enabled board is a "boardType:layoutId:sizeId" scope key (already parsed
  // into boardScopes). currentTable carries the full scope key so a per-board UI
  // can match itself.
  for (const boardScope of boardScopes) {
    // boardScopes is the pre-cycle snapshot of the enabled set. Once a purge has
    // fired, every remaining entry is suspect — the scope being deleted right now is
    // still in this list — so stop the cycle rather than pulling any of them.
    if (cycleAborted()) return;
    const scopeKey = boardScope.scopeKey;
    // No-op when the bootstrap phase already stamped this scope; the paged-only
    // path (no snapshotSource) starts its duration clock here.
    stampScopeStart(scopeKey);
    // Started (issue #4316), the paged half — and the catch-all. Every scope
    // reaches this line on every path: a build with no snapshot source, a scope
    // the bootstrap phase found ineligible or unexportable, and the resumed
    // multi-cycle crawl the checkpoint gate above skips. A scope the bootstrap
    // phase already announced is a no-op here thanks to the durable marker, so
    // it keeps its 'snapshot' intent and its artifact size.
    await emitScopeDownloadStartOnce({ scopeKey, pathIntent: 'paged', artifactBytes: null });
    if (cycleAborted()) return;
    // A scope whose bootstrap failed this cycle (with attempts still left) skips
    // its paged pull: a first-page checkpoint would permanently disqualify the
    // snapshot path, so the next cycle retries the snapshot instead.
    if (skipBootstrapPagedPull.has(scopeKey)) continue;
    let allTablesReachedTail = true;
    for (const tableName of BOARD_DATA_TABLES) {
      if (cycleAborted()) return;
      const tableLabel = `${tableName}:${scopeKey}`;
      onProgress?.({
        phase: 'board_data',
        currentTable: tableLabel,
        documentsProcessed: totalDocuments,
        currentTableProcessed: 0,
      });
      const baseCount = totalDocuments;
      const { reachedTail } = await syncTable(
        db,
        queryClient,
        graphqlFetch,
        tableName,
        cycleEpoch,
        boardScope,
        (tableProcessed) => {
          totalDocuments = baseCount + tableProcessed;
          onProgress?.({
            phase: 'board_data',
            currentTable: tableLabel,
            documentsProcessed: totalDocuments,
            currentTableProcessed: tableProcessed,
          });
        },
        options?.onSchemaDrift,
      );
      if (!reachedTail) allTablesReachedTail = false;
    }
    // Gate for local-first reads: only a scope whose climbs, stats AND grades
    // (every BOARD_DATA_TABLES entry) have all pulled to the tail may serve
    // searches — a first-page checkpoint would otherwise serve a sliver of the
    // catalog as if it were everything.
    if (allTablesReachedTail) {
      const wasScopeComplete = await isScopeDownloadComplete(db, scopeKey);
      await markScopeDownloadComplete(db, scopeKey);
      if (wasScopeComplete) continue;
      const startedAt = scopeStartedAt.get(scopeKey);
      // Should be unreachable because stampScopeStart runs at the top of this
      // loop for every scope. If that invariant breaks, skip telemetry rather
      // than emit a misleading 0ms duration.
      if (startedAt === undefined) continue;
      // Both attributions read the persisted marker, not this run's bootstrap
      // work: the import and the completing delta pull can land in different
      // cycles (connectivity drop between them, or the grades crawl still
      // running), and this event fires exactly once per scope — misreporting
      // that one event would permanently skew the rollout comparison.
      const timings = bootstrapTimings.get(scopeKey);
      options?.onScopeDownloadComplete?.({
        scopeKey,
        method: (await isBootstrapDone(db, scopeKey)) ? 'snapshot' : 'paged',
        durationMs: Date.now() - startedAt,
        // A healed scope's duration excludes the paged work earlier cycles did,
        // so it must be filtered out of snapshot-vs-paged comparisons.
        bootstrapHealed: await wasBootstrapHealed(db, scopeKey),
        // Spread rather than set explicitly: absent when this cycle did not do
        // the import, which is the honest answer (see ScopeDownloadCompleteInfo).
        ...timings,
      });
    }
  }

  onProgress?.({ phase: 'idle', currentTable: null, documentsProcessed: totalDocuments });
}
