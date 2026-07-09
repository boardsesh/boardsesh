// Client-side snapshot bootstrap (offline-sync Phase 3).
//
// A freshly-enabled board would otherwise page its whole reference catalog
// (200k+ climbs) over GraphQL before it is browsable offline. Instead, this
// warms the scope from a pre-built SQLite artifact (the nightly export job in
// packages/backend/src/scripts/export-board-snapshots.ts), then lets the normal
// paged pull resume from the artifact's watermark — a ~1-day delta rather than
// the full crawl. The two paths are byte-identical by construction (the export
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
import type { OfflineBoardScope } from '../offline-board-key';
import type { SnapshotManifestEntry, SnapshotTableName } from './snapshot-manifest';
import { SNAPSHOT_MANIFEST_FORMAT_VERSION } from './snapshot-manifest';
import {
  compareCheckpoints,
  getCheckpointKey,
  rewindDeletionsCheckpoint,
  setCheckpoint,
  type SyncCheckpoint,
} from './checkpoints';
import { getWipeEpoch, isSigningOut } from '../mutation-queue/drainer';
import { LATEST_SCHEMA_VERSION } from '../db/migrations';
import type { SchemaDriftReporter } from './pull-client';

/** The two reference tables a snapshot carries; import order is climbs → stats. */
const SNAPSHOT_TABLES = ['board_climbs', 'board_climb_stats'] as const;

/** The ATTACH alias for the artifact. Distinct from connection.ts's `seed`. */
const SNAPSHOT_ALIAS = 'bs_snapshot';

/** Two bootstrap attempts, then a scope falls through to the normal paged crawl. */
export const MAX_BOOTSTRAP_ATTEMPTS = 2;

const BOOTSTRAP_ATTEMPTS_PREFIX = 'bootstrap-attempts:';
const BOOTSTRAP_DONE_PREFIX = 'bootstrap-done:';
const EPOCH_WATERMARK: SyncCheckpoint = { updatedAt: '1970-01-01T00:00:00.000Z', syncSeq: '0' };

// Only snake_case identifiers may be spliced into the INSERT/SELECT column list.
// The names come from PRAGMA table_info over our own DDL (trusted), but validating
// keeps the string-built SQL provably injection-free — same guard the export uses.
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Mirror of `@boardsesh/board-config`'s `isSizeScopedBoard`, inlined so this
 * zero-runtime-dependency package stays free of the board-config → board-constants
 * → shared-schema chain. MoonBoard has one fixed size, so its climbs are never
 * size-filtered; every other board scopes by `compatible_size_ids`. This one fact
 * must track the resolver's `isSizeScopedBoard` guard
 * (queries.ts:boardClimbsLayoutSizeConditions) exactly.
 */
function isSizeScopedBoard(boardType: string): boolean {
  return boardType !== 'moonboard';
}

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
   * plain SQLite file. Return `null` or throw on failure — both count as a
   * bootstrap attempt.
   */
  downloadArtifact(entry: SnapshotManifestEntry): Promise<{ filePath: string } | null>;
  /** Delete a downloaded artifact once the run is done with it. Best-effort. */
  deleteArtifact(filePath: string): Promise<void>;
}

/** Where a bootstrap failed, for telemetry. */
export type SnapshotBootstrapErrorReporter = (report: {
  scopeKey: string;
  stage: 'manifest' | 'download' | 'import';
  attempt: number;
  cause: unknown;
}) => void;

export type SnapshotBootstrapResult = {
  climbsWatermark: SyncCheckpoint;
  statsWatermark: SyncCheckpoint;
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
 */
export class SnapshotPermanentMissError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotPermanentMissError';
  }
}

// --- Attempt / done markers (sync_meta, NOT under the checkpoint: prefix so the
// sign-out checkpoint wipe leaves them alone, matching the board rows they
// describe, which survive as the shared cache) ---------------------------------

