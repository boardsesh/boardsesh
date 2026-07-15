import type { OfflineDatabase, QueryInvalidator, SqlValue } from '../database';
import type { SyncCursorInput, SyncResult, SyncDeletionsResult } from '../types';
import { TABLE_CONFIGS, USER_DATA_TABLES, BOARD_DATA_TABLES } from './table-config';
import {
  getCheckpoint,
  setCheckpoint,
  getCheckpointKey,
  markScopeDownloadComplete,
  isScopeDownloadComplete,
  DELETIONS_CHECKPOINT_KEY,
} from './checkpoints';
import {
  bootstrapScopeFromSnapshot,
  getBootstrapAttempts,
  recordBootstrapAttempt,
  markBootstrapDone,
  isBootstrapDone,
  MAX_BOOTSTRAP_ATTEMPTS,
  SnapshotWipedError,
  SnapshotSchemaStaleError,
  SnapshotPermanentMissError,
  type SnapshotSource,
  type SnapshotBootstrapErrorReporter,
} from './snapshot-bootstrap';
import { parseSnapshotManifest, type SnapshotManifest } from './snapshot-manifest';
import { findSnapshotEntry, isSnapshotEntryUsable } from './snapshot-estimate';
import { isSigningOut, getWipeEpoch } from '../mutation-queue/drainer';
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
};

