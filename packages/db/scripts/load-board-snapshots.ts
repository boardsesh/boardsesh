/**
 * Seed a fresh Postgres from the published board snapshots.
 *
 * This is what the developer database image runs instead of scraping six Aurora
 * APKs and running pgloader at build time (issue #4508). Three artifact
 * families, all public, all rebuilt nightly from production:
 *
 *   board-snapshots/v1-catalog   hardware geometry + reference tables
 *   board-snapshots/v1-gzip      per-(board, layout) climbs + climb stats
 *   <same>/<stamp>-grades.db     per-layout Boardsesh grades, where they exist
 *
 * Load order is foreign-key order: catalogue geometry, then every layout's
 * climbs and stats, then the deferred catalogue tables whose rows point at
 * `board_climbs`, then grades. `board_climb_holds` is not published — it is
 * derived here from each climb's `frames`, the same parse the render and
 * hold-filter paths use.
 *
 * Two shapes the artifacts cannot carry are filled in on the way through:
 *
 *  - `board_climb_grades.model_version` / `coeff_version` are stamped
 *    'snapshot': both are NOT NULL and neither is in the artifact's frozen
 *    column set.
 *  - `board_climbs.user_id` and the account-linking columns of
 *    `board_beta_links` are NULLed. They reference production `users` rows that
 *    no other database has, so keeping them would violate a foreign key.
 *  - `board_climb_stats` drops the Boardsesh accounting split
 *    (`upstream_*` / `boardsesh_*`). Production's published `ascensionist_count`
 *    and `quality_average` are already the blend of upstream and Boardsesh
 *    ticks, so they are loaded as the upstream term with the Boardsesh terms at
 *    zero. That is the right base for a database with no production ticks: the
 *    seeded ticks that land later are then counted exactly once by
 *    `recomputeClimbStatsBulk`. Leaving `upstream_ascensionist_count` NULL would
 *    make that recompute produce nulls.
 *
 * Usage:
 *   vp exec tsx scripts/load-board-snapshots.ts [--snapshot-base-url <url>]
 *     [--climbs-manifest-url <url>] [--catalog-manifest-url <url>]
 *     [--board <type>] [--layout <id>] [--skip-catalog] [--skip-holds]
 *     [--sources-out <path>] [--work-dir <path>] [--database-url <url>]
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import type { Sql } from 'postgres';
import postgres from 'postgres';
import { convertLitUpHoldsStringToMap, isSentinelHoldState } from '@boardsesh/board-constants/hold-states';
import type { BoardName } from '@boardsesh/shared-schema';
import {
  CATALOG_SNAPSHOT_CLIMB_REFERENCE_COLUMNS,
  catalogSnapshotBaseTables,
  catalogSnapshotDeferredTables,
  type CatalogSnapshotTableName,
} from '../src/catalog-snapshot.js';
import { describeDatabaseHost, isLocalDatabaseUrl } from './db-connection.js';

const DEFAULT_SNAPSHOT_BASE_URL = 'https://boardsesh-board-snapshots.t3.tigrisfiles.io';
const CLIMBS_MANIFEST_PATH = 'board-snapshots/v1-gzip/manifest.json';
const CATALOG_MANIFEST_PATH = 'board-snapshots/v1-catalog/manifest.json';

// Every table and column spliced into SQL below comes from the shared catalogue
// contract or from information_schema, never from input — but the splice is
// string concatenation, so the guard stays next to it rather than resting on
// where today's callers happen to get their values.
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function assertSafeIdentifier(identifier: string, what: string): string {
  if (!SAFE_IDENTIFIER.test(identifier)) {
    throw new Error(`Refusing to build SQL with unsafe ${what}: ${identifier}`);
  }
  return identifier;
}

/** Deliberate opt-in to load into a non-local database. Never set by automation. */
const ALLOW_REMOTE_ENV_VAR = 'LOAD_BOARD_SNAPSHOTS_ALLOW_REMOTE';

/**
 * Load order and the deferred set both come from the shared contract the export
 * job builds the artifact with, so the two can never drift.
 */
export const CATALOG_LOAD_ORDER = catalogSnapshotBaseTables();

export const DEFERRED_CATALOG_TABLES: readonly { table: CatalogSnapshotTableName; requiresClimb: string | null }[] =
  catalogSnapshotDeferredTables().map((table) => ({
    table,
    requiresClimb: CATALOG_SNAPSHOT_CLIMB_REFERENCE_COLUMNS[table] ?? null,
  }));

