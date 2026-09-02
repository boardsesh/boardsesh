/**
 * Export the board catalogue — the hardware geometry and reference tables that
 * the per-layout climb snapshots deliberately do not carry — as ONE gzip SQLite
 * artifact plus its own manifest, under `board-snapshots/v1-catalog`.
 *
 * Why a separate prefix and manifest rather than a new table in the whole-layout
 * artifact: every shipped mobile binary verifies a downloaded artifact against a
 * two-table `snapshot_meta` and treats an unexpected table as a COUNTED import
 * failure (see snapshot-manifest.ts). Widening SNAPSHOT_TABLES would make an
 * updated client reject every artifact still inside the 14-day prune grace. This
 * artifact is invisible to the fleet: nothing in the client reads this prefix.
 *
 * Its consumer is the seeded developer database image
 * (packages/db/docker/Dockerfile.dev-db), which used to scrape six Aurora APKs
 * at build time to get exactly this data. Geometry is also useful to anyone
 * using the public dataset (docs/board-snapshots-dataset.md) — the climb
 * artifacts reference layout/size/set ids that only mean something with it.
 *
 * Everything here is public, non-personal catalogue data: t-nut coordinates,
 * LED positions, hold sets, product sizes, grade scales. The two columns that
 * link a beta link back to a Boardsesh account (`created_by_user_id`,
 * `tick_uuid`) and to a registered wall (`board_id`) are dropped — they are
 * per-user state, they would not resolve against any other database's ids, and
 * they must not be republished.
 *
 * Usage:
 *   node --import tsx src/scripts/export-board-catalog.ts [--dry-run] [--key-prefix <p>]
 */

import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql, TransactionSql } from 'postgres';
import { createPool, closePool } from '@boardsesh/db/client';
import { normalizeRow, type RawRow } from '../graphql/resolvers/sync/row-normalize';
import { uploadToS3, isS3Configured, deleteFromS3, listS3Objects } from '../storage/s3';
import { logger } from '../utils/logger';
import {
  CATALOG_SNAPSHOT_TABLES,
  CATALOG_SNAPSHOT_EXCLUDED_COLUMNS,
  CATALOG_SNAPSHOT_REDACTED_COLUMNS,
  CATALOG_SNAPSHOT_REDACTED_VALUE,
  type CatalogSnapshotTableName,
} from '@boardsesh/db/catalog-snapshot';
import { publicUrlForKey, snapshotPublicBaseUrl } from './export-board-snapshots';

const DEFAULT_CATALOG_KEY_PREFIX = 'board-snapshots/v1-catalog';
const SAFE_KEY_PREFIX = /^[a-z0-9]+(?:[/-][a-z0-9]+)*$/;
const ARTIFACT_CONTENT_TYPE = 'application/x-sqlite3';
const MANIFEST_CACHE_CONTROL = 'public, max-age=300';
const PRUNE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

export const CATALOG_MANIFEST_FORMAT_VERSION = 1 as const;
export const CATALOG_SCHEMA_VERSION = 1 as const;

// Only snake_case identifiers may be spliced into a SELECT column list. Column
// names come from information_schema, not from user input, but the query is
// built by string concatenation so the guard stays.
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export type CatalogTableStats = { rowCount: number };

export type CatalogManifest = {
  formatVersion: typeof CATALOG_MANIFEST_FORMAT_VERSION;
  generatedAt: string;
  artifact: {
    key: string;
    url: string;
    bytes: number;
    uncompressedBytes: number;
    contentEncoding: 'gzip' | 'identity';
    builtAt: string;
    schemaVersion: number;
    tables: Record<string, CatalogTableStats>;
  };
};

/**
 * Postgres type → SQLite storage class. Arrays and booleans arrive as their
 * `toSqliteValue` shape (JSON text and 0/1), which is what the climb artifacts
 * already do, so a consumer decodes both files the same way.
 */
function sqliteTypeFor(dataType: string): string {
  switch (dataType) {
    case 'integer':
    case 'smallint':
    case 'bigint':
    case 'boolean':
      return 'INTEGER';
    case 'double precision':
    case 'real':
    case 'numeric':
      return 'REAL';
    default:
      return 'TEXT';
  }
}

export type CatalogColumn = {
  name: string;
  dataType: string;
  /** Export a presence marker rather than the value. See CATALOG_SNAPSHOT_REDACTED_COLUMNS. */
  redacted: boolean;
};