/**
 * Fired once a board scope's initial download completes this cycle (both
 * board_climbs and board_climb_stats reached their tail — the same gate as
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
  durationMs: number;
};
export type ScopeDownloadCompleteReporter = (info: ScopeDownloadCompleteInfo) => void;

export type SyncOptions = {
  /** Encoded board scope keys ("boardType:layoutId:sizeId") to download offline. */
  enabledBoards?: string[];
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
  /** Telemetry for comparing the snapshot vs paged download paths. See ScopeDownloadCompleteInfo. */
  onScopeDownloadComplete?: ScopeDownloadCompleteReporter;
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
  const startEpoch = getWipeEpoch();

  let hasMore = true;
  while (hasMore) {
    // Sign-out is wiping local data: stop before this page writes the old
    // user's rows back (mirrors the drainer's guard).
    if (isSigningOut() || getWipeEpoch() !== startEpoch) return { reachedTail: false };
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
    if (isSigningOut() || getWipeEpoch() !== startEpoch) return { reachedTail: false };

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
  onProgress?: (documentsProcessed: number) => void,
): Promise<void> {
  const checkpointKey = DELETIONS_CHECKPOINT_KEY;
  const checkpoint = await getCheckpoint(db, checkpointKey);

  let cursor: SyncCursorInput | undefined = checkpoint
    ? { updatedAt: checkpoint.updatedAt, syncSeq: checkpoint.syncSeq }
    : undefined;
  let totalProcessed = 0;
  const invalidatedKeys = new Set<string>();

  // See syncTable: catch a wipe that ran while a page was on the wire.
  const startEpoch = getWipeEpoch();

  let hasMore = true;
  while (hasMore) {
    // Sign-out is wiping local data: stop before this page writes the old
    // user's rows back (mirrors the drainer's guard).
    if (isSigningOut() || getWipeEpoch() !== startEpoch) return;
    const response = await graphqlFetch<{ syncDeletions: SyncDeletionsResult }>(SYNC_DELETIONS_QUERY, {
      cursor,
      limit: PAGE_LIMIT,
    });
    const result = response.syncDeletions;

    if (isSigningOut() || getWipeEpoch() !== startEpoch) return;

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
 * Snapshot-bootstrap phase (runs BEFORE deletions). For each enabled scope that
 * is FRESH (no checkpoint on either board table) and still under the attempt cap,
 * warm it from a pre-built artifact instead of paging the whole catalog. Returns
 * the set of scope keys whose paged board-table pull must be SKIPPED this cycle —
 * a scope whose bootstrap failed (and still has attempts left): letting its paged
 * pull run would write a first-page checkpoint and permanently disqualify the
 * snapshot path, so it is skipped so the NEXT cycle retries the snapshot.
 *
 * Eligibility + failure matrix (per scope):
 *   - checkpoint exists on either board table → NOT eligible → normal paged pull.
 *   - attempts ≥ MAX → gave up → normal paged pull.
 *   - manifest `absent` (missing/unparseable) → permanent miss, NO attempt →
 *     normal paged pull.
 *   - manifest `error` (network) → counted attempt → SKIP paged pull this cycle.
 *   - manifest `ok` but no entry for (boardType, layoutId) → permanent miss, NO
 *     attempt → normal paged pull (layout not exported yet).
 *   - download fails/returns null → counted attempt → SKIP paged pull this cycle.
 *   - download throws SnapshotPermanentMissError → NO attempt → normal paged pull.
 *   - import throws (corrupt/short artifact, row-count/format mismatch) → counted
 *     attempt → SKIP paged pull this cycle.
 *   - success → mark done, rewind deletions to min(watermarks); paged pull runs
 *     normally, now a ~1-day delta from the scoped watermark checkpoints.
 * A wipe detected mid-phase bails the whole phase with no attempt (mirrors
 * syncTable). One artifact is downloaded per (boardType, layoutId) and reused
 * across that layout's sizes; all downloads are deleted in a finally.
 *
 * Returns the skip-set (above). Snapshot attribution for
 * ScopeDownloadCompleteInfo.method is NOT threaded through here — it reads the
 * persisted `isBootstrapDone` marker instead, because the completing delta
 * pull can land cycles after the import (see ScopeDownloadCompleteInfo).
 */
async function runBootstrapPhase(
  db: OfflineDatabase,
  queryClient: QueryInvalidator,
  source: SnapshotSource,
  scopes: BoardScope[],
  stampScopeStart: (scopeKey: string) => void,
  onProgress: ((progress: SyncProgress) => void) | undefined,
  onSchemaDrift: SchemaDriftReporter | undefined,
  onSnapshotBootstrapError: SnapshotBootstrapErrorReporter | undefined,
): Promise<Set<string>> {
  const skipPagedPull = new Set<string>();
  const manifestCache: { value?: ManifestResolution } = {};
  // Absent = not yet attempted; `file: null` = download failed (with its cause).
  const downloadByLayout = new Map<
    string,
    { file: { filePath: string } | null; cause: unknown; permanentMiss: boolean }
  >();
  const downloadedPaths = new Set<string>();
  const startEpoch = getWipeEpoch();

  try {
    for (const scope of scopes) {
      if (isSigningOut() || getWipeEpoch() !== startEpoch) break;

      // Duration telemetry starts here — before the eligibility check — so a
      // snapshot scope's durationMs covers its manifest/download/import work.
      stampScopeStart(scope.scopeKey);

      // Eligibility: FRESH on BOTH board tables and under the attempt cap.
      const climbsCheckpoint = await getCheckpoint(db, getCheckpointKey('board_climbs', scope.scopeKey));
      const statsCheckpoint = await getCheckpoint(db, getCheckpointKey('board_climb_stats', scope.scopeKey));
      if (climbsCheckpoint || statsCheckpoint) continue;
      if ((await getBootstrapAttempts(db, scope.scopeKey)) >= MAX_BOOTSTRAP_ATTEMPTS) continue;

      onProgress?.({ phase: 'bootstrap', currentTable: scope.scopeKey, documentsProcessed: 0 });

      const resolution = await resolveManifestOnce(source, manifestCache);
      if (resolution.status === 'absent') continue; // permanent miss, no attempt
      if (resolution.status === 'error') {
        const attempt = await recordBootstrapAttempt(db, scope.scopeKey);
        onSnapshotBootstrapError?.({ scopeKey: scope.scopeKey, stage: 'manifest', attempt, cause: resolution.cause });
        skipPagedPull.add(scope.scopeKey);
        continue;
      }

      // Shared with the pre-download size estimate (snapshot-estimate.ts) so the
      // UI can never quote a number for an artifact this phase would skip.
      const entry = findSnapshotEntry(resolution.manifest, scope.boardType, scope.layoutId);
      if (!entry) continue; // layout not exported yet — permanent miss, no attempt
      // Pre-check the manifest's schemaVersion so a schema-stale artifact is
      // skipped BEFORE the multi-MB download; verifySnapshotMeta re-checks the
      // authoritative value inside the file. Same permanent-miss semantics as
      // SnapshotSchemaStaleError: no attempt, paged crawl runs this cycle, and
      // tonight's export rebuilds at the new schema.
      if (!isSnapshotEntryUsable(entry)) continue;

      const layoutKey = `${scope.boardType}:${scope.layoutId}`;
      // The failure cause is cached alongside the result so a second size of the
      // same layout (which reuses this entry instead of re-downloading) still
      // reports the real error, not null.
      let cachedDownload = downloadByLayout.get(layoutKey);
      if (!cachedDownload) {
        cachedDownload = { file: null, cause: null, permanentMiss: false };
        try {
          cachedDownload.file = (await source.downloadArtifact(entry)) ?? null;
        } catch (error) {
          cachedDownload.cause = error;
          cachedDownload.permanentMiss = error instanceof SnapshotPermanentMissError;
        }
        downloadByLayout.set(layoutKey, cachedDownload);
        if (cachedDownload.file) downloadedPaths.add(cachedDownload.file.filePath);
      }
      const download = cachedDownload.file;
      if (!download) {
        if (cachedDownload.permanentMiss) {
          onSnapshotBootstrapError?.({
            scopeKey: scope.scopeKey,
            stage: 'download',
            attempt: 0,
            cause: cachedDownload.cause,
          });
          continue;
        }
        const attempt = await recordBootstrapAttempt(db, scope.scopeKey);
        onSnapshotBootstrapError?.({
          scopeKey: scope.scopeKey,
          stage: 'download',
          attempt,
          cause: cachedDownload.cause,
        });
        skipPagedPull.add(scope.scopeKey);
        continue;
      }

      try {
        // Imports the scope's rows, stamps both table checkpoints, and rewinds
        // the global deletions cursor to the older table watermark — all in one
        // transaction, so no crash point can separate the imported rows from
        // the tombstone-replay window that must cover them.
        await bootstrapScopeFromSnapshot({
          db,
          scope,
          scopeKey: scope.scopeKey,
          filePath: download.filePath,
          onSchemaDrift,
        });
        await markBootstrapDone(db, scope.scopeKey);
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
        // attempt (the pull is being torn down, not failing).
        if (error instanceof SnapshotWipedError || isSigningOut() || getWipeEpoch() !== startEpoch) break;
        if (error instanceof SnapshotSchemaStaleError) {
          // The artifact predates this client's schema — importing it would
          // NULL-fill newer columns and stamp the cursor past them forever.
          // Permanent miss for this run: no attempt burned, and the scope's
          // paged pull runs NOW (always correct); tonight's export rebuilds the
          // artifact at the new schema for future fresh scopes.
          onSnapshotBootstrapError?.({ scopeKey: scope.scopeKey, stage: 'import', attempt: 0, cause: error });
          continue;
        }
        const attempt = await recordBootstrapAttempt(db, scope.scopeKey);
        onSnapshotBootstrapError?.({ scopeKey: scope.scopeKey, stage: 'import', attempt, cause: error });
        skipPagedPull.add(scope.scopeKey);
      }
    }
  } finally {
    for (const filePath of downloadedPaths) {
      await source.deleteArtifact(filePath).catch(() => {});
    }
  }

  return skipPagedPull;
}

export async function pullSync(
  db: OfflineDatabase,
  queryClient: QueryInvalidator,
  graphqlFetch: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>,
  options?: SyncOptions,
): Promise<void> {
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

  // Phase 0: snapshot bootstrap (BEFORE deletions). Only when an adapter injected
  // snapshot I/O; otherwise this is a pure paged pull, byte-identical to before.
  let skipBootstrapPagedPull: Set<string> = new Set();
  if (options?.snapshotSource && boardScopes.length > 0) {
    onProgress?.({ phase: 'bootstrap', currentTable: null, documentsProcessed: 0 });
    skipBootstrapPagedPull = await runBootstrapPhase(
      db,
      queryClient,
      options.snapshotSource,
      boardScopes,
      stampScopeStart,
      onProgress,
      options.onSchemaDrift,
      options.onSnapshotBootstrapError,
    );
  }

  // Deletions FIRST, table pulls second. This ordering is what makes a
  // delete-then-recreate on the server converge: the tombstone removes the old
  // local row, then the same cycle's table pull upserts the recreated one.
  // Applied after the pulls, a tombstone sharing the recreated row's timestamp
  // would delete data this cycle just wrote, and the strict > cursor would
  // never fetch it again.
  onProgress?.({ phase: 'deletions', currentTable: null, documentsProcessed: 0 });
  await processDeletions(db, queryClient, graphqlFetch, (deletionsProcessed) => {
    totalDocuments = deletionsProcessed;
    onProgress?.({ phase: 'deletions', currentTable: null, documentsProcessed: totalDocuments });
  });

  for (const tableName of USER_DATA_TABLES) {
    onProgress?.({ phase: 'user_data', currentTable: tableName, documentsProcessed: totalDocuments });
    const baseCount = totalDocuments;
    await syncTable(
      db,
      queryClient,
      graphqlFetch,
      tableName,
      undefined,
      (tableProcessed) => {
        totalDocuments = baseCount + tableProcessed;
        onProgress?.({ phase: 'user_data', currentTable: tableName, documentsProcessed: totalDocuments });
      },
      options?.onSchemaDrift,
    );
  }

  // Each enabled board is a "boardType:layoutId:sizeId" scope key (already parsed
  // into boardScopes). currentTable carries the full scope key so a per-board UI
  // can match itself.
  for (const boardScope of boardScopes) {
    const scopeKey = boardScope.scopeKey;
    // No-op when the bootstrap phase already stamped this scope; the paged-only
    // path (no snapshotSource) starts its duration clock here.
    stampScopeStart(scopeKey);
    // A scope whose bootstrap failed this cycle (with attempts still left) skips
    // its paged pull: a first-page checkpoint would permanently disqualify the
    // snapshot path, so the next cycle retries the snapshot instead.
    if (skipBootstrapPagedPull.has(scopeKey)) continue;
    let allTablesReachedTail = true;
    for (const tableName of BOARD_DATA_TABLES) {
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
      // Attribution reads the persisted marker, not this run's bootstrap set:
      // the import and the completing delta pull can land in different cycles
      // (connectivity drop between them), and this event fires exactly once per
      // scope — misreporting that one event as 'paged' would permanently
      // undercount snapshot wins in the rollout comparison.
      options?.onScopeDownloadComplete?.({
        scopeKey,
        method: (await isBootstrapDone(db, scopeKey)) ? 'snapshot' : 'paged',
        durationMs: Date.now() - startedAt,
      });
    }
  }

  onProgress?.({ phase: 'idle', currentTable: null, documentsProcessed: totalDocuments });
}
