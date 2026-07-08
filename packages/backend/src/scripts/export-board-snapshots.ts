// Nightly board-snapshot export (offline-sync Phase 2).
//
// For every (board_type, layout_id) that has climbs, builds a small SQLite file
// carrying ONLY `board_climbs` + `board_climb_stats` (plus a `snapshot_meta`
// watermark table), gzips it, and uploads it to Tigris/S3 under
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
  type SnapshotTableName,
} from '@boardsesh/offline-sync';
import { createPool, closePool } from '@boardsesh/db/client';
import { normalizeRow, toIso, type RawRow } from '../graphql/resolvers/sync/row-normalize';
import { uploadToS3, isS3Configured, getPublicUrl, getFromS3Strict, deleteFromS3, listS3Objects } from '../storage/s3';
import { logger } from '../utils/logger';

// --- Constants ----------------------------------------------------------------

const SNAPSHOT_KEY_PREFIX = 'board-snapshots/v1';
const MANIFEST_KEY = `${SNAPSHOT_KEY_PREFIX}/manifest.json`;
const MANIFEST_CACHE_CONTROL = 'public, max-age=300';
const ARTIFACT_CONTENT_TYPE = 'application/x-sqlite3';

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

export type LayoutSnapshotResult = {
  boardType: string;
  layoutId: number;
  filePath: string;
  builtAt: string;
  schemaVersion: number;
  tables: Record<SnapshotTableName, SnapshotTableExportResult>;
};

export type LayoutPair = { boardType: string; layoutId: number };

// --- DDL ----------------------------------------------------------------------

/**
 * The DDL for a snapshot file: every statement in the client migrations that
 * targets `board_climbs` or `board_climb_stats` (in migration/version order, so a
 * CREATE precedes its ALTERs and indexes), plus `snapshot_meta`. Derived from the
 * shared MIGRATIONS — the single source of truth — so a future column added on the
 * client (e.g. the v2 `characteristics` ALTER) flows into the snapshot with no
 * duplicated DDL here.
 */