export async function catalogColumnsFor(sqlClient: Sql | TransactionSql, tableName: string): Promise<CatalogColumn[]> {
  const rows = await sqlClient<{ column_name: string; data_type: string }[]>`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${tableName}
    ORDER BY ordinal_position
  `;
  if (rows.length === 0) {
    throw new Error(`catalog table ${tableName} has no columns — is the schema migrated?`);
  }
  const excluded = new Set(CATALOG_SNAPSHOT_EXCLUDED_COLUMNS[tableName as CatalogSnapshotTableName] ?? []);
  const redacted = new Set(CATALOG_SNAPSHOT_REDACTED_COLUMNS[tableName as CatalogSnapshotTableName] ?? []);
  const columns = rows
    .filter((row) => !excluded.has(row.column_name))
    .map((row) => ({ name: row.column_name, dataType: row.data_type, redacted: redacted.has(row.column_name) }));
  for (const column of columns) {
    if (!SAFE_IDENTIFIER.test(column.name)) {
      throw new Error(`Refusing to build catalog SELECT with unsafe column identifier: ${column.name}`);
    }
  }
  return columns;
}

const SNAPSHOT_META_DDL = `
CREATE TABLE IF NOT EXISTS snapshot_meta (
  table_name TEXT PRIMARY KEY,
  row_count INTEGER,
  built_at TEXT,
  schema_version INTEGER,
  format_version INTEGER
);
`;

function toSqliteValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'bigint') return value.toString();
  return value as string | number;
}