export async function getBootstrapAttempts(db: SqlExecutor, scopeKey: string): Promise<number> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
    `${BOOTSTRAP_ATTEMPTS_PREFIX}${scopeKey}`,
  ]);
  if (!row) return 0;
  const parsed = Number(row.value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Increments the attempt counter for a scope and returns the new count. */
export async function recordBootstrapAttempt(db: SqlExecutor, scopeKey: string): Promise<number> {
  const next = (await getBootstrapAttempts(db, scopeKey)) + 1;
  await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
    `${BOOTSTRAP_ATTEMPTS_PREFIX}${scopeKey}`,
    String(next),
  ]);
  return next;
}

/** Permanent "this scope was warmed from a snapshot" marker (cheap, unambiguous). */
export async function markBootstrapDone(db: SqlExecutor, scopeKey: string): Promise<void> {
  await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
    `${BOOTSTRAP_DONE_PREFIX}${scopeKey}`,
    '1',
  ]);
}

export async function isBootstrapDone(db: SqlExecutor, scopeKey: string): Promise<boolean> {
  const row = await db.getFirstAsync<{ key: string }>('SELECT key FROM sync_meta WHERE key = ?', [
    `${BOOTSTRAP_DONE_PREFIX}${scopeKey}`,
  ]);
  return row !== null;
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
async function tableColumns(
  db: SqlExecutor,
  tableName: string,
  schema: 'main' | typeof SNAPSHOT_ALIAS,
): Promise<string[]> {
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
): Promise<string[]> {
  const mainColumns = await tableColumns(db, tableName, 'main');
  const snapshotColumns = await tableColumns(db, tableName, SNAPSHOT_ALIAS);
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

/**
 * The board_climbs import filter for one scope, mirroring `syncClimbs`'
 * `boardClimbsScope` (queries.ts:183-188): `board_type = ? AND layout_id = ?`,
 * plus — only for size-scoped boards — a `compatible_size_ids` containment check.
 * SQLite has no `@>`, so containment is `json_each` membership; a NULL
 * `compatible_size_ids` is excluded exactly as Postgres `NULL @> ARRAY[x]` is
 * (queries.ts:173-175). Unqualified column names resolve against the single FROM
 * table (the artifact's board_climbs). Params returned alongside.
 */
function climbsScopeFilter(scope: OfflineBoardScope, qualifier = ''): { sql: string; params: (string | number)[] } {
  const params: (string | number)[] = [scope.boardType, scope.layoutId];
  let sql = `${qualifier}board_type = ? AND ${qualifier}layout_id = ?`;
  if (isSizeScopedBoard(scope.boardType)) {
    sql +=
      ` AND ${qualifier}compatible_size_ids IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(${qualifier}compatible_size_ids) WHERE value = ?)`;
    params.push(scope.sizeId);
  }
  return { sql, params };
}

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
    [
      ...mainClimbScope.params,
      ...checkpointLeqParams(watermarks.board_climbs),
      ...snapshotClimbScope.params,
    ],
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
): Promise<void> {
  const climbColumns = await sharedColumns(txn, 'board_climbs', onSchemaDrift);
  const statsColumns = await sharedColumns(txn, 'board_climb_stats', onSchemaDrift);
  assertSafeColumns(climbColumns);
  assertSafeColumns(statsColumns);
  if (climbColumns.length === 0) throw new Error('snapshot bootstrap: no shared board_climbs columns');
  if (statsColumns.length === 0) throw new Error('snapshot bootstrap: no shared board_climb_stats columns');

  const climbScope = climbsScopeFilter(scope);
  const climbList = climbColumns.join(', ');
  await txn.runAsync(
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
  await txn.runAsync(
    `INSERT OR REPLACE INTO main.board_climb_stats (${statsList})
     SELECT ${statsList} FROM ${SNAPSHOT_ALIAS}.board_climb_stats s
     WHERE s.board_type = ?
       AND EXISTS (
         SELECT 1 FROM ${SNAPSHOT_ALIAS}.board_climbs bc
         WHERE bc.uuid = s.climb_uuid AND bc.board_type = ? AND bc.layout_id = ?${innerSize}
       )`,
    statsParams,
  );
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
 * Read + validate the artifact's `snapshot_meta`: every snapshot table present,
 * `format_version` matching this client, `schema_version` not older than this
 * client's schema, and each recorded `row_count` equal to the artifact's ACTUAL
 * table count (a truncated/partial download is caught here before any row is
 * imported). Returns the per-table watermarks.
 */
async function verifySnapshotMeta(db: SqlExecutor): Promise<void> {
  for (const tableName of SNAPSHOT_TABLES) {
    const meta = await db.getFirstAsync<SnapshotMetaRow>(
      `SELECT table_name, watermark_updated_at, watermark_sync_seq, row_count, schema_version, format_version
       FROM ${SNAPSHOT_ALIAS}.snapshot_meta WHERE table_name = ?`,
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
    const actual = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${SNAPSHOT_ALIAS}.${tableName}`);
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
 * scoped climbs + stats and stamps both resume checkpoints at their watermarks.
 * ATTACH/DETACH bracket the transaction (SQLite forbids ATTACH inside one).
 * A wipe that starts (or completes) mid-import rolls the transaction back and
 * throws SnapshotWipedError — no rows, no checkpoints.
 */
export async function bootstrapScopeFromSnapshot(params: {
  db: OfflineDatabase;
  scope: OfflineBoardScope;
  scopeKey: string;
  filePath: string;
  onSchemaDrift?: SchemaDriftReporter;
}): Promise<SnapshotBootstrapResult> {
  const { db, scope, scopeKey, filePath, onSchemaDrift } = params;

  // The whole import + checkpoint stamping is all-or-nothing. A wipe that runs
  // (or starts AND finishes) across ANY await below — including the ATTACH,
  // quick_check, and snapshot_meta reads — would otherwise resurrect the
  // artifact's rows into a wiped DB and write checkpoints past the next
  // account's data. Capture the monotonic epoch before the FIRST await so even
  // a wipe cycle that completes during the integrity checks is caught.
  const startEpoch = getWipeEpoch();

  let attached = false;
  try {
    // Defensive detach first: a failed DETACH from a previous scope in this run
    // (swallowed in the finally below) would leave the alias attached and make
    // this ATTACH fail for every remaining scope. Clearing it here confines a
    // DETACH failure to its own scope.
    await db.execAsync(`DETACH DATABASE ${SNAPSHOT_ALIAS}`).catch(() => {});
    await db.execAsync(`ATTACH DATABASE '${filePath.replace(/'/g, "''")}' AS ${SNAPSHOT_ALIAS}`);
    attached = true;

    const integrity = await db.getAllAsync<{ quick_check: string }>(`PRAGMA ${SNAPSHOT_ALIAS}.quick_check`);
    if (integrity.length !== 1 || integrity[0].quick_check !== 'ok') {
      throw new Error(`snapshot bootstrap: quick_check failed: ${integrity.map((row) => row.quick_check).join('; ')}`);
    }

    await verifySnapshotMeta(db);
    const watermarks = await scopedWatermarks(db, scope);

    if (isSigningOut() || getWipeEpoch() !== startEpoch) throw new SnapshotWipedError();

    await db.withExclusiveTransactionAsync(async (txn) => {
      if (isSigningOut() || getWipeEpoch() !== startEpoch) throw new SnapshotWipedError();

      await reconcileScope(txn, scope, watermarks);
      await importScope(txn, scope, onSchemaDrift);

      // Re-check after the (awaited) imports: abort before committing any rows or
      // checkpoints if a wipe landed while they ran.
      if (isSigningOut() || getWipeEpoch() !== startEpoch) throw new SnapshotWipedError();

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

    return { climbsWatermark: watermarks.board_climbs, statsWatermark: watermarks.board_climb_stats };
  } finally {
    if (attached) {
      await db.execAsync(`DETACH DATABASE ${SNAPSHOT_ALIAS}`).catch(() => {});
    }
  }
}