export function boardSnapshotDdlStatements(): string[] {
  const referencesSnapshotTable = (statement: string): boolean =>
    SNAPSHOT_TABLES.some((table) => new RegExp(`\\b${table}\\b`).test(statement));

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

/**
 * Stream one table's scoped rows from Postgres through the shared row shaping into
 * the SQLite artifact, batched into multi-row INSERTs. Returns the number of rows
 * written; the watermark is computed separately (see `tableWatermark`) from the
 * same repeatable-read snapshot.
 */
async function streamTableIntoSqlite(
  tx: TransactionSql,
  sqliteDb: DatabaseSync,
  tableName: SnapshotTableName,
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
  tableName: SnapshotTableName,
  whereClause: string,
  params: (string | number)[],
): Promise<{ watermarkUpdatedAt: string; watermarkSyncSeq: string }> {
  const rows = await tx.unsafe(
    `SELECT updated_at, sync_seq
     FROM ${tableName}
     WHERE ${whereClause}
     ORDER BY updated_at DESC, sync_seq DESC
     LIMIT 1`,
    params,
  );
  const watermarkRow = rows[0] as unknown as { updated_at: unknown; sync_seq: unknown } | undefined;
  if (!watermarkRow) {
    return { watermarkUpdatedAt: EPOCH_WATERMARK_UPDATED_AT, watermarkSyncSeq: EPOCH_WATERMARK_SYNC_SEQ };
  }
  return {
    watermarkUpdatedAt: toIso(watermarkRow.updated_at),
    watermarkSyncSeq: String(watermarkRow.sync_seq),
  };
}

// --- Layout snapshot build ----------------------------------------------------

/**
 * Build ONE (boardType, layoutId) SQLite snapshot at `filePath`. Both tables and
 * every watermark are read inside a single REPEATABLE READ transaction so climbs,
 * stats, and their watermarks come from one consistent database snapshot.
 */
export async function exportLayoutSnapshot(params: {
  sqlClient: Sql;
  boardType: string;
  layoutId: number;
  filePath: string;
  builtAt: string;
  stabilityWindowSeconds?: number;
  streamBatchSize?: number;
}): Promise<LayoutSnapshotResult> {
  const { sqlClient, boardType, layoutId, filePath, builtAt } = params;
  const stabilityWindowSeconds = params.stabilityWindowSeconds ?? DEFAULT_STABILITY_WINDOW_SECONDS;
  const streamBatchSize = params.streamBatchSize ?? 5000;
  const scopeParams: (string | number)[] = [boardType, layoutId, stabilityWindowSeconds];

  const sqliteDb = new DatabaseSync(filePath);
  try {
    for (const statement of boardSnapshotDdlStatements()) {
      sqliteDb.exec(statement);
    }

    sqliteDb.exec('BEGIN');
    const tables = await sqlClient.begin(async (tx) => {
      await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');

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

      return {
        board_climbs: { rowCount: climbRowCount, ...climbWatermark },
        board_climb_stats: { rowCount: statsRowCount, ...statsWatermark },
      } satisfies Record<SnapshotTableName, SnapshotTableExportResult>;
    });

    const insertMeta = sqliteDb.prepare(
      `INSERT OR REPLACE INTO snapshot_meta
        (table_name, watermark_updated_at, watermark_sync_seq, row_count, built_at, schema_version, format_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const tableName of SNAPSHOT_TABLES) {
      const tableResult = tables[tableName];
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
    sqliteDb.exec('COMMIT');

    return {
      boardType,
      layoutId,
      filePath,
      builtAt,
      schemaVersion: LATEST_SCHEMA_VERSION,
      tables,
    };
  } catch (error) {
    try {
      sqliteDb.exec('ROLLBACK');
    } catch {
      // No open transaction to roll back — ignore.
    }
    throw error;
  } finally {
    sqliteDb.close();
  }
}

// --- CLI ----------------------------------------------------------------------

type ExportOptions = {
  dryRun: boolean;
  boardFilter?: string;
  layoutFilter?: number;
};

function parseArgs(argv: string[]): ExportOptions {
  const options: ExportOptions = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue; // vp forwards a literal `--` into argv
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--board') {
      options.boardFilter = argv[(index += 1)];
    } else if (arg.startsWith('--board=')) {
      options.boardFilter = arg.slice('--board='.length);
    } else if (arg === '--layout') {
      options.layoutFilter = parseLayoutFilter(argv[(index += 1)]);
    } else if (arg.startsWith('--layout=')) {
      options.layoutFilter = parseLayoutFilter(arg.slice('--layout='.length));
    }
  }
  return options;
}

function parseLayoutFilter(raw: string | undefined): number {
  const layoutId = Number(raw);
  if (!Number.isInteger(layoutId)) {
    // A NaN filter would silently match nothing and export zero layouts.
    throw new Error(`--layout expects an integer layout id, got ${JSON.stringify(raw)}`);
  }
  return layoutId;
}

function buildManifestEntry(
  result: LayoutSnapshotResult,
  upload: { url: string; key: string; bytes: number; contentEncoding: 'gzip' | 'identity' },
): SnapshotManifestEntry {
  return {
    boardType: result.boardType,
    layoutId: result.layoutId,
    key: upload.key,
    url: upload.url,
    bytes: upload.bytes,
    contentEncoding: upload.contentEncoding,
    builtAt: result.builtAt,
    schemaVersion: result.schemaVersion,
    tables: {
      board_climbs: result.tables.board_climbs,
      board_climb_stats: result.tables.board_climb_stats,
    },
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
async function fetchPreviousManifest(options: { isFilteredRun: boolean }): Promise<SnapshotManifest | null> {
  const manifestObject = await getFromS3Strict(MANIFEST_KEY);
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
        `previous manifest at ${MANIFEST_KEY} is invalid (${invalidReason}); a filtered run cannot merge safely — aborting before any upload`,
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
async function pruneStaleArtifacts(manifest: SnapshotManifest, nowMs: number): Promise<void> {
  try {
    const referencedKeys = new Set<string>(manifest.entries.map((entry) => entry.key));
    referencedKeys.add(MANIFEST_KEY);
    const cutoffMs = nowMs - PRUNE_GRACE_MS;

    const objects = await listS3Objects(`${SNAPSHOT_KEY_PREFIX}/`);
    let prunedCount = 0;
    for (const object of objects) {
      if (referencedKeys.has(object.key)) continue;
      if (!object.lastModified || object.lastModified.getTime() >= cutoffMs) continue;
      try {
        await deleteFromS3(object.key);
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

  if (!options.dryRun && !isS3Configured()) {
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
    const pairs = await discoverLayoutPairs(sqlClient, {
      boardType: options.boardFilter,
      layoutId: options.layoutFilter,
    });
    if (pairs.length === 0 && isFilteredRun) {
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
      pairs: pairs.length,
      builtAt,
      stabilityWindowSeconds: DEFAULT_STABILITY_WINDOW_SECONDS,
    });

    // Fetch the previous manifest BEFORE any upload: if it is unreadable the
    // run aborts with S3 completely untouched (matrix in fetchPreviousManifest).
    const previousManifest = options.dryRun ? null : await fetchPreviousManifest({ isFilteredRun });

    for (const pair of pairs) {
      const startedAt = Date.now();
      const filePath = join(workDir, `${pair.boardType}-${pair.layoutId}.db`);
      try {
        const result = await exportLayoutSnapshot({
          sqlClient,
          boardType: pair.boardType,
          layoutId: pair.layoutId,
          filePath,
          builtAt,
        });

        const rawBuffer = readFileSync(filePath);
        const gzipped = gzipSync(rawBuffer);
        // Colon-free key stamp: ISO colons are legal in S3 keys but historically
        // trip CDNs/URL parsers, and getPublicUrl does no percent-encoding.
        const keyStamp = builtAt.replace(/[:.]/g, '-');
        const key = `${SNAPSHOT_KEY_PREFIX}/${pair.boardType}/${pair.layoutId}/${keyStamp}.db`;

        if (options.dryRun) {
          logger.info('[export-snapshots] built (dry-run, not uploaded)', {
            boardType: pair.boardType,
            layoutId: pair.layoutId,
            climbs: result.tables.board_climbs.rowCount,
            stats: result.tables.board_climb_stats.rowCount,
            rawBytes: rawBuffer.length,
            gzipBytes: gzipped.length,
            durationMs: Date.now() - startedAt,
          });
          newEntries.push(
            buildManifestEntry(result, {
              // getPublicUrl instantiates the S3 client, so only call it when S3 is
              // configured — a dry-run must work with no AWS credentials at all.
              url: isS3Configured() ? getPublicUrl(key) : `dry-run:${key}`,
              key,
              bytes: gzipped.length,
              contentEncoding: 'gzip',
            }),
          );
        } else {
          const uploaded = await uploadToS3(gzipped, key, ARTIFACT_CONTENT_TYPE, { contentEncoding: 'gzip' });
          logger.info('[export-snapshots] uploaded', {
            boardType: pair.boardType,
            layoutId: pair.layoutId,
            climbs: result.tables.board_climbs.rowCount,
            stats: result.tables.board_climb_stats.rowCount,
            gzipBytes: gzipped.length,
            key: uploaded.key,
            durationMs: Date.now() - startedAt,
          });
          newEntries.push(
            buildManifestEntry(result, {
              url: uploaded.url,
              key: uploaded.key,
              bytes: gzipped.length,
              contentEncoding: 'gzip',
            }),
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
        livePairs: isFilteredRun ? null : pairs,
      });
      const manifest: SnapshotManifest = {
        formatVersion: SNAPSHOT_MANIFEST_FORMAT_VERSION,
        generatedAt: new Date().toISOString(),
        entries: mergedEntries,
      };
      await uploadToS3(Buffer.from(JSON.stringify(manifest)), MANIFEST_KEY, 'application/json', {
        cacheControl: MANIFEST_CACHE_CONTROL,
      });
      logger.info('[export-snapshots] manifest uploaded', {
        entries: mergedEntries.length,
        refreshed: newEntries.length,
        key: MANIFEST_KEY,
      });

      // Prune superseded artifacts only after a fully-successful unfiltered
      // run: filtered runs lack the full picture, and skipping on failure
      // nights just defers pruning to the next green nightly.
      if (!isFilteredRun && failures.length === 0) {
        await pruneStaleArtifacts(manifest, Date.now());
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
