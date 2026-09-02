// Board-snapshot export + live stale-artifact refresh (offline-sync Phase 2).
//
// For every (board_type, layout_id) that has climbs, builds a small SQLite file
// carrying ONLY `board_climbs` + `board_climb_stats` (plus a `snapshot_meta`
// watermark table), optionally gzips it, and uploads it to Tigris/S3 under
// `board-snapshots/v1/<boardType>/<layoutId>/<builtAt>.db`. After every artifact
// lands, writes `board-snapshots/v1/manifest.json` LAST so a reader always sees
// a consistent old-or-new manifest. Phase 3 (pull-client) reads that manifest to
// warm a freshly-downloaded board from the artifact instead of paging the whole
// catalog over GraphQL, then resumes an incremental pull from the per-table
// watermarks recorded here.
//
// The row shaping is the SAME code the live sync resolvers use (row-normalize.ts
// + toSqliteValue), read through the SAME drizzle-constructed postgres.js client
// (transparent timestamp parsers), so an artifact row is byte-identical to what a
// live `syncClimbs`/`syncClimbStats` pull would have written. The
// snapshot-export-golden test pins that equivalence.
//
// Reads the PRIMARY database, never a replica: the sync cursor (updated_at,
// sync_seq) is write-time ordered, but a replica snapshot is commit-order
// consistent, so a lagging replica can omit a lower-cursor row while containing
// higher-cursor ones — see the pool call-site comment in runExport.
//
// Structure: a testable core (`exportLayoutSnapshot`, `boardSnapshotDdlStatements`,
// `discoverLayoutPairs`) under a thin CLI (`runExport`). The CLI is only invoked
// when this module is the process entry, so importing it in a test has no side
// effects.

import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql, TransactionSql } from 'postgres';
import {
  MIGRATIONS,
  LATEST_SCHEMA_VERSION,
  TABLE_CONFIGS,
  toSqliteValue,
  multiRowChunkSize,
  parseSnapshotManifest,
  SNAPSHOT_MANIFEST_FORMAT_VERSION,
  type SnapshotManifest,
  type SnapshotManifestEntry,
  type SnapshotGradesArtifact,
  type SnapshotGradesTableName,
  type SnapshotTableName,
} from '@boardsesh/offline-sync';
import { createPool, closePool } from '@boardsesh/db/client';
import { normalizeRow, toIso, type RawRow } from '../graphql/resolvers/sync/row-normalize';
import { uploadToS3, isS3Configured, getPublicUrl, getFromS3Strict, deleteFromS3, listS3Objects } from '../storage/s3';
import { logger } from '../utils/logger';

// --- Constants ----------------------------------------------------------------

// The default S3 prefix everything lands under (`<prefix>/<board>/<layout>/*.db`
// + `<prefix>/manifest.json`). `--key-prefix` overrides it so one run can target
// a parallel prefix — e.g. a gzip transition that publishes `board-snapshots/v1`
// (identity, unchanged for the live fleet) and `board-snapshots/v1-gzip` side by
// side. Each prefix is a self-contained, single-encoding manifest: the merge and
// prune logic below scope entirely to whichever prefix the run targets.
const DEFAULT_SNAPSHOT_KEY_PREFIX = 'board-snapshots/v1';
const LIVE_SNAPSHOT_KEY_PREFIX = 'board-snapshots/v1-gzip';
// A safe key prefix: lowercase alphanumerics separated by single `-`/`/`, no
// leading/trailing separator and no `..`. It's spliced into S3 object keys and
// the manifest path, so validate it (mirrors SAFE_IDENTIFIER's intent for keys).
const SAFE_KEY_PREFIX = /^[a-z0-9]+(?:[/-][a-z0-9]+)*$/;
const manifestKeyForPrefix = (keyPrefix: string): string => `${keyPrefix}/manifest.json`;
const MANIFEST_CACHE_CONTROL = 'public, max-age=300';
const ARTIFACT_CONTENT_TYPE = 'application/x-sqlite3';