/** Columns forced to NULL: production account links that resolve nowhere else. */
export const FORCED_NULL_COLUMNS: Record<string, readonly string[]> = {
  board_climbs: ['user_id'],
  board_beta_links: ['created_by_user_id', 'tick_uuid', 'board_id'],
};

export type SqliteValue = string | number | bigint | null | Uint8Array;
export type SqliteRow = Record<string, SqliteValue>;

export type PgColumn = { name: string; formatType: string; dataType: string; udtName: string };

/** One target column: where its value comes from, and what to cast it to. */
export type ColumnPlan = { name: string; formatType: string; read: (row: SqliteRow) => string | null };

// ---------------------------------------------------------------------------
// COPY text encoding
// ---------------------------------------------------------------------------

/**
 * Postgres COPY text format: a literal backslash and the four whitespace
 * characters that would otherwise end a field or a row must be escaped, and
 * NULL is the unquoted two-character sequence `\N`. Text format (not CSV) is
 * used precisely because `\N` cannot collide with a real value the way a CSV
 * null marker can.
 */
export function encodeCopyField(value: string | null): string {
  if (value === null) return '\\N';
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

export function encodeCopyRow(fields: readonly (string | null)[]): string {
  return `${fields.map(encodeCopyField).join('\t')}\n`;
}

/** Postgres array literal element: quote and escape so braces, commas and quotes survive. */
function quoteArrayElement(element: string): string {
  return `"${element.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function jsonArrayToPgArray(raw: SqliteValue, quoteElements: boolean): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw);
  if (text === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`expected a JSON array, got: ${text.slice(0, 80)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`expected a JSON array, got: ${text.slice(0, 80)}`);
  return `{${parsed.map((element) => (quoteElements ? quoteArrayElement(String(element)) : String(element))).join(',')}}`;
}

export function booleanToPg(raw: SqliteValue): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'boolean') return raw ? 't' : 'f';
  const text = String(raw);
  if (text === '1' || text === 'true' || text === 't') return 't';
  if (text === '0' || text === 'false' || text === 'f') return 'f';
  throw new Error(`expected a boolean, got: ${text.slice(0, 40)}`);
}

export function readerFor(column: PgColumn): (row: SqliteRow) => string | null {
  if (column.dataType === 'boolean') {
    return (row) => booleanToPg(row[column.name]);
  }
  if (column.dataType === 'ARRAY') {
    // udt_name for an array is the element type prefixed with '_'. Numeric and
    // boolean elements need no quoting; text ones do.
    const quoteElements = !/^_(int|float|numeric|bool)/.test(column.udtName);
    return (row) => jsonArrayToPgArray(row[column.name], quoteElements);
  }
  return (row) => {
    const value = row[column.name];
    if (value === null || value === undefined) return null;
    return typeof value === 'string' ? value : String(value);
  };
}

// ---------------------------------------------------------------------------
// Manifests and downloads
// ---------------------------------------------------------------------------

type SnapshotTableStats = { rowCount: number };

type ClimbsManifestEntry = {
  boardType: string;
  layoutId: number;
  key: string;
  url: string;
  bytes: number;
  tables: Record<string, SnapshotTableStats>;
  grades?: { key: string; url: string; bytes: number; tables: Record<string, SnapshotTableStats> };
};

type ClimbsManifest = { formatVersion: number; generatedAt: string; entries: ClimbsManifestEntry[] };

type CatalogManifest = {
  formatVersion: number;
  generatedAt: string;
  artifact: { key: string; url: string; bytes: number; builtAt: string; tables: Record<string, SnapshotTableStats> };
};

/**
 * Retry a network step a few times with linear backoff. The full load is a
 * ~15-minute sequence of 25 downloads; without this, one blip anywhere in it
 * throws away the whole image build.
 */