async function streamTableIntoSqlite(
  tx: TransactionSql,
  db: DatabaseSync,
  tableName: string,
  columns: readonly CatalogColumn[],
): Promise<number> {
  if (!SAFE_IDENTIFIER.test(tableName)) {
    throw new Error(`Refusing to build catalog SQL with unsafe table identifier: ${tableName}`);
  }
  const columnNames = columns.map((column) => column.name);
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${tableName} (\n${columns
      .map((column) => `  ${column.name} ${sqliteTypeFor(column.dataType)}`)
      .join(',\n')}\n);`,
  );

  const insert = db.prepare(
    `INSERT INTO ${tableName} (${columnNames.join(', ')}) VALUES (${columnNames.map(() => '?').join(', ')})`,
  );

  let rowCount = 0;
  // A redacted column is read as a presence marker, never as its value — the
  // CASE runs in Postgres so the secret is never even fetched over the wire.
  const selectList = columns
    .map((column) =>
      column.redacted
        ? `CASE WHEN ${column.name} IS NULL THEN NULL ELSE '${CATALOG_SNAPSHOT_REDACTED_VALUE}' END AS ${column.name}`
        : column.name,
    )
    .join(', ');
  const selectSql = `SELECT ${selectList} FROM ${tableName}`;
  for await (const batch of tx.unsafe(selectSql).cursor(2000)) {
    for (const row of batch as RawRow[]) {
      const normalized = normalizeRow(row);
      insert.run(...columnNames.map((column) => toSqliteValue(normalized[column])));
      rowCount += 1;
    }
  }

  return rowCount;
}

export async function buildCatalogArtifact(params: {
  sqlClient: Sql;
  filePath: string;
  builtAt: string;
}): Promise<Record<string, CatalogTableStats>> {
  const { sqlClient, filePath, builtAt } = params;
  const db = new DatabaseSync(filePath);
  const tables: Record<string, CatalogTableStats> = {};

  try {
    db.exec(SNAPSHOT_META_DDL);
    db.exec('BEGIN');
    // ONE Postgres snapshot for every table. The catalogue's foreign keys point
    // between the tables being exported, so reading each under its own snapshot
    // lets an Aurora import that commits mid-export land a child here whose
    // parent is not — an artifact that only fails much later, when the seeded
    // image loads it under real constraints. READ ONLY makes the intent explicit
    // and lets Postgres skip assigning a transaction id. Same rule the
    // per-layout exporter follows.
    await sqlClient.begin(async (tx) => {
      await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      for (const table of CATALOG_SNAPSHOT_TABLES) {
        const columns = await catalogColumnsFor(tx, table.name);
        const rowCount = await streamTableIntoSqlite(tx, db, table.name, columns);
        tables[table.name] = { rowCount };
      }
    });

    const insertMeta = db.prepare(
      'INSERT OR REPLACE INTO snapshot_meta (table_name, row_count, built_at, schema_version, format_version) VALUES (?, ?, ?, ?, ?)',
    );
    for (const [tableName, stats] of Object.entries(tables)) {
      insertMeta.run(tableName, stats.rowCount, builtAt, CATALOG_SCHEMA_VERSION, CATALOG_MANIFEST_FORMAT_VERSION);
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The transaction may never have opened; the artifact is discarded anyway.
    }
    throw error;
  } finally {
    db.close();
  }

  return tables;
}

type ExportOptions = { dryRun: boolean; keyPrefix: string };

export function parseArgs(argv: string[]): ExportOptions {
  const options: ExportOptions = { dryRun: false, keyPrefix: DEFAULT_CATALOG_KEY_PREFIX };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--key-prefix') {
      index += 1;
      const raw = argv[index];
      if (!raw || !SAFE_KEY_PREFIX.test(raw)) {
        throw new Error(`--key-prefix must be a slash-separated lowercase path, got: ${raw ?? '(missing)'}`);
      }
      options.keyPrefix = raw;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

/**
 * Delete artifacts under our own prefix that the new manifest no longer points
 * at and that are past the grace window. Never fatal: a failed prune costs
 * storage, a failed export costs correctness.
 */
async function pruneStaleArtifacts(manifest: CatalogManifest, nowMs: number, keyPrefix: string): Promise<void> {
  try {
    const referencedKeys = new Set([manifest.artifact.key, `${keyPrefix}/manifest.json`]);
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
        logger.warn('[export-catalog] failed to prune stale artifact — continuing', {
          key: object.key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    logger.info('[export-catalog] prune complete', { scanned: objects.length, pruned: prunedCount });
  } catch (error) {
    logger.warn('[export-catalog] artifact prune failed — continuing (prune is never fatal)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function runCatalogExport(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  if (!options.dryRun && !isS3Configured('snapshots')) {
    throw new Error('S3 is not configured — set the AWS_* env vars or pass --dry-run');
  }

  const startedAt = Date.now();
  const builtAt = new Date(startedAt).toISOString();
  const workDir = mkdtempSync(join(tmpdir(), 'board-catalog-'));
  const filePath = join(workDir, 'catalog.db');
  // Closed by the CLI entry below, not here — tests share the cached pool, and
  // `db` in packages/backend/src/db/client.ts holds a reference to the drizzle
  // wrapper built over it, so ending it here would break every later caller in
  // the process. Same contract as export-board-snapshots.ts.
  const sqlClient = createPool();

  try {
    const tables = await buildCatalogArtifact({ sqlClient, filePath, builtAt });

    const rawBuffer = readFileSync(filePath);
    const uploadBody = gzipSync(rawBuffer);
    const keyStamp = builtAt.replace(/[:.]/g, '-');
    const key = `${options.keyPrefix}/${keyStamp}.db`;
    const canBuildPublicUrl = isS3Configured('snapshots') || snapshotPublicBaseUrl() !== '';

    const manifest: CatalogManifest = {
      formatVersion: CATALOG_MANIFEST_FORMAT_VERSION,
      generatedAt: new Date().toISOString(),
      artifact: {
        key,
        url: canBuildPublicUrl ? publicUrlForKey(key) : `dry-run:${key}`,
        bytes: uploadBody.length,
        uncompressedBytes: rawBuffer.length,
        contentEncoding: 'gzip',
        builtAt,
        schemaVersion: CATALOG_SCHEMA_VERSION,
        tables,
      },
    };

    const rowTotal = Object.values(tables).reduce((sum, stats) => sum + stats.rowCount, 0);

    if (options.dryRun) {
      logger.info('[export-catalog] built (dry-run, not uploaded)', {
        filePath,
        rows: rowTotal,
        rawBytes: rawBuffer.length,
        uploadBytes: uploadBody.length,
        tables,
        durationMs: Date.now() - startedAt,
      });
      // Leave the artifact on disk so a dry run can be inspected with sqlite3.
      logger.info('[export-catalog] dry-run artifact retained', { filePath });
      return;
    }

    // Artifact first, manifest last: a reader must never see a key that is not
    // on S3 yet.
    await uploadToS3('snapshots', uploadBody, key, ARTIFACT_CONTENT_TYPE, { contentEncoding: 'gzip' });
    await uploadToS3(
      'snapshots',
      Buffer.from(JSON.stringify(manifest)),
      `${options.keyPrefix}/manifest.json`,
      'application/json',
      {
        cacheControl: MANIFEST_CACHE_CONTROL,
      },
    );
    logger.info('[export-catalog] published', {
      key,
      rows: rowTotal,
      uploadBytes: uploadBody.length,
      durationMs: Date.now() - startedAt,
    });

    await pruneStaleArtifacts(manifest, Date.now(), options.keyPrefix);
  } finally {
    if (!options.dryRun) rmSync(workDir, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  runCatalogExport(process.argv.slice(2))
    .catch((error) => {
      logger.error('[export-catalog] failed', { error: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool();
    });
}