// Public base for the manifest's artifact URLs. Tigris serves PUBLIC objects
// only on the bucket's virtual-host domain (https://<bucket>.t3.tigrisfiles.io);
// the S3 endpoint's path-style URL that getPublicUrl builds returns 403 for
// unauthenticated GETs even on a public bucket. When set (no trailing slash
// needed), entry URLs become `${base}/${key}`; unset falls back to getPublicUrl
// for S3-compatible stores whose endpoint serves public reads directly. Read
// lazily (not at module load) so tests can set it per-run.
export function snapshotPublicBaseUrl(): string {
  return (process.env.SNAPSHOT_PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
}

export function publicUrlForKey(key: string): string {
  const publicBase = snapshotPublicBaseUrl();
  return publicBase ? `${publicBase}/${key}` : getPublicUrl('snapshots', key);
}

// How long a superseded (manifest-unreferenced) artifact survives before the
// unfiltered nightly run prunes it. The manifest is CDN-cached for max-age=300,
// but a client may hold a fetched manifest much longer before starting the
// download — 14 days is a generous grace window.
const PRUNE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

// Matches the resolvers' stability window: rows younger than this are left for a
// live incremental pull so the watermark never covers a still-in-flight write.
// Reads the SAME env var the sync resolvers read so both stay in lockstep. A
// blank value (e.g. an unset GitHub Actions `vars.*` passthrough) means unset —
// Number('') would otherwise silently zero the window.
const rawStabilityWindow = process.env.SYNC_STABILITY_WINDOW_SECONDS?.trim();
const parsedStabilityWindow = rawStabilityWindow ? Number(rawStabilityWindow) : 30;
const DEFAULT_STABILITY_WINDOW_SECONDS = Number.isFinite(parsedStabilityWindow) ? parsedStabilityWindow : 30;

// The keyset epoch a client resumes from when a table's snapshot is empty — the
// same sentinel the resolvers echo on a first (cursorless) pull.
const EPOCH_WATERMARK_UPDATED_AT = '1970-01-01T00:00:00.000Z';
const EPOCH_WATERMARK_SYNC_SEQ = '0';

const SNAPSHOT_TABLES: readonly SnapshotTableName[] = ['board_climbs', 'board_climb_stats'];

// Metadata-only row in the whole-layout artifact. It does NOT imply that the
// artifact carries a sync_deletions data table: its watermark is the oldest
// deletion timestamp that may still belong to a transaction invisible to the
// export's REPEATABLE READ snapshot. Existing clients query only their two
// required table names, so an extra snapshot_meta row is backwards-compatible.
const DELETIONS_SNAPSHOT_META_TABLE = 'sync_deletions';
const SNAPSHOT_EXPORT_APPLICATION_PREFIX = 'boardsesh-snapshot-export-';

// The SEPARATE per-layout grades artifact's single table (issue #4310). It is
// not folded into SNAPSHOT_TABLES on purpose: the client verifies a whole-layout
// artifact's `snapshot_meta` against its OWN two-table list and throws
// "snapshot_meta missing row for <table>" on a mismatch, so growing the
// whole-layout file's meta would make an updated client reject every artifact
// published before this change — as a COUNTED import failure, twice, which
// settles the scope onto the paged crawl. Separate file, separate meta, no
// interaction.
const GRADES_SNAPSHOT_TABLES: readonly SnapshotGradesTableName[] = ['board_climb_grades'];

// Every snapshot table's keyset cursor column, read from the SHARED table config
// so the export, the sync resolvers, and the client import can never disagree
// about which column a watermark covers. `board_climb_grades` is the one that
// is not `updated_at`.
function cursorColumnFor(tableName: SnapshotTableName | SnapshotGradesTableName): string {
  const cursorColumn = TABLE_CONFIGS[tableName]?.cursorColumn;
  if (!cursorColumn || !SAFE_IDENTIFIER.test(cursorColumn)) {
    throw new Error(`No safe cursor column configured for snapshot table ${tableName}`);
  }
  return cursorColumn;
}

const SNAPSHOT_META_DDL = `
CREATE TABLE IF NOT EXISTS snapshot_meta (
  table_name TEXT PRIMARY KEY,
  watermark_updated_at TEXT,
  -- Decimal string, like every seq in the sync protocol: a Postgres bigint must
  -- never round-trip through a JS number.
  watermark_sync_seq TEXT,
  row_count INTEGER,
  built_at TEXT,
  schema_version INTEGER,
  format_version INTEGER
);
`.trim();

// Only snake_case identifiers may be spliced into the SELECT column list. The
// column names come from TABLE_CONFIGS (a trusted allowlist), but validating
// keeps the string-built SQL provably injection-free.
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

// --- Types --------------------------------------------------------------------

export type SnapshotTableExportResult = {
  rowCount: number;
  watermarkUpdatedAt: string;
  watermarkSyncSeq: string;
};

/**
 * Stable, bounded reasons an otherwise-valid artifact can omit the optional
 * deletion replay metadata. These values are emitted in production exporter
 * logs, so keep them low-cardinality and never append connection/session data.
 */
export type DeletionReplayFallbackReason =
  | 'observer-pool-capacity'
  | 'activity-probe-failed'
  | 'exporter-transaction-not-observed'
  | 'activity-visibility-incomplete'
  | 'invalid-probe-timestamp';

type DeletionReplayMetadataResult =
  | { deletionsReplayFrom: string; deletionsReplayFallbackReason: null }
  | { deletionsReplayFrom: null; deletionsReplayFallbackReason: DeletionReplayFallbackReason };

export type LayoutSnapshotResult = {
  boardType: string;
  layoutId: number;
  filePath: string;
  builtAt: string;
  schemaVersion: number;
  tables: Record<SnapshotTableName, SnapshotTableExportResult>;
  /**
   * The layout's grades artifact, when one was requested AND the layout has
   * grade rows. Absent for every MoonBoard layout (MoonBoard is outside
   * CROWD_MEAN_BOARDS, so `board_climb_grades` is empty for it by design) and
   * for any run that did not ask for one.
   */
  grades?: LayoutGradesSnapshotResult;
} & DeletionReplayMetadataResult;

export type LayoutGradesSnapshotResult = {
  filePath: string;
  tables: Record<SnapshotGradesTableName, SnapshotTableExportResult>;
};

export type LayoutPair = { boardType: string; layoutId: number };

type SnapshotWatermark = {
  watermarkUpdatedAt: string;
  watermarkSyncSeq: string;
};

// --- DDL ----------------------------------------------------------------------

/**
 * The DDL for a snapshot file: every statement in the client migrations that
 * targets `board_climbs` or `board_climb_stats` (in migration/version order, so a
 * CREATE precedes its ALTERs and indexes), plus `snapshot_meta`. Derived from the
 * shared MIGRATIONS — the single source of truth — so a future column added on the
 * client (e.g. the v2 `characteristics` ALTER) flows into the snapshot with no
 * duplicated DDL here.
 */
export function boardSnapshotDdlStatements(
  tables: readonly (SnapshotTableName | SnapshotGradesTableName)[] = SNAPSHOT_TABLES,
): string[] {
  const referencesSnapshotTable = (statement: string): boolean =>
    tables.some((table) => new RegExp(`\\b${table}\\b`).test(statement));

  const statements: string[] = [];
  for (const migration of [...MIGRATIONS].sort((left, right) => left.version - right.version)) {
    for (const statement of migration.statements) {
      if (referencesSnapshotTable(statement)) statements.push(statement.trim());
    }
  }
  statements.push(SNAPSHOT_META_DDL);
  return statements;
}

// --- Postgres discovery + streaming ------------------------------------------

/** Every (board_type, layout_id) pair that has at least one climb. */
export async function discoverLayoutPairs(sqlClient: Sql, filter?: Partial<LayoutPair>): Promise<LayoutPair[]> {
  const boardCondition = filter?.boardType ? sqlClient`board_type = ${filter.boardType}` : sqlClient`TRUE`;
  const layoutCondition = filter?.layoutId != null ? sqlClient`layout_id = ${filter.layoutId}` : sqlClient`TRUE`;
  const rows = await sqlClient<{ board_type: string; layout_id: number }[]>`
    SELECT DISTINCT board_type, layout_id
    FROM board_climbs
    WHERE ${boardCondition} AND ${layoutCondition}
    ORDER BY board_type, layout_id
  `;
  return rows.map((row) => ({ boardType: String(row.board_type), layoutId: Number(row.layout_id) }));
}

function assertSafeColumns(columns: readonly string[]): void {
  for (const column of columns) {
    if (!SAFE_IDENTIFIER.test(column)) {
      throw new Error(`Refusing to build snapshot SELECT with unsafe column identifier: ${column}`);
    }
  }
}

// Scope predicates matching the resolvers exactly. `now()` is transaction-start
// time and constant across the whole export transaction, so the streamed rows and
// the watermark query below apply the identical stability boundary.
const CLIMBS_WHERE = `board_type = $1 AND layout_id = $2 AND updated_at < now() - make_interval(secs => $3)`;

const STATS_WHERE = `board_type = $1
    AND EXISTS (
      SELECT 1 FROM board_climbs bc
      WHERE bc.uuid = board_climb_stats.climb_uuid AND bc.board_type = $1 AND bc.layout_id = $2
    )
    AND updated_at < now() - make_interval(secs => $3)`;

// Grades have no layout_id, so they are scoped to the layout's climbs through
// the SAME correlated EXISTS the syncClimbGrades resolver uses — import wider
// than the resolver's scope and rows are merely redundant, narrower and a row
// inside the stamped watermark is lost forever.
const GRADES_WHERE = `board_type = $1
    AND EXISTS (
      SELECT 1 FROM board_climbs bc
      WHERE bc.uuid = board_climb_grades.climb_uuid AND bc.board_type = $1 AND bc.layout_id = $2
    )
    AND computed_at < now() - make_interval(secs => $3)`;

function whereClauseFor(tableName: SnapshotTableName | SnapshotGradesTableName): string {
  switch (tableName) {
    case 'board_climbs':
      return CLIMBS_WHERE;
    case 'board_climb_stats':
      return STATS_WHERE;
    case 'board_climb_grades':
      return GRADES_WHERE;
  }
}

/**
 * Whether at least `threshold` stable rows landed after one manifest watermark.
 *
 * This is deliberately a bounded existence probe, not COUNT(*): the scheduled
 * live-prefix scan only needs to know whether a client would hit a full 500-row
 * GraphQL page after importing the artifact. With the board-leading cursor
 * indexes this stops as soon as the threshold is reached, even when a bulk
 * catalog refresh touched hundreds of thousands of rows.
 */
async function hasDeltaAtThreshold(params: {
  sqlClient: Sql;
  pair: LayoutPair;
  tableName: SnapshotTableName | SnapshotGradesTableName;
  watermark: SnapshotWatermark;
  threshold: number;
}): Promise<boolean> {
  const { sqlClient, pair, tableName, watermark, threshold } = params;
  const cursorColumn = cursorColumnFor(tableName);
  const rows = await sqlClient.unsafe(
    `SELECT 1
     FROM ${tableName}
     WHERE ${whereClauseFor(tableName)}
       AND (${cursorColumn}, sync_seq) > ($4::timestamp, $5::bigint)
     ORDER BY ${cursorColumn} ASC, sync_seq ASC
     LIMIT $6`,
    [
      pair.boardType,
      pair.layoutId,
      DEFAULT_STABILITY_WINDOW_SECONDS,
      watermark.watermarkUpdatedAt,
      watermark.watermarkSyncSeq,
      threshold,
    ],
  );
  return rows.length >= threshold;
}

type RefreshReason = SnapshotTableName | SnapshotGradesTableName | 'missing-entry' | 'stale-schema';

/** Return the first reason this pair needs a new artifact, or null when current. */
async function layoutRefreshReason(params: {
  sqlClient: Sql;
  pair: LayoutPair;
  previousEntry: SnapshotManifestEntry | undefined;
  threshold: number;
  includeGrades: boolean;
}): Promise<RefreshReason | null> {
  const { sqlClient, pair, previousEntry, threshold, includeGrades } = params;
  if (!previousEntry) return 'missing-entry';
  if (previousEntry.schemaVersion < LATEST_SCHEMA_VERSION) return 'stale-schema';
  if (includeGrades && previousEntry.grades && previousEntry.grades.schemaVersion < LATEST_SCHEMA_VERSION) {
    return 'stale-schema';
  }

  const tableWatermarks: Array<{
    tableName: SnapshotTableName | SnapshotGradesTableName;
    watermark: SnapshotWatermark;
  }> = [
    { tableName: 'board_climbs', watermark: previousEntry.tables.board_climbs },
    { tableName: 'board_climb_stats', watermark: previousEntry.tables.board_climb_stats },
  ];
  if (includeGrades) {
    tableWatermarks.push({
      tableName: 'board_climb_grades',
      // No grades artifact can mean either "this layout has no grades" or "the
      // entry predates grades artifacts". Probe from epoch and only rebuild
      // once there are enough rows to replace a full paged response; this keeps
      // permanently grade-less MoonBoard layouts a cheap no-op.
      watermark: previousEntry.grades?.tables.board_climb_grades ?? {
        watermarkUpdatedAt: EPOCH_WATERMARK_UPDATED_AT,
        watermarkSyncSeq: EPOCH_WATERMARK_SYNC_SEQ,
      },
    });
  }

  for (const { tableName, watermark } of tableWatermarks) {
    if (await hasDeltaAtThreshold({ sqlClient, pair, tableName, watermark, threshold })) {
      return tableName;
    }
  }
  return null;
}

/**
 * Stream one table's scoped rows from Postgres through the shared row shaping into
 * the SQLite artifact, batched into multi-row INSERTs. Returns the number of rows
 * written; the watermark is computed separately (see `tableWatermark`) from the
 * same repeatable-read snapshot.
 */
async function streamTableIntoSqlite(
  tx: TransactionSql,
  sqliteDb: DatabaseSync,
  tableName: SnapshotTableName | SnapshotGradesTableName,
  columns: readonly string[],
  whereClause: string,
  params: (string | number)[],
  streamBatchSize: number,
): Promise<number> {
  assertSafeColumns(columns);
  const selectSql = `SELECT ${columns.join(', ')} FROM ${tableName} WHERE ${whereClause}`;
  const chunkSize = multiRowChunkSize(columns.length);
  const insertSqlByRowCount = new Map<number, string>();
  const insertSqlFor = (rowCount: number): string => {
    let cached = insertSqlByRowCount.get(rowCount);
    if (!cached) {
      const rowPlaceholder = `(${columns.map(() => '?').join(', ')})`;
      const valuesClause = Array.from({ length: rowCount }, () => rowPlaceholder).join(', ');
      cached = `INSERT OR REPLACE INTO ${tableName} (${columns.join(', ')}) VALUES ${valuesClause}`;
      insertSqlByRowCount.set(rowCount, cached);
    }
    return cached;
  };

  let rowCount = 0;
  const pending: RawRow[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    for (let chunkStart = 0; chunkStart < pending.length; chunkStart += chunkSize) {
      const chunk = pending.slice(chunkStart, chunkStart + chunkSize);
      const values = chunk.flatMap((row) => columns.map((column) => toSqliteValue(row[column])));
      sqliteDb.prepare(insertSqlFor(chunk.length)).run(...values);
    }
    pending.length = 0;
  };

  for await (const batch of tx.unsafe(selectSql, params).cursor(streamBatchSize)) {
    for (const rawRow of batch) {
      pending.push(normalizeRow(rawRow as RawRow));
      rowCount += 1;
    }
    flush();
  }
  flush();
  return rowCount;
}

/**
 * Compute a table's watermark (the greatest `(updated_at, sync_seq)` keyset over
 * the scoped rows) inside the same transaction/snapshot as the row stream, so it
 * never covers a row the artifact omitted. Postgres orders the timestamps as real
 * timestamps — never string-compared in JS, which would misorder mixed sub-second
 * precision. Empty scope → the epoch sentinel, so a client resumes from the start.
 */
async function tableWatermark(
  tx: TransactionSql,
  tableName: SnapshotTableName | SnapshotGradesTableName,
  whereClause: string,
  params: (string | number)[],
): Promise<{ watermarkUpdatedAt: string; watermarkSyncSeq: string }> {
  const cursorColumn = cursorColumnFor(tableName);
  const rows = await tx.unsafe(
    `SELECT ${cursorColumn} AS cursor_at, sync_seq
     FROM ${tableName}
     WHERE ${whereClause}
     ORDER BY ${cursorColumn} DESC, sync_seq DESC
     LIMIT 1`,
    params,
  );
  const watermarkRow = rows[0] as unknown as { cursor_at: unknown; sync_seq: unknown } | undefined;
  if (!watermarkRow) {
    return { watermarkUpdatedAt: EPOCH_WATERMARK_UPDATED_AT, watermarkSyncSeq: EPOCH_WATERMARK_SYNC_SEQ };
  }
  return {
    watermarkUpdatedAt: toIso(watermarkRow.cursor_at),
    watermarkSyncSeq: String(watermarkRow.sync_seq),
  };
}

type DeletionReplayProbeRow = {
  export_xact_start: unknown;
  oldest_same_role_xact_start: unknown;
  visibility_established: boolean;
};

function normalizedProbeTimestamp(rawTimestamp: unknown): { iso: string; timestampMs: number } | null {
  if (rawTimestamp === null || rawTimestamp === undefined) return null;
  try {
    const timestampMs = Date.parse(toIso(rawTimestamp));
    if (!Number.isFinite(timestampMs)) return null;
    return { iso: new Date(timestampMs).toISOString(), timestampMs };
  } catch {
    return null;
  }
}

/**
 * Pick the oldest safe replay bound. Export `builtAt` is included deliberately:
 * it is chosen before any layout transaction, so it both supplies a client-side
 * validation ceiling and safely widens later layouts whose transaction clock is
 * more than one stability window after the run began.
 */
export function selectDeletionReplayBoundary(params: {
  artifactBuiltAt: unknown;
  exportTransactionStartedAt: unknown;
  oldestActiveTransactionStartedAt: unknown;
  stabilityWindowSeconds: number;
  visibilityEstablished: boolean;
}): string | null {
  if (!params.visibilityEstablished) return null;
  const artifactBuiltAt = normalizedProbeTimestamp(params.artifactBuiltAt);
  const exportTransactionStartedAt = normalizedProbeTimestamp(params.exportTransactionStartedAt);
  if (!artifactBuiltAt || !exportTransactionStartedAt) return null;

  const stabilityBoundaryMs =
    exportTransactionStartedAt.timestampMs - Math.max(0, params.stabilityWindowSeconds) * 1000;
  const oldestActiveTransaction = normalizedProbeTimestamp(params.oldestActiveTransactionStartedAt);
  const replayFromMs = Math.min(
    artifactBuiltAt.timestampMs,
    stabilityBoundaryMs,
    oldestActiveTransaction?.timestampMs ?? Number.POSITIVE_INFINITY,
  );
  return new Date(replayFromMs).toISOString();
}

/**
 * Observe the open export transaction from a SECOND primary-pool connection.
 * The export connection has run only SET commands at this point, so its
 * REPEATABLE READ data snapshot is not fixed yet. Sampling activity first and
 * reading artifact rows second closes the opposite ordering's race: a long
 * delete cannot commit after the RR snapshot is fixed but before pg_stat_activity
 * notices it has disappeared.
 *
 * Fail closed. PostgreSQL exposes full activity details to ordinary users only
 * for sessions owned by the same role. Production writers and this exporter use
 * that one role; ANY other-role client in this database, hidden/disabled peer
 * state, a prepared transaction (not represented in pg_stat_activity), a
 * missing exporter row, or a query/pool failure returns a bounded fallback
 * reason. The artifact then omits this optional row and clients use the older
 * scoped-row watermark rewind. `runExport` logs the boundary or that stable
 * reason for every layout without exposing peer-session details.
 */
async function probeDeletionReplayBoundary(params: {
  sqlClient: Sql;
  applicationName: string;
  artifactBuiltAt: string;
  stabilityWindowSeconds: number;
}): Promise<DeletionReplayMetadataResult> {
  const { sqlClient, applicationName, artifactBuiltAt, stabilityWindowSeconds } = params;
  // The observer must not queue behind the export connection forever. The
  // production primary pool has max=10; a generic/max=1 caller still gets a
  // valid artifact, just without this optional optimization.
  const configuredPoolMax = (sqlClient as Sql & { options?: { max?: unknown } }).options?.max;
  if (typeof configuredPoolMax !== 'number' || configuredPoolMax < 2) {
    return { deletionsReplayFrom: null, deletionsReplayFallbackReason: 'observer-pool-capacity' };
  }
  try {
    const rows = await sqlClient.unsafe(
      `SELECT
         exporter.xact_start AS export_xact_start,
         (
           SELECT min(peer.xact_start)
           FROM pg_stat_activity peer
           WHERE peer.datname = exporter.datname
             AND peer.usesysid = exporter.usesysid
             AND peer.backend_type = 'client backend'
             AND peer.pid NOT IN (exporter.pid, pg_backend_pid())
             AND peer.xact_start IS NOT NULL
         ) AS oldest_same_role_xact_start,
         current_setting('track_activities', true) = 'on'
           AND exporter.xact_start IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
             FROM pg_prepared_xacts prepared
             WHERE prepared.database = exporter.datname
           )
           AND NOT EXISTS (
             SELECT 1
             FROM pg_stat_activity peer
             WHERE peer.datname = exporter.datname
               AND peer.backend_type = 'client backend'
               AND peer.pid NOT IN (exporter.pid, pg_backend_pid())
               AND (
                 peer.usesysid IS DISTINCT FROM exporter.usesysid
                 OR peer.state IS NULL
                 OR peer.state = 'disabled'
                 OR (peer.state <> 'idle' AND peer.xact_start IS NULL)
               )
           ) AS visibility_established
       FROM pg_stat_activity exporter
       WHERE exporter.datname = current_database()
         AND exporter.backend_type = 'client backend'
         AND exporter.application_name = $1`,
      [applicationName],
    );
    if (rows.length !== 1) {
      return {
        deletionsReplayFrom: null,
        deletionsReplayFallbackReason: 'exporter-transaction-not-observed',
      };
    }
    const probe = rows[0] as unknown as DeletionReplayProbeRow;
    if (probe.visibility_established !== true) {
      return {
        deletionsReplayFrom: null,
        deletionsReplayFallbackReason: 'activity-visibility-incomplete',
      };
    }
    const deletionsReplayFrom = selectDeletionReplayBoundary({
      artifactBuiltAt,
      exportTransactionStartedAt: probe.export_xact_start,
      oldestActiveTransactionStartedAt: probe.oldest_same_role_xact_start,
      stabilityWindowSeconds,
      visibilityEstablished: true,
    });
    if (!deletionsReplayFrom) {
      return { deletionsReplayFrom: null, deletionsReplayFallbackReason: 'invalid-probe-timestamp' };
    }
    return { deletionsReplayFrom, deletionsReplayFallbackReason: null };
  } catch {
    return { deletionsReplayFrom: null, deletionsReplayFallbackReason: 'activity-probe-failed' };
  }
}

// --- Layout snapshot build ----------------------------------------------------

/** Writes required table metadata plus the optional deletion replay boundary. */
function writeSnapshotMeta(
  sqliteDb: DatabaseSync,
  builtAt: string,
  tables: Record<string, SnapshotTableExportResult>,
  deletionsReplayFrom?: string | null,
): void {
  const insertMeta = sqliteDb.prepare(
    `INSERT OR REPLACE INTO snapshot_meta
      (table_name, watermark_updated_at, watermark_sync_seq, row_count, built_at, schema_version, format_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [tableName, tableResult] of Object.entries(tables)) {
    insertMeta.run(
      tableName,
      tableResult.watermarkUpdatedAt,
      tableResult.watermarkSyncSeq,
      tableResult.rowCount,
      builtAt,
      LATEST_SCHEMA_VERSION,
      SNAPSHOT_MANIFEST_FORMAT_VERSION,
    );
  }
  if (deletionsReplayFrom) {
    insertMeta.run(
      DELETIONS_SNAPSHOT_META_TABLE,
      deletionsReplayFrom,
      EPOCH_WATERMARK_SYNC_SEQ,
      0,
      builtAt,
      LATEST_SCHEMA_VERSION,
      SNAPSHOT_MANIFEST_FORMAT_VERSION,
    );
  }
}

/**
 * Build ONE (boardType, layoutId) SQLite snapshot at `filePath`, and — when
 * `gradesFilePath` is given and the layout has grade rows — a SECOND, separate
 * artifact carrying only `board_climb_grades`.
 *
 * Every table and every watermark is read inside a SINGLE REPEATABLE READ
 * transaction, so the whole-layout artifact, the grades artifact, and all four
 * watermarks come from one consistent database snapshot. That matters for the
 * grades file specifically: its rows are scoped by an EXISTS over
 * `board_climbs`, so a climb committed between the two reads would otherwise
 * make the grade rows and the climbs they hang off disagree.
 *
 * The whole-layout DATA tables remain byte-for-byte what they were before
 * grades existed. Its additive metadata-only sync_deletions row is safe for old
 * clients because they query the two required snapshot_meta rows by name and
 * ignore extras.
 */
export async function exportLayoutSnapshot(params: {
  sqlClient: Sql;
  boardType: string;
  layoutId: number;
  filePath: string;
  builtAt: string;
  /** Where to write the layout's grades artifact. Omit to skip grades entirely. */
  gradesFilePath?: string;
  stabilityWindowSeconds?: number;
  streamBatchSize?: number;
}): Promise<LayoutSnapshotResult> {
  const { sqlClient, boardType, layoutId, filePath, builtAt, gradesFilePath } = params;
  const stabilityWindowSeconds = params.stabilityWindowSeconds ?? DEFAULT_STABILITY_WINDOW_SECONDS;
  const streamBatchSize = params.streamBatchSize ?? 5000;
  const scopeParams: (string | number)[] = [boardType, layoutId, stabilityWindowSeconds];

  const sqliteDb = new DatabaseSync(filePath);
  const gradesDb = gradesFilePath ? new DatabaseSync(gradesFilePath) : null;
  try {
    for (const statement of boardSnapshotDdlStatements()) {
      sqliteDb.exec(statement);
    }
    if (gradesDb) {
      for (const statement of boardSnapshotDdlStatements(GRADES_SNAPSHOT_TABLES)) {
        gradesDb.exec(statement);
      }
    }

    sqliteDb.exec('BEGIN');
    gradesDb?.exec('BEGIN');
    const streamed = await sqlClient.begin(async (tx) => {
      await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const exportApplicationName = `${SNAPSHOT_EXPORT_APPLICATION_PREFIX}${randomUUID()}`;
      // SET does not acquire the REPEATABLE READ data snapshot. The second-
      // connection activity probe MUST finish before the first artifact SELECT;
      // see probeDeletionReplayBoundary for the commit-between-sample race this
      // ordering closes. The generated value contains only a fixed prefix + UUID.
      await tx.unsafe(`SET LOCAL application_name = '${exportApplicationName}'`);
      const deletionReplayMetadata = await probeDeletionReplayBoundary({
        sqlClient,
        applicationName: exportApplicationName,
        artifactBuiltAt: builtAt,
        stabilityWindowSeconds,
      });

      const climbColumns = TABLE_CONFIGS.board_climbs.localColumns;
      const statsColumns = TABLE_CONFIGS.board_climb_stats.localColumns;

      const climbRowCount = await streamTableIntoSqlite(
        tx,
        sqliteDb,
        'board_climbs',
        climbColumns,
        CLIMBS_WHERE,
        scopeParams,
        streamBatchSize,
      );
      const climbWatermark = await tableWatermark(tx, 'board_climbs', CLIMBS_WHERE, scopeParams);

      const statsRowCount = await streamTableIntoSqlite(
        tx,
        sqliteDb,
        'board_climb_stats',
        statsColumns,
        STATS_WHERE,
        scopeParams,
        streamBatchSize,
      );
      const statsWatermark = await tableWatermark(tx, 'board_climb_stats', STATS_WHERE, scopeParams);

      const tables = {
        board_climbs: { rowCount: climbRowCount, ...climbWatermark },
        board_climb_stats: { rowCount: statsRowCount, ...statsWatermark },
      } satisfies Record<SnapshotTableName, SnapshotTableExportResult>;

      if (!gradesDb) return { tables, gradesTables: null, ...deletionReplayMetadata };

      const gradesRowCount = await streamTableIntoSqlite(
        tx,
        gradesDb,
        'board_climb_grades',
        TABLE_CONFIGS.board_climb_grades.localColumns,
        GRADES_WHERE,
        scopeParams,
        streamBatchSize,
      );
      const gradesWatermark = await tableWatermark(tx, 'board_climb_grades', GRADES_WHERE, scopeParams);

      return {
        tables,
        ...deletionReplayMetadata,
        gradesTables: {
          board_climb_grades: { rowCount: gradesRowCount, ...gradesWatermark },
        } satisfies Record<SnapshotGradesTableName, SnapshotTableExportResult>,
      };
    });

    writeSnapshotMeta(sqliteDb, builtAt, streamed.tables, streamed.deletionsReplayFrom);
    sqliteDb.exec('COMMIT');

    let grades: LayoutGradesSnapshotResult | undefined;
    if (gradesDb && streamed.gradesTables) {
      writeSnapshotMeta(gradesDb, builtAt, streamed.gradesTables);
      gradesDb.exec('COMMIT');
      // A layout with no grade rows publishes nothing at all — every MoonBoard
      // layout lands here, because MoonBoard is deliberately outside
      // CROWD_MEAN_BOARDS (docs/boardsesh-grade.md).
      if (streamed.gradesTables.board_climb_grades.rowCount > 0) {
        grades = { filePath: gradesFilePath as string, tables: streamed.gradesTables };
      }
    }

    const deletionReplayMetadata: DeletionReplayMetadataResult =
      streamed.deletionsReplayFrom === null
        ? {
            deletionsReplayFrom: null,
            deletionsReplayFallbackReason: streamed.deletionsReplayFallbackReason,
          }
        : { deletionsReplayFrom: streamed.deletionsReplayFrom, deletionsReplayFallbackReason: null };

    return {
      boardType,
      layoutId,
      filePath,
      builtAt,
      schemaVersion: LATEST_SCHEMA_VERSION,
      tables: streamed.tables,
      ...deletionReplayMetadata,
      ...(grades ? { grades } : {}),
    };
  } catch (error) {
    for (const database of [sqliteDb, gradesDb]) {
      try {
        database?.exec('ROLLBACK');
      } catch {
        // No open transaction to roll back — ignore.
      }
    }
    throw error;
  } finally {
    sqliteDb.close();
    gradesDb?.close();
  }
}

// --- CLI ----------------------------------------------------------------------

type ExportOptions = {
  dryRun: boolean;
  // Off by default: upload artifacts uncompressed until transparent
  // Content-Encoding: gzip decode is verified on-device (see the encoding
  // comment in the pair loop).
  gzip: boolean;
  keyPrefix: string;
  /** Rebuild only layouts with at least this many rows past a manifest watermark. */
  refreshThreshold?: number;
  boardFilter?: string;
  layoutFilter?: number;
};

function parseArgs(argv: string[]): ExportOptions {
  const options: ExportOptions = { dryRun: false, gzip: false, keyPrefix: DEFAULT_SNAPSHOT_KEY_PREFIX };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue; // vp forwards a literal `--` into argv
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--gzip') {
      options.gzip = true;
    } else if (arg === '--key-prefix') {
      options.keyPrefix = parseKeyPrefix(argv[(index += 1)]);
    } else if (arg.startsWith('--key-prefix=')) {
      options.keyPrefix = parseKeyPrefix(arg.slice('--key-prefix='.length));
    } else if (arg === '--refresh-threshold') {
      options.refreshThreshold = parseRefreshThreshold(argv[(index += 1)]);
    } else if (arg.startsWith('--refresh-threshold=')) {
      options.refreshThreshold = parseRefreshThreshold(arg.slice('--refresh-threshold='.length));
    } else if (arg === '--board') {
      options.boardFilter = parseBoardFilter(argv[(index += 1)]);
    } else if (arg.startsWith('--board=')) {
      options.boardFilter = parseBoardFilter(arg.slice('--board='.length));
    } else if (arg === '--layout') {
      options.layoutFilter = parseLayoutFilter(argv[(index += 1)]);
    } else if (arg.startsWith('--layout=')) {
      options.layoutFilter = parseLayoutFilter(arg.slice('--layout='.length));
    }
  }
  return options;
}

function parseBoardFilter(raw: string | undefined): string {
  if (!raw || raw.startsWith('--')) {
    throw new Error(`--board expects a board type, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

function parseKeyPrefix(raw: string | undefined): string {
  const keyPrefix = raw?.trim().replace(/\/+$/, '');
  if (!keyPrefix || !SAFE_KEY_PREFIX.test(keyPrefix)) {
    // A bad prefix would either silently write to the wrong place or splice an
    // unsafe value into S3 keys — fail loudly instead.
    throw new Error(`--key-prefix expects a safe key like "board-snapshots/v1", got ${JSON.stringify(raw)}`);
  }
  return keyPrefix;
}

function parseLayoutFilter(raw: string | undefined): number {
  const layoutId = Number(raw);
  if (!Number.isInteger(layoutId)) {
    // A NaN filter would silently match nothing and export zero layouts.
    throw new Error(`--layout expects an integer layout id, got ${JSON.stringify(raw)}`);
  }
  return layoutId;
}

function parseRefreshThreshold(raw: string | undefined): number {
  const threshold = Number(raw);
  if (!Number.isSafeInteger(threshold) || threshold <= 0) {
    throw new Error(`--refresh-threshold expects a positive integer, got ${JSON.stringify(raw)}`);
  }
  return threshold;
}

function buildManifestEntry(
  result: LayoutSnapshotResult,
  upload: {
    url: string;
    key: string;
    bytes: number;
    // Pre-compression size of the artifact: equal to `bytes` on an identity
    // upload, several times larger under --gzip. Clients use it as the progress
    // denominator on downloaders that write decoded bytes with no usable total,
    // and for the exact free-disk-space precheck. Never shown to a user.
    uncompressedBytes: number;
    contentEncoding: 'gzip' | 'identity';
  },
  gradesUpload?: { url: string; key: string; bytes: number; contentEncoding: 'gzip' | 'identity' },
): SnapshotManifestEntry {
  const grades: SnapshotGradesArtifact | undefined =
    gradesUpload && result.grades
      ? {
          key: gradesUpload.key,
          url: gradesUpload.url,
          bytes: gradesUpload.bytes,
          contentEncoding: gradesUpload.contentEncoding,
          builtAt: result.builtAt,
          schemaVersion: result.schemaVersion,
          tables: { board_climb_grades: result.grades.tables.board_climb_grades },
        }
      : undefined;
  return {
    boardType: result.boardType,
    layoutId: result.layoutId,
    key: upload.key,
    url: upload.url,
    bytes: upload.bytes,
    uncompressedBytes: upload.uncompressedBytes,
    contentEncoding: upload.contentEncoding,
    builtAt: result.builtAt,
    schemaVersion: result.schemaVersion,
    tables: {
      board_climbs: result.tables.board_climbs,
      board_climb_stats: result.tables.board_climb_stats,
    },
    // Omitted entirely rather than set to undefined: the manifest is serialized
    // to JSON, and an explicit `"grades": undefined` key is not a thing — but
    // keeping the shape clean makes the golden test's byte comparison honest.
    ...(grades ? { grades } : {}),
  };
}

/**
 * Merge this run's freshly-built entries over the previous manifest's, keyed by
 * (boardType, layoutId). A filtered run (`--board`/`--layout`) rebuilds only a
 * subset, so every previous entry it did not rebuild is preserved verbatim —
 * without this, a filtered run would silently drop every other board from the
 * manifest. Only an unfiltered run has the full picture, so only it may drop
 * entries whose layout no longer has climbs in the database: it passes the
 * discovered pairs as `livePairs`; filtered runs pass null and keep everything.
 */
export function mergeManifestEntries(params: {
  previousEntries: SnapshotManifestEntry[];
  newEntries: SnapshotManifestEntry[];
  livePairs: LayoutPair[] | null;
}): SnapshotManifestEntry[] {
  const pairKey = (boardType: string, layoutId: number): string => `${boardType}:${layoutId}`;
  const liveKeys = params.livePairs
    ? new Set(params.livePairs.map((pair) => pairKey(pair.boardType, pair.layoutId)))
    : null;

  const merged = new Map<string, SnapshotManifestEntry>();
  for (const previousEntry of params.previousEntries) {
    const entryKey = pairKey(previousEntry.boardType, previousEntry.layoutId);
    // Layout vanished from the DB — drop its entry (unfiltered runs only). A
    // failed layout is still discovered, so its previous entry survives here.
    if (liveKeys && !liveKeys.has(entryKey)) continue;
    merged.set(entryKey, previousEntry);
  }
  for (const newEntry of params.newEntries) {
    merged.set(pairKey(newEntry.boardType, newEntry.layoutId), newEntry);
  }
  return [...merged.values()].sort(
    (left, right) => left.boardType.localeCompare(right.boardType) || left.layoutId - right.layoutId,
  );
}

/**
 * Fetch + validate the currently-published manifest. Called BEFORE any artifact
 * upload, so a fatal outcome aborts the run with S3 completely untouched.
 *
 * Failure matrix (the merge needs the previous entries — a filtered run to
 * preserve every other board, an unfiltered run to preserve failed layouts —
 * so guessing "empty" on a broken read could drop them from the manifest):
 *
 *   object missing (NoSuchKey/404)   → null, proceed (legitimately a first run)
 *   S3 read error (anything else)    → THROW — fatal on filtered AND unfiltered
 *   present but invalid JSON/shape   → filtered: THROW (the run cannot
 *                                      reconstruct the entries it would drop);
 *                                      unfiltered: warn + merge against empty
 *                                      (it rebuilds every live layout anyway —
 *                                      only vanished layouts' entries are lost,
 *                                      and those drop regardless)
 */
async function fetchPreviousManifest(options: {
  isFilteredRun: boolean;
  manifestKey: string;
}): Promise<SnapshotManifest | null> {
  const manifestObject = await getFromS3Strict('snapshots', options.manifestKey);
  if (!manifestObject) {
    logger.warn('[export-snapshots] no previous manifest on S3 (first run?) — merging against empty');
    return null;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of manifestObject.stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  let parsed: SnapshotManifest | null = null;
  let invalidReason: string | null = null;
  try {
    parsed = parseSnapshotManifest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!parsed) invalidReason = 'failed schema validation';
  } catch (error) {
    invalidReason = error instanceof Error ? error.message : String(error);
  }
  if (invalidReason) {
    if (options.isFilteredRun) {
      throw new Error(
        `previous manifest at ${options.manifestKey} is invalid (${invalidReason}); a filtered run cannot merge safely — aborting before any upload`,
      );
    }
    logger.warn(
      '[export-snapshots] previous manifest invalid — unfiltered run rebuilds everything, merging against empty',
      {
        reason: invalidReason,
      },
    );
  }
  return parsed;
}

/**
 * Delete superseded artifacts under the snapshot prefix: objects that are (a)
 * not referenced by the manifest just written and (b) older than the grace
 * window (a CDN-cached manifest, max-age=300, or a client holding a fetched
 * manifest may still point at a previous run's artifacts for a while). Only a
 * fully-successful UNFILTERED run calls this — it is the only run whose merged
 * manifest provably references every artifact that must survive. Defensive by
 * design: any prune failure is logged and swallowed, never failing the run.
 */
async function pruneStaleArtifacts(manifest: SnapshotManifest, nowMs: number, keyPrefix: string): Promise<void> {
  try {
    const referencedKeys = new Set<string>(manifest.entries.map((entry) => entry.key));
    // Grades artifacts live under the same prefix but are NOT in `entries`, so
    // without this the 14-day grace window would start deleting live grades
    // files out from under every client holding the current manifest.
    for (const entry of manifest.entries) {
      if (entry.grades) referencedKeys.add(entry.grades.key);
    }
    referencedKeys.add(manifestKeyForPrefix(keyPrefix));
    const cutoffMs = nowMs - PRUNE_GRACE_MS;

    const objects = await listS3Objects('snapshots', `${keyPrefix}/`);
    let prunedCount = 0;
    for (const object of objects) {
      if (referencedKeys.has(object.key)) continue;
      if (!object.lastModified || object.lastModified.getTime() >= cutoffMs) continue;
      try {
        await deleteFromS3('snapshots', object.key);
        prunedCount += 1;
      } catch (error) {
        logger.warn('[export-snapshots] failed to prune stale artifact — continuing', {
          key: object.key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    logger.info('[export-snapshots] prune complete', { scanned: objects.length, pruned: prunedCount });
  } catch (error) {
    logger.warn('[export-snapshots] artifact prune failed — continuing (prune is never fatal)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

type LayoutFailure = LayoutPair & { error: string };

export async function runExport(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const builtAt = new Date().toISOString();
  const isFilteredRun = options.boardFilter !== undefined || options.layoutFilter !== undefined;
  const isThresholdRefresh = options.refreshThreshold !== undefined;
  const keyPrefix = options.keyPrefix;
  const manifestKey = manifestKeyForPrefix(keyPrefix);

  // The production fleet reads this prefix as gzip. A mistyped manual command
  // must not replace it with an identity artifact or bypass its replay-boundary
  // publication gate; the workflow always supplies this exact pairing.
  if (keyPrefix === LIVE_SNAPSHOT_KEY_PREFIX && !options.gzip) {
    throw new Error(`--key-prefix ${LIVE_SNAPSHOT_KEY_PREFIX} requires --gzip`);
  }

  if (options.dryRun && isThresholdRefresh) {
    throw new Error(
      '--dry-run cannot be combined with --refresh-threshold: threshold selection requires the live manifest',
    );
  }

  if (!options.dryRun && !isS3Configured('snapshots')) {
    throw new Error(
      'S3 is not configured (AWS_S3_BUCKET_NAME / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY). Use --dry-run to build locally.',
    );
  }

  // PRIMARY pool, deliberately NOT the read-replica seam: the sync cursor
  // (updated_at, sync_seq) is assigned at WRITE time, but an async replica's
  // snapshot is consistent by COMMIT order — a lower-cursor row that commits
  // late (or replays late through replication lag) can be absent from the
  // replica while higher-cursor rows are present. The 30s stability window only
  // absorbs write→commit delay measured on the primary; replica lag stacks on
  // top, and once (commit delay + lag) exceeds the window the exported
  // watermark covers a row the artifact doesn't contain — every bootstrapped
  // client resumes strictly past it and loses it FOREVER. The sync resolvers
  // serve from the primary for the same reason. createPool GUARANTEES the
  // drizzle wrapper is constructed before the raw pool is returned (see
  // packages/db/src/client/postgres.ts), so the pool carries drizzle's
  // transparent timestamp parsers and streamed rows match the resolver shaping.
  // Closed by the CLI entry below, not here — tests share the cached pool.
  const sqlClient = createPool();
  const workDir = mkdtempSync(join(tmpdir(), 'board-snapshots-'));
  const newEntries: SnapshotManifestEntry[] = [];
  const failures: LayoutFailure[] = [];

  try {
    const discoveredPairs = await discoverLayoutPairs(sqlClient, {
      boardType: options.boardFilter,
      layoutId: options.layoutFilter,
    });
    if (discoveredPairs.length === 0 && isFilteredRun) {
      // A filter that matches nothing is an operator error (e.g. --board=kilterr).
      // Exiting zero here would silently leave the filtered board's artifacts
      // stale, so fail loudly instead.
      throw new Error(
        `--board/--layout filter matched no (board_type, layout_id) pairs with climbs ` +
          `(board=${options.boardFilter ?? '*'}, layout=${options.layoutFilter ?? '*'})`,
      );
    }
    logger.info('[export-snapshots] starting run', {
      dryRun: options.dryRun,
      filtered: isFilteredRun,
      gzip: options.gzip,
      keyPrefix,
      pairs: discoveredPairs.length,
      refreshThreshold: options.refreshThreshold ?? null,
      builtAt,
      stabilityWindowSeconds: DEFAULT_STABILITY_WINDOW_SECONDS,
    });

    // Fetch the previous manifest BEFORE any upload: if it is unreadable the
    // run aborts with S3 completely untouched (matrix in fetchPreviousManifest).
    const previousManifest = options.dryRun
      ? null
      : await fetchPreviousManifest({ isFilteredRun: isFilteredRun || isThresholdRefresh, manifestKey });

    let pairs = discoveredPairs;
    if (options.refreshThreshold !== undefined && previousManifest) {
      const previousEntriesByPair = new Map(
        previousManifest.entries.map((entry) => [`${entry.boardType}:${entry.layoutId}`, entry]),
      );
      const stalePairs: LayoutPair[] = [];
      for (const pair of discoveredPairs) {
        const reason = await layoutRefreshReason({
          sqlClient,
          pair,
          previousEntry: previousEntriesByPair.get(`${pair.boardType}:${pair.layoutId}`),
          threshold: options.refreshThreshold,
          includeGrades: options.gzip,
        });
        if (reason) {
          stalePairs.push(pair);
          logger.info('[export-snapshots] threshold refresh selected layout', {
            boardType: pair.boardType,
            layoutId: pair.layoutId,
            reason,
            threshold: options.refreshThreshold,
          });
        }
      }
      pairs = stalePairs;
    }

    // A live-prefix scan that found no full page of post-artifact data is a
    // true no-op: do not churn generatedAt, invalidate the CDN manifest cache,
    // upload objects, or prune. A missing manifest is different — every pair
    // lacks an entry and is rebuilt so the live prefix can recover.
    if (isThresholdRefresh && pairs.length === 0) {
      logger.info('[export-snapshots] threshold refresh complete — no stale layouts', {
        scanned: discoveredPairs.length,
        threshold: options.refreshThreshold,
        keyPrefix,
      });
      return;
    }

    for (const pair of pairs) {
      const startedAt = Date.now();
      const filePath = join(workDir, `${pair.boardType}-${pair.layoutId}.db`);
      const gradesFilePath = join(workDir, `${pair.boardType}-${pair.layoutId}-grades.db`);
      try {
        const result = await exportLayoutSnapshot({
          sqlClient,
          boardType: pair.boardType,
          layoutId: pair.layoutId,
          filePath,
          builtAt,
          // GZIP PASS ONLY. The nightly runs twice — once at the identity `v1`
          // prefix kept as a rollback target, once at `v1-gzip` where the fleet
          // actually points. Publishing grades only in the gzip pass means a
          // rollback to `v1` is exactly today's behaviour (whole file + grades
          // crawl) with no deploy, which is the kill switch for the whole
          // grades path.
          ...(options.gzip ? { gradesFilePath } : {}),
        });

        // The fleet reads only the gzip prefix. Publishing a newly-built live
        // artifact without the conservative deletion replay boundary can turn
        // the next import into a huge JS-native tombstone crawl, so fail this
        // layout closed before any of its objects upload. The per-layout catch
        // preserves its previous immutable manifest entry, successful siblings
        // still publish, and the run fails at the end so the queued refresh
        // retries. Identity (rollback) exports and dry-runs remain observable
        // but ungated.
        if (keyPrefix === LIVE_SNAPSHOT_KEY_PREFIX && !options.dryRun && result.deletionsReplayFrom === null) {
          throw new Error(`live gzip deletion replay boundary unavailable: ${result.deletionsReplayFallbackReason}`);
        }

        const rawBuffer = readFileSync(filePath);
        // Encoding default is IDENTITY until transparent Content-Encoding: gzip
        // decode is verified on-device for both platforms: straight-to-disk
        // downloaders (expo-file-system) may write the raw gzip stream, and the
        // client treats a gzip-on-disk artifact as a failed download (it has no
        // JS gunzip). The manifest's contentEncoding field keeps the client
        // agnostic, so flipping to --gzip later needs no app update.
        const uploadBody = options.gzip ? gzipSync(rawBuffer) : rawBuffer;
        const contentEncoding = options.gzip ? ('gzip' as const) : ('identity' as const);
        // Colon-free key stamp: ISO colons are legal in S3 keys but historically
        // trip CDNs/URL parsers, and getPublicUrl does no percent-encoding.
        const keyStamp = builtAt.replace(/[:.]/g, '-');
        const key = `${keyPrefix}/${pair.boardType}/${pair.layoutId}/${keyStamp}.db`;

        // The grades artifact is a sibling object under the same prefix, never
        // a second `entries` element — findSnapshotEntry first-matches on
        // (boardType, layoutId), so an old client could otherwise pick it up as
        // if it were the whole layout and stamp checkpoints past rows it never
        // imported.
        const gradesKey = `${keyPrefix}/${pair.boardType}/${pair.layoutId}/${keyStamp}-grades.db`;
        const gradesRawBuffer = result.grades ? readFileSync(result.grades.filePath) : null;
        const gradesUploadBody = gradesRawBuffer ? gzipSync(gradesRawBuffer) : null;

        if (options.dryRun) {
          logger.info('[export-snapshots] built (dry-run, not uploaded)', {
            boardType: pair.boardType,
            layoutId: pair.layoutId,
            climbs: result.tables.board_climbs.rowCount,
            stats: result.tables.board_climb_stats.rowCount,
            grades: result.grades?.tables.board_climb_grades.rowCount ?? 0,
            rawBytes: rawBuffer.length,
            uploadBytes: uploadBody.length,
            gradesUploadBytes: gradesUploadBody?.length ?? 0,
            contentEncoding,
            deletionsReplayFrom: result.deletionsReplayFrom,
            deletionsReplayFallbackReason: result.deletionsReplayFallbackReason,
            durationMs: Date.now() - startedAt,
          });
          // publicUrlForKey may fall back to getPublicUrl, which instantiates
          // the S3 client — so only call it when S3 is configured. A dry-run
          // must work with no AWS credentials at all.
          const canBuildPublicUrl = isS3Configured('snapshots') || snapshotPublicBaseUrl() !== '';
          newEntries.push(
            buildManifestEntry(
              result,
              {
                url: canBuildPublicUrl ? publicUrlForKey(key) : `dry-run:${key}`,
                key,
                bytes: uploadBody.length,
                uncompressedBytes: rawBuffer.length,
                contentEncoding,
              },
              gradesUploadBody
                ? {
                    url: canBuildPublicUrl ? publicUrlForKey(gradesKey) : `dry-run:${gradesKey}`,
                    key: gradesKey,
                    bytes: gradesUploadBody.length,
                    contentEncoding: 'gzip' as const,
                  }
                : undefined,
            ),
          );
        } else {
          const uploaded = await uploadToS3(
            'snapshots',
            uploadBody,
            key,
            ARTIFACT_CONTENT_TYPE,
            options.gzip ? { contentEncoding: 'gzip' } : undefined,
          );
          // Uploaded BEFORE the manifest that references it, like the
          // whole-layout artifact — the manifest is always written last, so a
          // reader never sees a key that is not on S3 yet.
          const uploadedGrades = gradesUploadBody
            ? await uploadToS3('snapshots', gradesUploadBody, gradesKey, ARTIFACT_CONTENT_TYPE, {
                contentEncoding: 'gzip',
              })
            : null;
          logger.info('[export-snapshots] uploaded', {
            boardType: pair.boardType,
            layoutId: pair.layoutId,
            climbs: result.tables.board_climbs.rowCount,
            stats: result.tables.board_climb_stats.rowCount,
            grades: result.grades?.tables.board_climb_grades.rowCount ?? 0,
            uploadBytes: uploadBody.length,
            gradesUploadBytes: gradesUploadBody?.length ?? 0,
            contentEncoding,
            key: uploaded.key,
            gradesKey: uploadedGrades?.key ?? null,
            deletionsReplayFrom: result.deletionsReplayFrom,
            deletionsReplayFallbackReason: result.deletionsReplayFallbackReason,
            durationMs: Date.now() - startedAt,
          });
          newEntries.push(
            buildManifestEntry(
              result,
              {
                url: publicUrlForKey(uploaded.key),
                key: uploaded.key,
                bytes: uploadBody.length,
                uncompressedBytes: rawBuffer.length,
                contentEncoding,
              },
              uploadedGrades && gradesUploadBody
                ? {
                    url: publicUrlForKey(uploadedGrades.key),
                    key: uploadedGrades.key,
                    bytes: gradesUploadBody.length,
                    contentEncoding: 'gzip' as const,
                  }
                : undefined,
            ),
          );
        }
      } catch (error) {
        // One bad layout must not block every other board's nightly refresh:
        // record the failure, keep exporting, and fail the run at the very end.
        // The merge below preserves the failed layout's previous manifest entry
        // (its old artifact is immutable, so it stays valid).
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ boardType: pair.boardType, layoutId: pair.layoutId, error: message });
        logger.error('[export-snapshots] layout export failed — continuing with remaining layouts', {
          boardType: pair.boardType,
          layoutId: pair.layoutId,
          error: message,
        });
      } finally {
        rmSync(filePath, { force: true });
        rmSync(gradesFilePath, { force: true });
      }
    }

    if (options.dryRun) {
      logger.info('[export-snapshots] dry-run complete — manifest NOT uploaded', {
        entries: newEntries.length,
        failedLayouts: failures.length,
        totalGzipBytes: newEntries.reduce((sum, entry) => sum + entry.bytes, 0),
      });
    } else {
      // MERGE the previous manifest (fetched up front), never overwrite: a
      // filtered run rebuilds only its own pairs and must not drop everyone
      // else's entries. Written LAST so readers see an atomic old-or-new
      // manifest.
      const mergedEntries = mergeManifestEntries({
        previousEntries: previousManifest?.entries ?? [],
        newEntries,
        // Threshold refreshes only inspect/rebuild a subset. Treat them like a
        // filtered run so a layout below threshold (or vanished since the last
        // full export) can never be dropped from the live manifest.
        livePairs: isFilteredRun || isThresholdRefresh ? null : discoveredPairs,
      });
      const manifest: SnapshotManifest = {
        formatVersion: SNAPSHOT_MANIFEST_FORMAT_VERSION,
        generatedAt: new Date().toISOString(),
        entries: mergedEntries,
      };
      await uploadToS3('snapshots', Buffer.from(JSON.stringify(manifest)), manifestKey, 'application/json', {
        cacheControl: MANIFEST_CACHE_CONTROL,
      });
      logger.info('[export-snapshots] manifest uploaded', {
        entries: mergedEntries.length,
        refreshed: newEntries.length,
        key: manifestKey,
      });

      // Prune superseded artifacts only after a fully-successful unfiltered
      // run: filtered runs lack the full picture, and skipping on failure
      // nights just defers pruning to the next green nightly. Scoped to this
      // run's key prefix, so a gzip run never prunes the identity prefix's
      // artifacts (and vice versa).
      if (!isFilteredRun && !isThresholdRefresh && failures.length === 0) {
        await pruneStaleArtifacts(manifest, Date.now(), keyPrefix);
      }
    }

    if (failures.length > 0) {
      const failedPairs = failures.map((failure) => `${failure.boardType}:${failure.layoutId}`).join(', ');
      throw new Error(`Export failed for ${failures.length} layout(s): ${failedPairs}`);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// Only run when executed directly (`node --import tsx .../export-board-snapshots.ts`),
// never when imported by a test. The pool is closed HERE, not inside runExport:
// tests invoke runExport against the process-wide cached primary pool, and
// closing it there would kill the connection every other test in the worker
// shares.
const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  runExport(process.argv.slice(2))
    .catch((error) => {
      logger.error('[export-snapshots] run failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool();
    });
}