async function withRetry<T>(label: string, attempt: () => Promise<T>): Promise<T> {
  const maxAttempts = 4;
  let lastError: unknown;
  for (let tries = 1; tries <= maxAttempts; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      if (tries === maxAttempts) break;
      // Exponential: 2s, 4s, 8s. Linear gave a 12s total window, which is tight
      // against a CDN that just refused a 100 MB transfer.
      const delayMs = 2000 * 2 ** (tries - 1);
      console.warn(
        `  ${label} failed (attempt ${tries}/${maxAttempts}): ` +
          `${error instanceof Error ? error.message : String(error)} — retrying in ${delayMs / 1000}s`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function fetchManifest<T>(url: string, requiredKey: string): Promise<T> {
  const manifest = await withRetry(`manifest ${url}`, async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`manifest fetch failed: ${url} → HTTP ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
  });
  // A manifest missing its top-level key means the URL points at something else
  // entirely (a stale prefix, an error page served with 200). Say which URL,
  // rather than failing later on `undefined.key`.
  if (!manifest || typeof manifest !== 'object' || manifest[requiredKey] === undefined) {
    throw new Error(`manifest at ${url} has no "${requiredKey}" — is that the right prefix?`);
  }
  return manifest as T;
}

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

/** True when the file still holds a raw gzip stream (the fetch did not decode it). */
export async function looksGzipCompressed(filePath: string): Promise<boolean> {
  const handle = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(2);
    const { bytesRead } = await handle.read(header, 0, 2, 0);
    return bytesRead === 2 && header.equals(GZIP_MAGIC);
  } finally {
    await handle.close();
  }
}

/**
 * Whether the bytes on disk are still gzip depends on the HTTP stack: one that
 * honours Content-Encoding hands back decoded bytes, one that streams to disk
 * writes the raw gzip. Sniff the magic rather than trusting the manifest, the
 * same rule the mobile downloader follows.
 */
async function downloadArtifact(url: string, destPath: string): Promise<void> {
  await withRetry(`download ${url}`, async () => {
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`artifact download failed: ${url} → HTTP ${response.status}`);
    }
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(destPath),
    );
  });

  if (await looksGzipCompressed(destPath)) {
    const decodedPath = `${destPath}.decoded`;
    try {
      await pipeline(createReadStream(destPath), createGunzip(), createWriteStream(decodedPath));
    } catch (error) {
      // The download itself is still on disk — the decode is what failed — so
      // drop the half-written decode rather than leave it to be mistaken for a
      // complete artifact, and let the real zlib error surface.
      await rm(decodedPath, { force: true });
      throw error;
    }
    await rm(destPath, { force: true });
    await rename(decodedPath, destPath);
  }
}

/**
 * Integrity gate, matching what the mobile client does before it trusts an
 * artifact: the file must be a healthy SQLite database, and every table's
 * recorded `snapshot_meta.row_count` must equal its actual row count.
 */
function verifyArtifact(db: DatabaseSync, label: string): void {
  const quickCheck = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
  const quickCheckResult = quickCheck ? String(Object.values(quickCheck)[0]) : 'missing';
  if (quickCheckResult !== 'ok') {
    throw new Error(`${label}: PRAGMA quick_check returned ${quickCheckResult}`);
  }

  const metaRows = db.prepare('SELECT table_name, row_count FROM snapshot_meta').all() as {
    table_name: string;
    row_count: number | null;
  }[];
  if (metaRows.length === 0) throw new Error(`${label}: snapshot_meta is empty`);

  for (const meta of metaRows) {
    // `sync_deletions` is a metadata-only row in the climb artifacts: it carries
    // the deletion replay boundary, never a table.
    if (meta.table_name === 'sync_deletions') continue;
    const actual = db.prepare(`SELECT count(*) AS n FROM ${meta.table_name}`).get() as { n: number };
    if (Number(actual.n) !== Number(meta.row_count ?? -1)) {
      throw new Error(`${label}: ${meta.table_name} has ${actual.n} rows, snapshot_meta says ${meta.row_count}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Postgres side
// ---------------------------------------------------------------------------

async function pgColumns(sqlClient: Sql, tableName: string): Promise<PgColumn[]> {
  // format_type gives the exact cast target ('integer[]', 'timestamp without
  // time zone'); information_schema.data_type flattens every array to 'ARRAY',
  // which is what the JS encoder keys off. Both are needed.
  const rows = await sqlClient<{ name: string; format_type: string; data_type: string; udt_name: string }[]>`
    SELECT
      attribute.attname AS name,
      format_type(attribute.atttypid, attribute.atttypmod) AS format_type,
      columns.data_type,
      columns.udt_name
    FROM pg_attribute AS attribute
    JOIN pg_class AS class ON class.oid = attribute.attrelid
    JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
    JOIN information_schema.columns AS columns
      ON columns.table_schema = namespace.nspname
      AND columns.table_name = class.relname
      AND columns.column_name = attribute.attname
    WHERE namespace.nspname = 'public'
      AND class.relname = ${tableName}
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    ORDER BY attribute.attnum
  `;
  if (rows.length === 0) throw new Error(`table ${tableName} has no columns — is the schema migrated?`);
  return rows.map((row) => ({
    name: row.name,
    formatType: row.format_type,
    dataType: row.data_type,
    udtName: row.udt_name,
  }));
}

function sqliteColumns(db: DatabaseSync, tableName: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
  if (rows.length === 0) throw new Error(`artifact has no table ${tableName}`);
  return rows.map((row) => row.name);
}

/**
 * The columns a table is loaded with: the intersection of what the artifact
 * carries and what this schema has, in Postgres ordinal order. A column present
 * on only one side is skipped — the same "shared columns" rule the mobile
 * bootstrap uses, so a newer artifact never breaks an older schema.
 */
export function buildColumnPlans(
  pgCols: readonly PgColumn[],
  artifactCols: readonly string[],
  tableName: string,
): ColumnPlan[] {
  const artifactColumnSet = new Set(artifactCols);
  const forcedNull = new Set(FORCED_NULL_COLUMNS[tableName] ?? []);
  const plans: ColumnPlan[] = [];
  for (const column of pgCols) {
    if (forcedNull.has(column.name)) {
      plans.push({ name: column.name, formatType: column.formatType, read: () => null });
      continue;
    }
    if (!artifactColumnSet.has(column.name)) continue;
    plans.push({ name: column.name, formatType: column.formatType, read: readerFor(column) });
  }
  return plans;
}

/**
 * Stream rows into an all-text staging table through `COPY ... FROM STDIN`.
 *
 * The staging table is deliberately untyped and constraint-free, because a COPY
 * the SERVER rejects is unrecoverable with postgres.js 3.x: its CopyIn writable
 * nulls the connection's stream reference inside `final()`, so when
 * ErrorResponse arrives there is no stream left to destroy — and the query
 * promise was already resolved with that stream, so there is nothing left to
 * reject either. The write never finishes, the pipeline never settles, and the
 * process hangs (or exits 0 having written nothing). Copying into a table that
 * cannot reject a row removes that failure mode; every constraint is enforced
 * by the INSERT ... SELECT below, an ordinary query whose errors propagate.
 */
async function copyIntoStaging(
  sqlClient: Sql,
  stagingTable: string,
  columns: readonly string[],
  rows: Iterable<readonly (string | null)[]>,
): Promise<number> {
  assertSafeIdentifier(stagingTable, 'staging table');
  for (const column of columns) assertSafeIdentifier(column, 'column');
  await sqlClient.unsafe(`DROP TABLE IF EXISTS ${stagingTable}`);
  await sqlClient.unsafe(
    `CREATE UNLOGGED TABLE ${stagingTable} (${columns.map((column) => `${column} text`).join(', ')})`,
  );

  let rowCount = 0;
  const chunks = function* (): Generator<Buffer> {
    let buffer = '';
    for (const row of rows) {
      // A row whose width does not match the column list is the one data error
      // the staging table cannot absorb — the server rejects the whole COPY,
      // which this client cannot report (see the note above). Catch it here,
      // before any bytes go out, so it surfaces as a plain throw naming the
      // table rather than a stall.
      if (row.length !== columns.length) {
        throw new Error(`${stagingTable}: row has ${row.length} values but ${columns.length} columns were declared`);
      }
      buffer += encodeCopyRow(row);
      rowCount += 1;
      // ~1 MB per socket write: one write per row would put 10 million
      // round-trips on the event loop for board_climb_holds alone.
      if (buffer.length >= 1 << 20) {
        yield Buffer.from(buffer, 'utf8');
        buffer = '';
      }
    }
    if (buffer !== '') yield Buffer.from(buffer, 'utf8');
  };

  const writable = await sqlClient.unsafe(`COPY ${stagingTable} (${columns.join(', ')}) FROM STDIN`).writable();
  await pipeline(Readable.from(chunks(), { objectMode: false }), writable);
  return rowCount;
}

/** `col` for text columns, `col::type` for everything else. */
export function castExpression(plan: ColumnPlan): string {
  return plan.formatType === 'text' ? plan.name : `${plan.name}::${plan.formatType}`;
}

type LoadResult = { staged: number; inserted: number };

async function loadRows(params: {
  sqlClient: Sql;
  targetTable: string;
  plans: readonly ColumnPlan[];
  rows: Iterable<readonly (string | null)[]>;
  extraWhere?: string;
}): Promise<LoadResult> {
  const { sqlClient, targetTable, plans, rows, extraWhere } = params;
  assertSafeIdentifier(targetTable, 'target table');
  const stagingTable = `bs_stage_${targetTable}`;
  const columnList = plans.map((plan) => plan.name).join(', ');
  try {
    const staged = await copyIntoStaging(
      sqlClient,
      stagingTable,
      plans.map((plan) => plan.name),
      rows,
    );
    const result = await sqlClient.unsafe(
      `INSERT INTO ${targetTable} (${columnList})
       SELECT ${plans.map(castExpression).join(', ')} FROM ${stagingTable} AS staging${extraWhere ? ` WHERE ${extraWhere}` : ''}
       ON CONFLICT DO NOTHING`,
    );
    return { staged, inserted: result.count ?? 0 };
  } finally {
    await sqlClient.unsafe(`DROP TABLE IF EXISTS ${stagingTable}`);
  }
}

function* mapSqliteRows(
  db: DatabaseSync,
  selectSql: string,
  plans: readonly ColumnPlan[],
): Generator<readonly (string | null)[]> {
  for (const row of db.prepare(selectSql).iterate() as Iterable<SqliteRow>) {
    yield plans.map((plan) => plan.read(row));
  }
}

async function loadArtifactTable(params: {
  sqlClient: Sql;
  db: DatabaseSync;
  table: string;
  extraColumns?: readonly ColumnPlan[];
  requiresClimb?: string | null;
}): Promise<LoadResult> {
  const { sqlClient, db, table, extraColumns = [], requiresClimb } = params;
  const pgCols = await pgColumns(sqlClient, table);
  const artifactCols = sqliteColumns(db, table);
  const plans = [...buildColumnPlans(pgCols, artifactCols, table), ...extraColumns];
  if (plans.length === 0) throw new Error(`no shared columns between the artifact and table ${table}`);

  return loadRows({
    sqlClient,
    targetTable: table,
    plans,
    rows: mapSqliteRows(db, `SELECT ${artifactCols.join(', ')} FROM ${table}`, plans),
    extraWhere: requiresClimb
      ? `EXISTS (SELECT 1 FROM board_climbs climb WHERE climb.board_type = staging.board_type AND climb.uuid = staging.${assertSafeIdentifier(requiresClimb, 'climb reference column')})`
      : undefined,
  });
}

/**
 * Derive `board_climb_holds` from each climb's `frames`.
 *
 * Deduplicated by hold id across frames, last frame wins — the table's primary
 * key is (board_type, climb_uuid, hold_id), so a multi-frame climb that lights
 * the same hold twice contributes one row. This matches what the Aurora
 * importer did (`deriveClimbHoldsFromFrames`), which is why multi-frame climbs
 * have hold rows in the image today.
 */
export function holdRowsForClimb(boardType: string, climbUuid: string, frames: string): (readonly (string | null)[])[] {
  let frameMap: ReturnType<typeof convertLitUpHoldsStringToMap>;
  try {
    frameMap = convertLitUpHoldsStringToMap(frames, boardType as BoardName);
  } catch {
    // An unparseable frames string is upstream data we cannot fix here; the
    // climb still loads, it just gets no hold rows (as with today's importer).
    return [];
  }
  const holds = new Map<number, { frameNumber: number; state: string }>();
  for (const [frameKey, holdsMap] of Object.entries(frameMap)) {
    const frameNumber = Number(frameKey);
    for (const [holdKey, hold] of Object.entries(holdsMap)) {
      if (isSentinelHoldState(hold.state)) continue;
      const holdId = Number(holdKey);
      if (!Number.isFinite(holdId)) continue;
      holds.set(holdId, { frameNumber, state: hold.state });
    }
  }
  return [...holds].map(([holdId, hold]) => [
    boardType,
    climbUuid,
    String(holdId),
    String(hold.frameNumber),
    hold.state,
  ]);
}

function* deriveHoldRows(db: DatabaseSync): Generator<readonly (string | null)[]> {
  const rows = db
    .prepare("SELECT uuid, board_type, frames FROM board_climbs WHERE frames IS NOT NULL AND frames != ''")
    .iterate() as Iterable<{ uuid: string; board_type: string; frames: string }>;

  for (const climb of rows) {
    yield* holdRowsForClimb(climb.board_type, climb.uuid, climb.frames);
  }
}

// deriveHoldRows yields values positionally, so these plans only carry the
// column name and its cast; `read` is never called for them.
// `read` throws rather than returning null: routing these through
// `mapSqliteRows` would otherwise emit ~10M all-NULL rows that fail on the first
// NOT NULL column, with nothing pointing back to the cause.
const positionalPlan = (name: string, formatType: string): ColumnPlan => ({
  name,
  formatType,
  read: () => {
    throw new Error(`${name} is supplied positionally by deriveHoldRows; its plan has no reader`);
  },
});

export const HOLD_COLUMN_PLANS: ColumnPlan[] = [
  positionalPlan('board_type', 'text'),
  positionalPlan('climb_uuid', 'text'),
  positionalPlan('hold_id', 'integer'),
  positionalPlan('frame_number', 'integer'),
  positionalPlan('hold_state', 'text'),
];

/**
 * `board_climb_grades.model_version` and `coeff_version` are NOT NULL, and the
 * grades artifact does not carry them: they are part of the frozen client
 * column set, and widening it would make every shipped binary reject artifacts
 * still inside the prune grace. A sentinel is the honest value — these rows
 * were not computed by a local model run, and `refresh-climb-grades` overwrites
 * both when a developer does recompute grades against this database.
 */
const GRADES_VERSION_PLANS: ColumnPlan[] = [
  { name: 'model_version', formatType: 'text', read: () => 'snapshot' },
  { name: 'coeff_version', formatType: 'text', read: () => 'snapshot' },
];

/**
 * The `upstream_*` / `boardsesh_*` split the artifact does not carry. See the
 * file header for why production's blend becomes the upstream term.
 */
export const STATS_ACCOUNTING_PLANS: ColumnPlan[] = [
  {
    name: 'upstream_ascensionist_count',
    formatType: 'bigint',
    read: (row) => (row.ascensionist_count === null ? null : String(row.ascensionist_count)),
  },
  {
    name: 'upstream_quality_average',
    formatType: 'double precision',
    read: (row) => (row.quality_average === null ? null : String(row.quality_average)),
  },
  { name: 'boardsesh_ascensionist_count', formatType: 'bigint', read: () => '0' },
  { name: 'boardsesh_quality_sum', formatType: 'double precision', read: () => '0' },
  { name: 'boardsesh_quality_count', formatType: 'bigint', read: () => '0' },
  { name: 'quality_normalized', formatType: 'boolean', read: () => 't' },
];

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

type Options = {
  databaseUrl: string;
  snapshotBaseUrl: string;
  climbsManifestUrl?: string;
  catalogManifestUrl?: string;
  board?: string;
  layout?: number;
  skipCatalog: boolean;
  skipHolds: boolean;
  sourcesOut?: string;
  workDir?: string;
};

export function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    // Read straight from DATABASE_URL, deliberately NOT through
    // getScriptDatabaseUrl(): that helper dotenv-loads several .env files and
    // prefers DB_URL, so a developer's committed web/.env.local can silently
    // repoint a bulk COPY at a hosted database.
    databaseUrl: process.env.DATABASE_URL ?? '',
    snapshotBaseUrl: (process.env.SNAPSHOT_BASE_URL ?? DEFAULT_SNAPSHOT_BASE_URL).replace(/\/+$/, ''),
    skipCatalog: false,
    skipHolds: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      index += 1;
      const value = argv[index];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case '--database-url':
        options.databaseUrl = next();
        break;
      case '--snapshot-base-url':
        options.snapshotBaseUrl = next().replace(/\/+$/, '');
        break;
      // Full-URL overrides, so a run can point either manifest at a staging
      // bucket or a locally served fixture without moving the other one.
      case '--climbs-manifest-url':
        options.climbsManifestUrl = next();
        break;
      case '--catalog-manifest-url':
        options.catalogManifestUrl = next();
        break;
      case '--board':
        options.board = next();
        break;
      case '--layout': {
        const parsed = Number(next());
        if (!Number.isInteger(parsed)) throw new Error('--layout must be an integer');
        options.layout = parsed;
        break;
      }
      case '--skip-catalog':
        options.skipCatalog = true;
        break;
      case '--skip-holds':
        options.skipHolds = true;
        break;
      case '--sources-out':
        options.sourcesOut = next();
        break;
      case '--work-dir':
        options.workDir = next();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { databaseUrl } = options;
  if (!databaseUrl) {
    throw new Error('set DATABASE_URL (or pass --database-url) — this script fills a database from scratch');
  }
  // Fail closed on anything that is not recognizably a local/dev-tooling host.
  // This script COPYs ~900k climbs and ~10M hold rows into whatever it is
  // pointed at; a mistyped host must not be able to reach a hosted database.
  if (!isLocalDatabaseUrl(databaseUrl) && process.env[ALLOW_REMOTE_ENV_VAR] !== '1') {
    throw new Error(
      `refusing to bulk-load into non-local host ${describeDatabaseHost(databaseUrl)} — ` +
        `set ${ALLOW_REMOTE_ENV_VAR}=1 if that is deliberate`,
    );
  }

  const sqlClient = postgres(databaseUrl, {
    max: 1,
    // Not 0 (never close): a held-open socket keeps the event loop alive, so a
    // stalled COPY would hang forever instead of reaching the `beforeExit`
    // guard. 120s is far longer than any single step here takes.
    idle_timeout: 120,
    prepare: false,
    // `DROP TABLE IF EXISTS` on a staging table that is not there emits a NOTICE
    // per table, and postgres.js prints the whole protocol object by default,
    // which would bury the load progress in the build log.
    onnotice: () => {},
  });
  const workDir = options.workDir ?? (await mkdtemp(join(tmpdir(), 'board-snapshots-')));
  await mkdir(workDir, { recursive: true });

  const resolvedSources: Record<string, unknown> = { loadedAt: new Date().toISOString() };
  const startedAt = Date.now();
  let climbsLoaded = 0;
  let statsLoaded = 0;
  let gradesLoaded = 0;
  let holdsLoaded = 0;

  console.info(`Loading board snapshots into ${describeDatabaseHost(databaseUrl)}`);
  console.info(`  base URL: ${options.snapshotBaseUrl}`);

  try {
    let catalogArtifactPath: string | null = null;

    if (!options.skipCatalog) {
      const catalogManifest = await fetchManifest<CatalogManifest>(
        options.catalogManifestUrl ?? `${options.snapshotBaseUrl}/${CATALOG_MANIFEST_PATH}`,
        'artifact',
      );
      resolvedSources.catalog = {
        key: catalogManifest.artifact.key,
        builtAt: catalogManifest.artifact.builtAt,
        bytes: catalogManifest.artifact.bytes,
        generatedAt: catalogManifest.generatedAt,
      };
      catalogArtifactPath = join(workDir, 'catalog.db');
      console.info(`\n>>> Catalogue artifact ${catalogManifest.artifact.key}`);
      await downloadArtifact(catalogManifest.artifact.url, catalogArtifactPath);

      const catalogDb = new DatabaseSync(catalogArtifactPath, { readOnly: true });
      try {
        verifyArtifact(catalogDb, 'catalog artifact');
        for (const table of CATALOG_LOAD_ORDER) {
          // board_attempts and board_difficulty_grades already hold the MoonBoard
          // rows migration 0025 hardcodes, hence ON CONFLICT DO NOTHING.
          const { staged, inserted } = await loadArtifactTable({ sqlClient, db: catalogDb, table });
          console.info(`    ${table}: ${inserted.toLocaleString()} inserted / ${staged.toLocaleString()} in artifact`);
        }
      } finally {
        catalogDb.close();
      }
    }

    const climbsManifest = await fetchManifest<ClimbsManifest>(
      options.climbsManifestUrl ?? `${options.snapshotBaseUrl}/${CLIMBS_MANIFEST_PATH}`,
      'entries',
    );
    const entries = climbsManifest.entries
      .filter((entry) => !options.board || entry.boardType === options.board)
      .filter((entry) => options.layout === undefined || entry.layoutId === options.layout)
      .sort((left, right) =>
        left.boardType === right.boardType
          ? left.layoutId - right.layoutId
          : left.boardType.localeCompare(right.boardType),
      );
    if (entries.length === 0) throw new Error('no manifest entries matched the --board/--layout filter');

    resolvedSources.climbs = {
      generatedAt: climbsManifest.generatedAt,
      entries: entries.map((entry) => ({
        boardType: entry.boardType,
        layoutId: entry.layoutId,
        key: entry.key,
        bytes: entry.bytes,
        gradesKey: entry.grades?.key ?? null,
      })),
    };

    for (const entry of entries) {
      const label = `${entry.boardType}:${entry.layoutId}`;
      const artifactPath = join(workDir, `${entry.boardType}-${entry.layoutId}.db`);
      console.info(`\n>>> ${label} (${(entry.bytes / 1e6).toFixed(1)} MB)`);
      await downloadArtifact(entry.url, artifactPath);

      const db = new DatabaseSync(artifactPath, { readOnly: true });
      try {
        verifyArtifact(db, label);
        const climbs = await loadArtifactTable({ sqlClient, db, table: 'board_climbs' });
        const stats = await loadArtifactTable({
          sqlClient,
          db,
          table: 'board_climb_stats',
          extraColumns: STATS_ACCOUNTING_PLANS,
        });
        climbsLoaded += climbs.inserted;
        statsLoaded += stats.inserted;
        console.info(`    climbs ${climbs.inserted.toLocaleString()}  stats ${stats.inserted.toLocaleString()}`);

        if (!options.skipHolds) {
          const holds = await loadRows({
            sqlClient,
            targetTable: 'board_climb_holds',
            plans: HOLD_COLUMN_PLANS,
            rows: deriveHoldRows(db),
          });
          holdsLoaded += holds.inserted;
          console.info(`    holds  ${holds.inserted.toLocaleString()}`);
        }
      } finally {
        db.close();
      }
      await rm(artifactPath, { force: true });

      if (entry.grades) {
        const gradesPath = join(workDir, `${entry.boardType}-${entry.layoutId}-grades.db`);
        await downloadArtifact(entry.grades.url, gradesPath);
        const gradesDb = new DatabaseSync(gradesPath, { readOnly: true });
        try {
          verifyArtifact(gradesDb, `${label} grades`);
          const grades = await loadArtifactTable({
            sqlClient,
            db: gradesDb,
            table: 'board_climb_grades',
            extraColumns: GRADES_VERSION_PLANS,
          });
          gradesLoaded += grades.inserted;
          console.info(`    grades ${grades.inserted.toLocaleString()}`);
        } finally {
          gradesDb.close();
        }
        await rm(gradesPath, { force: true });
      }
    }

    if (catalogArtifactPath) {
      console.info('\n>>> Deferred catalogue tables (reference board_climbs)');
      const catalogDb = new DatabaseSync(catalogArtifactPath, { readOnly: true });
      try {
        for (const deferred of DEFERRED_CATALOG_TABLES) {
          const { staged, inserted } = await loadArtifactTable({
            sqlClient,
            db: catalogDb,
            table: deferred.table,
            requiresClimb: deferred.requiresClimb,
          });
          console.info(
            `    ${deferred.table}: ${inserted.toLocaleString()} inserted / ${staged.toLocaleString()} in artifact`,
          );
        }
      } finally {
        catalogDb.close();
      }
      await rm(catalogArtifactPath, { force: true });
    }

    console.info('\n>>> ANALYZE');
    await sqlClient.unsafe('ANALYZE');

    if (options.sourcesOut) {
      resolvedSources.totals = { climbsLoaded, statsLoaded, gradesLoaded, holdsLoaded };
      await writeFile(options.sourcesOut, `${JSON.stringify(resolvedSources, null, 2)}\n`, 'utf8');
      console.info(`\nResolved sources written to ${options.sourcesOut}`);
    }

    console.info(
      `\nDone in ${Math.round((Date.now() - startedAt) / 1000)}s — ` +
        `${climbsLoaded.toLocaleString()} climbs, ${statsLoaded.toLocaleString()} stats, ` +
        `${gradesLoaded.toLocaleString()} grades, ${holdsLoaded.toLocaleString()} holds.`,
    );
  } finally {
    await sqlClient.end();
    if (!options.workDir) await rm(workDir, { recursive: true, force: true });
  }
}

// Exact match, not a substring test: the test file's path also contains this
// script's name, and a loose check would run the whole load on import.
const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  let completed = false;
  // Backstop for a stalled COPY: if the event loop ever drains before main()
  // resolves, exit non-zero rather than letting a build declare success over a
  // half-filled database.
  process.on('beforeExit', () => {
    if (completed) return;
    console.error('load-board-snapshots exited before finishing — treating as a failure');
    process.exit(1);
  });
  main()
    .then(() => {
      completed = true;
    })
    .catch((error) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exit(1);
    });
}
