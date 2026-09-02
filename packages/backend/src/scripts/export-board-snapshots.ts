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
// + toSqliteValue), with explicit postgres.js text parsers preserving timestamp
// precision and wall-clock semantics, so an artifact row is byte-identical to
// what a live `syncClimbs`/`syncClimbStats` pull would have written. The
// snapshot-export-golden test pins that equivalence.
//
// Primary reads remain the default. Replica reads are allowed only through the
// explicit primary-issued cutoff + WAL replay barrier implemented below;
// simply replacing DATABASE_URL with a replica URL is still a permanent-skip
// bug.
//
// Structure: a testable core (`exportLayoutSnapshot`, `boardSnapshotDdlStatements`,
// `discoverLayoutPairs`) under a thin CLI (`runExport`). The CLI is only invoked
// when this module is the process entry, so importing it in a test has no side
// effects.

import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres, { type ReservedSql, type Sql, type TransactionSql } from 'postgres';
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
import { closePool } from '@boardsesh/db/client';
import { normalizeRow, toIso, type RawRow } from '../graphql/resolvers/sync/row-normalize';
import { uploadToS3, isS3Configured, getPublicUrl, getFromS3Strict, deleteFromS3, listS3Objects } from '../storage/s3';
import { logger } from '../utils/logger';
import { DEFAULT_SNAPSHOT_MAX_CUTOFF_AGE_SECONDS } from './snapshot-contract';

// This exporter deliberately uses postgres.js directly instead of Drizzle: it
// needs reserved sessions, cursors, PostgreSQL control functions, and the exact
// text representation of timestamp values. Query values are bind parameters.
// The only interpolated SQL is either a strict identifier allowlist or the
// separately validated application_name SET documented at its call site.

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
const HEARTBEAT_CACHE_CONTROL = 'no-store, max-age=0';
const DEFAULT_REPLICA_MAX_LAG_SECONDS = 30;
const DEFAULT_REPLICA_WAIT_SECONDS = 10 * 60;

// Public base for the manifest's artifact URLs. Tigris serves PUBLIC objects
// only on the bucket's virtual-host domain (https://<bucket>.t3.tigrisfiles.io);
// the S3 endpoint's path-style URL that getPublicUrl builds returns 403 for
// unauthenticated GETs even on a public bucket. When set (no trailing slash
// needed), entry URLs become `${base}/${key}`; unset falls back to getPublicUrl
// for S3-compatible stores whose endpoint serves public reads directly. Read
// lazily (not at module load) so tests can set it per-run.
function snapshotPublicBaseUrl(): string {
  return (process.env.SNAPSHOT_PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
}

function publicUrlForKey(key: string): string {
  const publicBase = snapshotPublicBaseUrl();
  return publicBase ? `${publicBase}/${key}` : getPublicUrl(key);
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

// Match the exact transparent-parser OID list installed by the pinned Drizzle
// postgres-js driver without depending on its constructor side effect. Most are
// date/time scalars and arrays; 1231 is intentionally numeric[] because Drizzle
// also preserves that value as server text. OID 1183 (time[]) is intentionally
// absent from Drizzle's list. The parity test fails if either contract changes.
const passthroughSnapshotPostgresValue = (value: unknown): unknown => value;
const SNAPSHOT_POSTGRES_TYPES = {
  snapshotText: {
    // postgres.js's public custom-type contract requires one outbound OID.
    // Snapshot SQL never uses the named helper to write; 1184 is the canonical
    // timestamp type and mirrors Drizzle's identity serializer if a bound
    // timestamp is ever passed to one of these queries.
    to: 1184,
    from: [1184, 1082, 1083, 1114, 1182, 1185, 1115, 1231],
    serialize: passthroughSnapshotPostgresValue,
    parse: passthroughSnapshotPostgresValue,
  },
};

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

type SnapshotDatabaseSource = 'primary' | 'replica';

export type SnapshotReadBoundary = {
  source: SnapshotDatabaseSource;
  stableBefore: string;
  /** The primary fence already folded every open primary transaction into stableBefore. */
  stableBeforeIncludesActiveTransactions: boolean;
  targetLsn: string;
  replayLsn: string;
  systemIdentifier: string;
  timelineId: number;
};

type SnapshotDatabaseContext = {
  sqlClient: Sql;
  boundary: SnapshotReadBoundary;
  /** The client has a spare connection which can observe its export transaction. */
  deletionObserverConnectionAvailable: boolean;
  assertPublishFence: () => Promise<void>;
  close: () => Promise<void>;
};

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

/** Every live (board_type, layout_id) pair, independent of the row export cutoff. */
export async function discoverLayoutPairs(sqlClient: Sql, filter?: Partial<LayoutPair>): Promise<LayoutPair[]> {
  const boardCondition = filter?.boardType ? sqlClient`board_type = ${filter.boardType}` : sqlClient`TRUE`;
  const layoutCondition = filter?.layoutId != null ? sqlClient`layout_id = ${filter.layoutId}` : sqlClient`TRUE`;
  const rows = await sqlClient<{ board_type: string; layout_id: number }[]>`
    SELECT DISTINCT board_type, layout_id
    FROM board_climbs
    WHERE ${boardCondition}
      AND ${layoutCondition}
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

// Every query in one run uses the exact primary-issued cutoff. A replica-local
// now()/replay timestamp would reintroduce the late-commit cursor race.
const CLIMBS_WHERE = `board_type = $1 AND layout_id = $2 AND updated_at < $3::timestamp`;

const STATS_WHERE = `board_type = $1
    AND EXISTS (
      SELECT 1 FROM board_climbs bc
      WHERE bc.uuid = board_climb_stats.climb_uuid AND bc.board_type = $1 AND bc.layout_id = $2
    )
    AND updated_at < $3::timestamp`;

// Grades have no layout_id, so they are scoped to the layout's climbs through
// the SAME correlated EXISTS the syncClimbGrades resolver uses — import wider
// than the resolver's scope and rows are merely redundant, narrower and a row
// inside the stamped watermark is lost forever.
const GRADES_WHERE = `board_type = $1
    AND EXISTS (
      SELECT 1 FROM board_climbs bc
      WHERE bc.uuid = board_climb_grades.climb_uuid AND bc.board_type = $1 AND bc.layout_id = $2
    )
    AND computed_at < $3::timestamp`;

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

type FenceRow = {
  stable_before: unknown;
  target_lsn: unknown;
  primary_system_identifier?: unknown;
  primary_timeline_id?: unknown;
};
type CutoffAgeRow = { age_seconds: unknown };

export type ReplicaReplayStatus = {
  inRecovery: boolean;
  replayPaused: boolean;
  replayLsn: string;
  reachedTarget: boolean;
  replayLagSeconds: number | null;
  systemIdentifier: string;
  timelineId: number;
  receiverStatus: string;
  receiverTimelineId: number;
};

type DatabaseIdentity = {
  inRecovery: boolean;
  systemIdentifier: string;
  timelineId: number;
};

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredExporterImageDigest(): string {
  const imageDigest = requiredEnvironment('SNAPSHOT_EXPORTER_IMAGE_DIGEST');
  if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest)) {
    throw new Error('SNAPSHOT_EXPORTER_IMAGE_DIGEST must be an exact sha256 digest');
  }
  return imageDigest;
}

function positiveEnvironmentSeconds(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number of seconds, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function isLocalDatabaseUrl(connectionString: string): boolean {
  try {
    const hostname = new URL(connectionString).hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
    return ['localhost', '127.0.0.1', '::1'].includes(hostname);
  } catch {
    return false;
  }
}

export function createIsolatedSnapshotPool(connectionString: string, max: number): Sql {
  const sqlClient = postgres(connectionString, {
    max,
    idle_timeout: 30,
    connect_timeout: 30,
    prepare: false,
    // The coordinator crosses the public internet. `require` encrypts but does
    // not authenticate the server certificate/hostname; `verify-full` does.
    // Plaintext is accepted only for a literal loopback URL. A Docker DNS name
    // is not proof that the connection stayed on the local machine.
    ssl: isLocalDatabaseUrl(connectionString) ? false : 'verify-full',
    types: SNAPSHOT_POSTGRES_TYPES,
  });
  return sqlClient;
}

/**
 * postgres.js ReservedSql deliberately lacks `.begin()`. Snapshot reads still
 * need one REPEATABLE READ transaction on the exact backend whose identity or
 * replay state was validated, so expose a pool-shaped view whose transaction
 * runner issues BEGIN/COMMIT/ROLLBACK on that reserved session itself.
 */
export function reservedSnapshotClient(reservedClient: ReservedSql): Sql {
  const beginReservedTransaction = async (
    callback: (transaction: TransactionSql) => Promise<unknown>,
  ): Promise<unknown> => {
    await reservedClient.unsafe('BEGIN');
    try {
      const result = await callback(reservedClient as unknown as TransactionSql);
      await reservedClient.unsafe('COMMIT');
      return result;
    } catch (error) {
      await reservedClient.unsafe('ROLLBACK').catch(() => {});
      throw error;
    }
  };

  return new Proxy(reservedClient as unknown as Sql, {
    apply(target, _thisArgument, argumentsList) {
      return Reflect.apply(target, target, argumentsList);
    },
    get(target, property) {
      if (property === 'begin') return beginReservedTransaction;
      return Reflect.get(target, property, target);
    },
  });
}

function fenceRowFrom(rows: readonly unknown[], description: string): FenceRow {
  const row = rows[0] as FenceRow | undefined;
  if (!row?.stable_before || !row.target_lsn) {
    throw new Error(`${description} did not return stable_before and target_lsn`);
  }
  return row;
}

function fenceIdentityFrom(row: FenceRow): { systemIdentifier: string; timelineId: number } {
  const systemIdentifier = row.primary_system_identifier;
  const timelineId = Number(row.primary_timeline_id);
  if (typeof systemIdentifier !== 'string' || !/^\d+$/.test(systemIdentifier)) {
    throw new Error('board snapshot fence returned an invalid PostgreSQL system identifier');
  }
  if (!Number.isSafeInteger(timelineId) || timelineId <= 0) {
    throw new Error('board snapshot fence returned an invalid PostgreSQL timeline');
  }
  return { systemIdentifier, timelineId };
}

async function readDatabaseIdentity(sqlClient: Sql): Promise<DatabaseIdentity> {
  const rows = await sqlClient.unsafe(
    `SELECT pg_is_in_recovery() AS in_recovery,
            identity.system_identifier,
            identity.timeline_id
     FROM ops.board_snapshot_cluster_identity() AS identity`,
  );
  const row = rows[0] as unknown as {
    in_recovery?: unknown;
    system_identifier?: unknown;
    timeline_id?: unknown;
  };
  const timelineId = Number(row?.timeline_id);
  if (typeof row?.system_identifier !== 'string' || !/^\d+$/.test(row.system_identifier)) {
    throw new Error('snapshot database returned an invalid PostgreSQL system identifier');
  }
  if (!Number.isSafeInteger(timelineId) || timelineId <= 0) {
    throw new Error('snapshot database returned an invalid PostgreSQL timeline');
  }
  return {
    inRecovery: row.in_recovery === true,
    systemIdentifier: row.system_identifier,
    timelineId,
  };
}

function assertPrimaryDatabaseIdentity(
  identity: DatabaseIdentity,
  expectedSystemIdentifier: string,
  expectedTimelineId: number,
): void {
  if (identity.inRecovery) {
    throw new Error('snapshot primary read URL points at a standby');
  }
  if (identity.systemIdentifier !== expectedSystemIdentifier) {
    throw new Error('snapshot primary read URL belongs to a different PostgreSQL system');
  }
  if (identity.timelineId !== expectedTimelineId) {
    throw new Error(
      `snapshot primary read URL timeline does not match coordinator (read=${identity.timelineId}, coordinator=${expectedTimelineId})`,
    );
  }
}

export async function readReplicaReplayStatus(sqlClient: Sql, targetLsn: string): Promise<ReplicaReplayStatus> {
  const rows = await sqlClient.unsafe(
    `SELECT pg_is_in_recovery() AS in_recovery,
            CASE WHEN pg_is_in_recovery() THEN pg_is_wal_replay_paused() ELSE false END AS replay_paused,
            pg_last_wal_replay_lsn()::text AS replay_lsn,
            COALESCE(pg_last_wal_replay_lsn() >= $1::pg_lsn, false) AS reached_target,
            CASE
              WHEN pg_last_wal_replay_lsn() >= $1::pg_lsn THEN 0
              WHEN pg_last_xact_replay_timestamp() IS NULL THEN NULL
              ELSE EXTRACT(EPOCH FROM (clock_timestamp() - pg_last_xact_replay_timestamp()))::double precision
            END AS replay_lag_seconds,
            identity.system_identifier,
            identity.timeline_id,
            COALESCE(receiver.status, '') AS receiver_status,
            COALESCE(receiver.received_tli, 0)::bigint AS receiver_timeline_id
     FROM ops.board_snapshot_cluster_identity() AS identity
     LEFT JOIN LATERAL (
       SELECT status, received_tli
       FROM pg_stat_wal_receiver
       LIMIT 1
     ) AS receiver ON true`,
    [targetLsn],
  );
  const row = rows[0] as unknown as {
    in_recovery: unknown;
    replay_paused: unknown;
    replay_lsn: unknown;
    reached_target: unknown;
    replay_lag_seconds: unknown;
    system_identifier: unknown;
    timeline_id: unknown;
    receiver_status: unknown;
    receiver_timeline_id: unknown;
  };
  if (row.replay_lsn != null && typeof row.replay_lsn !== 'string') {
    throw new Error('snapshot replica returned an invalid replay LSN');
  }
  if (typeof row.system_identifier !== 'string' || !/^\d+$/.test(row.system_identifier)) {
    throw new Error('snapshot database returned an invalid PostgreSQL system identifier');
  }
  if (typeof row.receiver_status !== 'string') throw new Error('snapshot database returned an invalid receiver status');
  const timelineId = Number(row.timeline_id);
  const receiverTimelineId = Number(row.receiver_timeline_id);
  const inRecovery = row.in_recovery === true;
  if (
    !Number.isSafeInteger(timelineId) ||
    timelineId <= 0 ||
    !Number.isSafeInteger(receiverTimelineId) ||
    (inRecovery && receiverTimelineId <= 0)
  ) {
    throw new Error('snapshot database returned an invalid PostgreSQL timeline');
  }
  return {
    inRecovery,
    replayPaused: row.replay_paused === true,
    replayLsn: row.replay_lsn ?? '',
    reachedTarget: row.reached_target === true,
    replayLagSeconds: row.replay_lag_seconds == null ? null : Number(row.replay_lag_seconds),
    systemIdentifier: row.system_identifier,
    timelineId,
    receiverStatus: row.receiver_status,
    receiverTimelineId,
  };
}

function assertReplicaIdentityAndReceiver(
  status: ReplicaReplayStatus,
  expectedSystemIdentifier: string,
  expectedTimelineId: number,
): void {
  if (
    !Number.isSafeInteger(expectedTimelineId) ||
    expectedTimelineId <= 0 ||
    !Number.isSafeInteger(status.timelineId) ||
    status.timelineId <= 0 ||
    !Number.isSafeInteger(status.receiverTimelineId) ||
    status.receiverTimelineId <= 0
  ) {
    throw new Error('snapshot replica returned an invalid PostgreSQL timeline');
  }
  if (status.systemIdentifier !== expectedSystemIdentifier) {
    throw new Error('snapshot replica belongs to a different PostgreSQL system');
  }
  if (status.receiverStatus !== 'streaming') {
    throw new Error(`snapshot replica WAL receiver is ${status.receiverStatus || 'missing'}, expected streaming`);
  }
  if (status.receiverTimelineId !== expectedTimelineId || status.timelineId !== expectedTimelineId) {
    throw new Error(
      `snapshot replica timeline does not match primary (control=${status.timelineId}, receiver=${status.receiverTimelineId}, primary=${expectedTimelineId})`,
    );
  }
}

export async function waitForReplicaReplay(params: {
  sqlClient: Sql;
  targetLsn: string;
  maxLagSeconds: number;
  timeoutSeconds: number;
  expectedSystemIdentifier: string;
  expectedTimelineId: number;
  pollMilliseconds?: number;
  readStatus?: (sqlClient: Sql, targetLsn: string) => Promise<ReplicaReplayStatus>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}): Promise<ReplicaReplayStatus> {
  const now = params.now ?? Date.now;
  const deadline = now() + params.timeoutSeconds * 1000;
  const pollMilliseconds = params.pollMilliseconds ?? 1000;
  const readStatus = params.readStatus ?? readReplicaReplayStatus;
  const sleep = params.sleep ?? delay;
  let firstPoll = true;
  const timeoutError = (): Error =>
    new Error(`snapshot replica did not replay target ${params.targetLsn} within ${params.timeoutSeconds}s`);
  while (true) {
    if (!firstPoll && now() >= deadline) throw timeoutError();
    firstPoll = false;
    const status = await readStatus(params.sqlClient, params.targetLsn);
    if (!status.inRecovery) throw new Error('snapshot replica is not in recovery; refusing to read a writable server');
    assertReplicaIdentityAndReceiver(status, params.expectedSystemIdentifier, params.expectedTimelineId);
    if (status.replayPaused) throw new Error('snapshot replica WAL replay is paused');
    if (!status.replayLsn) throw new Error('snapshot replica has no replay LSN');
    if (status.reachedTarget) return status;
    if (status.replayLagSeconds == null || status.replayLagSeconds > params.maxLagSeconds) {
      throw new Error(
        `snapshot replica replay lag is ${status.replayLagSeconds ?? 'unknown'}s; maximum is ${params.maxLagSeconds}s`,
      );
    }
    const remainingMilliseconds = deadline - now();
    if (remainingMilliseconds <= 0) throw timeoutError();
    await sleep(Math.min(pollMilliseconds, remainingMilliseconds));
  }
}

async function createPrimarySnapshotContext(): Promise<SnapshotDatabaseContext> {
  // Keep the unfenced compatibility path on the same explicit timestamp
  // parser and TLS contract as fenced/replica reads. Two connections are
  // required: one holds the export transaction while the other observes it.
  const sqlClient = createIsolatedSnapshotPool(requiredEnvironment('DATABASE_URL'), 2);
  try {
    const rows = await sqlClient.unsafe(
      `SELECT ((clock_timestamp() - make_interval(secs => $1)) AT TIME ZONE 'UTC') AS stable_before,
              pg_current_wal_insert_lsn()::text AS target_lsn`,
      [DEFAULT_STABILITY_WINDOW_SECONDS],
    );
    const row = fenceRowFrom(rows, 'primary snapshot boundary');
    const targetLsn = String(row.target_lsn);
    return {
      sqlClient,
      deletionObserverConnectionAvailable: true,
      boundary: {
        source: 'primary',
        stableBefore: toIso(row.stable_before),
        stableBeforeIncludesActiveTransactions: false,
        targetLsn,
        replayLsn: targetLsn,
        systemIdentifier: 'unfenced',
        timelineId: 0,
      },
      assertPublishFence: async () => {},
      close: async () => {
        await sqlClient.end({ timeout: 5 }).catch(() => {});
      },
    };
  } catch (error) {
    await sqlClient.end({ timeout: 5 }).catch(() => {});
    throw error;
  }
}

type PrimaryFenceHandle = {
  stableBefore: string;
  targetLsn: string;
  systemIdentifier: string;
  timelineId: number;
  assertHeld: () => Promise<void>;
  close: () => Promise<void>;
};

type PrimaryFenceContractRow = {
  owners_match: unknown;
  owner_is_narrow: unknown;
  owner_memberships_exact: unknown;
  owner_function_acls_exact: unknown;
  owner_ops_schema_acl_exact: unknown;
  caller_is_narrow: unknown;
  caller_memberships_exact: unknown;
  caller_ops_schema_acl_exact: unknown;
  caller_owns_no_ops_functions: unknown;
  caller_has_no_unexpected_ops_execute: unknown;
  caller_function_acls_exact: unknown;
  public_execute_revoked: unknown;
};

// TODO(#4475 review, finding 9): the fence role/grant contract is encoded four
// times — migration 0205, the development bootstrap SQL, this assertion, and the
// backend global-setup fixture — with no parity test tying them together.
async function assertPrimaryFenceContract(coordinator: ReservedSql): Promise<void> {
  const rows = await coordinator.unsafe(`
    WITH fence_owner AS (
      SELECT * FROM pg_roles WHERE rolname = 'boardsesh_snapshot_fence_owner'
    ), application_owner AS (
      SELECT oid FROM pg_roles WHERE rolname = 'boardsesh_owner'
    ), stats_role AS (
      SELECT oid FROM pg_roles WHERE rolname = 'pg_read_all_stats'
    ), caller AS (
      SELECT * FROM pg_roles WHERE rolname = current_user
    ), expected_coordinator_function(function_oid) AS (
      VALUES
        ('ops.board_snapshot_cluster_identity()'::regprocedure),
        ('ops.acquire_board_snapshot_fence(integer)'::regprocedure),
        ('ops.board_snapshot_fence_held()'::regprocedure),
        ('ops.release_board_snapshot_fence()'::regprocedure)
    ), expected_owner_function(function_oid) AS (
      VALUES
        ('pg_catalog.pg_control_system()'::regprocedure),
        ('pg_catalog.pg_control_checkpoint()'::regprocedure),
        ('ops.board_snapshot_cluster_identity()'::regprocedure),
        ('ops.acquire_board_snapshot_fence(integer)'::regprocedure)
    )
    SELECT
      (SELECT count(*) = 2
       FROM pg_proc AS procedure
       CROSS JOIN fence_owner
       WHERE procedure.proowner = fence_owner.oid
         AND procedure.oid = ANY (ARRAY[
           'ops.board_snapshot_cluster_identity()'::regprocedure,
           'ops.acquire_board_snapshot_fence(integer)'::regprocedure
         ]))
        AND (SELECT count(*) = 2
             FROM pg_proc AS procedure
             CROSS JOIN fence_owner
             WHERE procedure.proowner = fence_owner.oid) AS owners_match,
      (SELECT NOT rolcanlogin
              AND NOT rolsuper
              AND NOT rolcreatedb
              AND NOT rolcreaterole
              AND rolinherit
              AND NOT rolreplication
              AND NOT rolbypassrls
       FROM fence_owner) AS owner_is_narrow,
      (SELECT count(*) = 1
       FROM pg_auth_members AS membership, fence_owner, stats_role
       WHERE membership.member = fence_owner.oid
         AND membership.roleid = stats_role.oid
         AND NOT membership.admin_option
         AND CASE
           WHEN current_setting('server_version_num')::integer >= 160000
             THEN (to_jsonb(membership)->>'inherit_option')::boolean
                  AND NOT (to_jsonb(membership)->>'set_option')::boolean
           ELSE true
         END)
        AND
      (SELECT count(*) = 1
       FROM pg_auth_members AS membership, fence_owner, application_owner
       WHERE membership.member = application_owner.oid
         AND membership.roleid = fence_owner.oid
         AND NOT membership.admin_option
         AND CASE
           WHEN current_setting('server_version_num')::integer >= 160000
             THEN NOT (to_jsonb(membership)->>'inherit_option')::boolean
                  AND (to_jsonb(membership)->>'set_option')::boolean
           ELSE true
         END)
        AND
      (SELECT count(*) = 2
       FROM pg_auth_members AS membership, fence_owner
       WHERE membership.member = fence_owner.oid
          OR membership.roleid = fence_owner.oid) AS owner_memberships_exact,
      (SELECT count(*) = 4
       FROM expected_owner_function AS expected
       WHERE (
         SELECT count(*) = 1 AND bool_and(NOT privilege.is_grantable)
         FROM pg_proc AS procedure
         CROSS JOIN fence_owner
         CROSS JOIN LATERAL aclexplode(procedure.proacl) AS privilege
         WHERE procedure.oid = expected.function_oid
           AND privilege.grantee = fence_owner.oid
           AND privilege.privilege_type = 'EXECUTE'
       ) IS true)
        AND (SELECT count(*) = 4
             FROM pg_proc AS procedure
             CROSS JOIN fence_owner
             CROSS JOIN LATERAL aclexplode(procedure.proacl) AS privilege
             WHERE privilege.grantee = fence_owner.oid
               AND privilege.privilege_type = 'EXECUTE') AS owner_function_acls_exact,
      (SELECT count(*) = 1 AND bool_and(NOT privilege.is_grantable)
       FROM pg_namespace AS namespace
       CROSS JOIN fence_owner
       CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS privilege
       WHERE namespace.nspname = 'ops'
         AND privilege.grantee = fence_owner.oid
         AND privilege.privilege_type = 'USAGE')
        AND (SELECT count(*) = 1 AND bool_and(NOT privilege.is_grantable)
             FROM pg_namespace AS namespace
             CROSS JOIN fence_owner
             CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS privilege
             WHERE namespace.nspname = 'ops'
               AND privilege.grantee = fence_owner.oid
               AND privilege.privilege_type = 'CREATE')
        AND (SELECT count(*) = 2
             FROM pg_namespace AS namespace
             CROSS JOIN fence_owner
             CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS privilege
             WHERE namespace.nspname = 'ops'
               AND privilege.grantee = fence_owner.oid) AS owner_ops_schema_acl_exact,
      (SELECT rolcanlogin
              AND NOT rolsuper
              AND NOT rolcreatedb
              AND NOT rolcreaterole
              AND NOT rolreplication
              AND NOT rolbypassrls
       FROM caller)
        AND NOT pg_has_role(current_user, 'pg_read_all_stats', 'USAGE')
        AND NOT pg_has_role(current_user, 'boardsesh_snapshot_fence_owner', 'MEMBER')
        AND NOT has_schema_privilege(current_user, 'ops', 'CREATE') AS caller_is_narrow,
      (SELECT count(*) = 0
       FROM pg_auth_members AS membership, caller
       WHERE membership.member = caller.oid
          OR membership.roleid = caller.oid) AS caller_memberships_exact,
      has_schema_privilege(current_user, 'ops', 'USAGE')
        AND (SELECT count(*) = 1
                    AND bool_and(privilege.privilege_type = 'USAGE')
                    AND bool_and(NOT privilege.is_grantable)
             FROM pg_namespace AS namespace
             CROSS JOIN caller
             CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS privilege
             WHERE namespace.nspname = 'ops'
               AND privilege.grantee = caller.oid) AS caller_ops_schema_acl_exact,
      NOT EXISTS (
        SELECT 1
        FROM pg_proc AS procedure
        JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        CROSS JOIN caller
        WHERE namespace.nspname = 'ops'
          AND procedure.proowner = caller.oid
      ) AS caller_owns_no_ops_functions,
      NOT EXISTS (
        SELECT 1
        FROM pg_proc AS procedure
        JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'ops'
          AND NOT EXISTS (
            SELECT 1
            FROM expected_coordinator_function AS expected
            WHERE expected.function_oid = procedure.oid
          )
          AND has_function_privilege(current_user, procedure.oid, 'EXECUTE')
      ) AS caller_has_no_unexpected_ops_execute,
      (SELECT bool_and(has_function_privilege(current_user, expected.function_oid, 'EXECUTE'))
       FROM expected_coordinator_function AS expected)
        AND (SELECT count(*) = 4
             FROM expected_coordinator_function AS expected
             WHERE (
               SELECT count(*) = 1 AND bool_and(NOT privilege.is_grantable)
               FROM pg_proc AS procedure
               CROSS JOIN caller
               CROSS JOIN LATERAL aclexplode(procedure.proacl) AS privilege
               WHERE procedure.oid = expected.function_oid
                 AND privilege.grantee = caller.oid
                 AND privilege.privilege_type = 'EXECUTE'
             ) IS true)
        AND (SELECT count(*) = 4
             FROM pg_proc AS procedure
             JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
             CROSS JOIN caller
             CROSS JOIN LATERAL aclexplode(procedure.proacl) AS privilege
             WHERE namespace.nspname = 'ops'
               AND privilege.grantee = caller.oid
               AND privilege.privilege_type = 'EXECUTE')
        AS caller_function_acls_exact,
      NOT EXISTS (
        SELECT 1
        FROM pg_proc AS function
        JOIN pg_namespace AS namespace ON namespace.oid = function.pronamespace
        CROSS JOIN LATERAL aclexplode(COALESCE(function.proacl, acldefault('f', function.proowner))) AS acl
        WHERE namespace.nspname = 'ops'
          AND acl.grantee = 0
          AND acl.privilege_type = 'EXECUTE'
      ) AS public_execute_revoked
  `);
  const contract = rows[0] as unknown as PrimaryFenceContractRow | undefined;
  const failedChecks = contract
    ? Object.entries(contract)
        .filter(([, passed]) => passed !== true)
        .map(([name]) => name)
    : ['missing_contract_row'];
  if (failedChecks.length > 0) {
    throw new Error(`primary snapshot fence role/grant audit failed: ${failedChecks.join(', ')}`);
  }
}

async function releasePrimaryFence(params: {
  coordinator: ReservedSql | null;
  coordinatorPool: Sql;
  lockMayBeHeld: boolean;
}): Promise<void> {
  if (params.coordinator) {
    if (params.lockMayBeHeld) {
      try {
        await params.coordinator.unsafe('SELECT ops.release_board_snapshot_fence() AS released');
      } catch (error) {
        logger.warn('[export-snapshots] failed to release primary snapshot fence', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    params.coordinator.release();
  }
  await params.coordinatorPool.end({ timeout: 5 }).catch(() => {});
}

async function acquirePrimaryFence(): Promise<PrimaryFenceHandle> {
  const coordinatorUrl = requiredEnvironment('DATABASE_DIRECT_URL');
  const coordinatorPool = createIsolatedSnapshotPool(coordinatorUrl, 1);
  let coordinator: ReservedSql | null = null;
  let lockMayBeHeld = false;
  try {
    coordinator = await coordinatorPool.reserve();
    await assertPrimaryFenceContract(coordinator);
    const fenceRows = await coordinator.unsafe(
      `SELECT stable_before, target_lsn::text, primary_system_identifier, primary_timeline_id
       FROM ops.acquire_board_snapshot_fence($1)`,
      [DEFAULT_STABILITY_WINDOW_SECONDS],
    );
    lockMayBeHeld = true;
    const fence = fenceRowFrom(fenceRows, 'board snapshot fence');
    const stableBefore = toIso(fence.stable_before);
    const targetLsn = String(fence.target_lsn);
    const identity = fenceIdentityFrom(fence);

    const maxCutoffAgeSeconds = positiveEnvironmentSeconds(
      'SNAPSHOT_MAX_CUTOFF_AGE_SECONDS',
      DEFAULT_SNAPSHOT_MAX_CUTOFF_AGE_SECONDS,
    );

    const assertCutoffAge = async (): Promise<void> => {
      if (!coordinator) throw new Error('snapshot coordinator connection was released before publish');
      const cutoffAgeRows = await coordinator.unsafe(
        `SELECT EXTRACT(EPOCH FROM ((clock_timestamp() AT TIME ZONE 'UTC') - $1::timestamp))::double precision
                AS age_seconds`,
        [stableBefore],
      );
      const cutoffAge = Number((cutoffAgeRows[0] as unknown as CutoffAgeRow | undefined)?.age_seconds);
      if (!Number.isFinite(cutoffAge) || cutoffAge < 0 || cutoffAge > maxCutoffAgeSeconds) {
        throw new Error(`snapshot fence cutoff age is ${cutoffAge}s; maximum is ${maxCutoffAgeSeconds}s`);
      }
    };
    await assertCutoffAge();

    const assertHeld = async (): Promise<void> => {
      if (!coordinator) throw new Error('snapshot coordinator connection was released before publish');
      const heldRows = await coordinator.unsafe('SELECT ops.board_snapshot_fence_held() AS held');
      const held = (heldRows[0] as unknown as { held?: unknown } | undefined)?.held;
      if (held !== true) throw new Error('primary snapshot fence was lost before publish');
      // Long exports must not advertise a freshly-completed heartbeat for a
      // cutoff which became stale while artifacts were being built/uploaded.
      await assertCutoffAge();
    };

    return {
      stableBefore,
      targetLsn,
      ...identity,
      assertHeld,
      close: async () => {
        await releasePrimaryFence({ coordinator, coordinatorPool, lockMayBeHeld });
        coordinator = null;
        lockMayBeHeld = false;
      },
    };
  } catch (error) {
    await releasePrimaryFence({ coordinator, coordinatorPool, lockMayBeHeld });
    throw error;
  }
}

async function createFencedPrimarySnapshotContext(): Promise<SnapshotDatabaseContext> {
  const primaryPool = createIsolatedSnapshotPool(requiredEnvironment('DATABASE_URL'), 1);
  let primaryReader: ReservedSql | null = null;
  let fence: PrimaryFenceHandle | null = null;
  try {
    primaryReader = await primaryPool.reserve();
    const reservedPrimaryReader = primaryReader;
    const snapshotPrimaryReader = reservedSnapshotClient(reservedPrimaryReader);
    fence = await acquirePrimaryFence();
    const assertPublishFence = async (): Promise<void> => {
      if (!fence) throw new Error('snapshot coordinator connection was released before publish');
      await fence.assertHeld();
      assertPrimaryDatabaseIdentity(
        await readDatabaseIdentity(reservedPrimaryReader),
        fence.systemIdentifier,
        fence.timelineId,
      );
    };
    await assertPublishFence();
    return {
      // Identity checks and every REPEATABLE READ bulk transaction stay on one
      // reserved backend. A mixed/load-balanced URL cannot validate against one
      // server and stream rows from another.
      sqlClient: snapshotPrimaryReader,
      deletionObserverConnectionAvailable: false,
      boundary: {
        source: 'primary',
        stableBefore: fence.stableBefore,
        stableBeforeIncludesActiveTransactions: true,
        targetLsn: fence.targetLsn,
        replayLsn: fence.targetLsn,
        systemIdentifier: fence.systemIdentifier,
        timelineId: fence.timelineId,
      },
      assertPublishFence,
      close: async () => {
        primaryReader?.release();
        primaryReader = null;
        await fence?.close();
        fence = null;
        await primaryPool.end({ timeout: 5 }).catch(() => {});
      },
    };
  } catch (error) {
    primaryReader?.release();
    await fence?.close();
    await primaryPool.end({ timeout: 5 }).catch(() => {});
    throw error;
  }
}

async function createReplicaSnapshotContext(): Promise<SnapshotDatabaseContext> {
  const replicaUrl = requiredEnvironment('SNAPSHOT_REPLICA_DATABASE_URL');
  const replicaPool = createIsolatedSnapshotPool(replicaUrl, 1);
  let replicaReader: ReservedSql | null = null;
  let fence: PrimaryFenceHandle | null = null;
  try {
    replicaReader = await replicaPool.reserve();
    const snapshotReplicaReader = reservedSnapshotClient(replicaReader);
    fence = await acquirePrimaryFence();

    const maxLagSeconds = positiveEnvironmentSeconds(
      'SNAPSHOT_REPLICA_MAX_LAG_SECONDS',
      DEFAULT_REPLICA_MAX_LAG_SECONDS,
    );
    const timeoutSeconds = positiveEnvironmentSeconds('SNAPSHOT_REPLICA_WAIT_SECONDS', DEFAULT_REPLICA_WAIT_SECONDS);
    const replayStatus = await waitForReplicaReplay({
      sqlClient: snapshotReplicaReader,
      targetLsn: fence.targetLsn,
      maxLagSeconds,
      timeoutSeconds,
      expectedSystemIdentifier: fence.systemIdentifier,
      expectedTimelineId: fence.timelineId,
    });

    const assertPublishFence = async (): Promise<void> => {
      if (!fence) throw new Error('snapshot coordinator connection was released before publish');
      if (!replicaReader) throw new Error('snapshot replica connection was released before publish');
      await fence.assertHeld();
      const currentReplay = await readReplicaReplayStatus(replicaReader, fence.targetLsn);
      assertReplicaIdentityAndReceiver(currentReplay, fence.systemIdentifier, fence.timelineId);
      if (!currentReplay.inRecovery || currentReplay.replayPaused || !currentReplay.reachedTarget) {
        throw new Error('snapshot replica no longer satisfies the replay barrier before publish');
      }
    };

    return {
      // Replay checks and all bulk transactions stay on the exact same local
      // standby backend for the full run.
      sqlClient: snapshotReplicaReader,
      deletionObserverConnectionAvailable: false,
      boundary: {
        source: 'replica',
        stableBefore: fence.stableBefore,
        stableBeforeIncludesActiveTransactions: true,
        targetLsn: fence.targetLsn,
        replayLsn: replayStatus.replayLsn,
        systemIdentifier: fence.systemIdentifier,
        timelineId: fence.timelineId,
      },
      assertPublishFence,
      close: async () => {
        replicaReader?.release();
        replicaReader = null;
        await fence?.close();
        fence = null;
        await replicaPool.end({ timeout: 5 }).catch(() => {});
      },
    };
  } catch (error) {
    replicaReader?.release();
    await fence?.close();
    await replicaPool.end({ timeout: 5 }).catch(() => {});
    throw error;
  }
}

async function createSnapshotDatabaseContext(
  source: SnapshotDatabaseSource,
  requireFence: boolean,
): Promise<SnapshotDatabaseContext> {
  if (source === 'replica') return createReplicaSnapshotContext();
  return requireFence ? createFencedPrimarySnapshotContext() : createPrimarySnapshotContext();
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
  stableBefore: string;
}): Promise<boolean> {
  const { sqlClient, pair, tableName, watermark, threshold, stableBefore } = params;
  const cursorColumn = cursorColumnFor(tableName);
  const rows = await sqlClient.unsafe(
    `SELECT 1
     FROM ${tableName}
     WHERE ${whereClauseFor(tableName)}
       AND (${cursorColumn}, sync_seq) > ($4::timestamp, $5::bigint)
     ORDER BY ${cursorColumn} ASC, sync_seq ASC
     LIMIT $6`,
    [pair.boardType, pair.layoutId, stableBefore, watermark.watermarkUpdatedAt, watermark.watermarkSyncSeq, threshold],
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
  stableBefore: string;
}): Promise<RefreshReason | null> {
  const { sqlClient, pair, previousEntry, threshold, includeGrades, stableBefore } = params;
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
    if (await hasDeltaAtThreshold({ sqlClient, pair, tableName, watermark, threshold, stableBefore })) {
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
 * Pick the oldest safe replay bound for an unfenced primary export. The
 * run-wide stableBefore is authoritative for row filtering; builtAt and the
 * export/oldest transaction starts can only widen the tombstone rewind.
 */
export function selectDeletionReplayBoundary(params: {
  artifactBuiltAt: unknown;
  stableBefore: unknown;
  exportTransactionStartedAt: unknown;
  oldestActiveTransactionStartedAt: unknown;
  visibilityEstablished: boolean;
}): string | null {
  if (!params.visibilityEstablished) return null;
  const artifactBuiltAt = normalizedProbeTimestamp(params.artifactBuiltAt);
  const stableBefore = normalizedProbeTimestamp(params.stableBefore);
  const exportTransactionStartedAt = normalizedProbeTimestamp(params.exportTransactionStartedAt);
  if (!artifactBuiltAt || !stableBefore || !exportTransactionStartedAt) return null;

  const oldestActiveTransaction = normalizedProbeTimestamp(params.oldestActiveTransactionStartedAt);
  const replayFromMs = Math.min(
    artifactBuiltAt.timestampMs,
    stableBefore.timestampMs,
    exportTransactionStartedAt.timestampMs,
    oldestActiveTransaction?.timestampMs ?? Number.POSITIVE_INFINITY,
  );
  return new Date(replayFromMs).toISOString();
}

function selectFencedDeletionReplayBoundary(artifactBuiltAt: unknown, stableBefore: unknown): string | null {
  const normalizedArtifactBuiltAt = normalizedProbeTimestamp(artifactBuiltAt);
  const normalizedStableBefore = normalizedProbeTimestamp(stableBefore);
  if (!normalizedArtifactBuiltAt || !normalizedStableBefore) return null;
  return new Date(Math.min(normalizedArtifactBuiltAt.timestampMs, normalizedStableBefore.timestampMs)).toISOString();
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
  observerConnectionAvailable: boolean;
  applicationName: string;
  artifactBuiltAt: string;
  stableBefore: string;
}): Promise<DeletionReplayMetadataResult> {
  const { sqlClient, observerConnectionAvailable, applicationName, artifactBuiltAt, stableBefore } = params;
  // The observer must not queue behind the export connection forever. The
  // production unfenced context explicitly provisions max=2. Generic callers
  // fail closed unless they explicitly guarantee equivalent capacity.
  if (!observerConnectionAvailable) {
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
      stableBefore,
      exportTransactionStartedAt: probe.export_xact_start,
      oldestActiveTransactionStartedAt: probe.oldest_same_role_xact_start,
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
  /** Primary-issued, run-wide exclusive cursor cutoff. */
  stableBefore: string;
  /** True only when the primary fence folded every open primary transaction into stableBefore. */
  stableBeforeIncludesActiveTransactions?: boolean;
  /** The SQL client has a spare connection which can observe this export transaction. */
  deletionObserverConnectionAvailable?: boolean;
  streamBatchSize?: number;
}): Promise<LayoutSnapshotResult> {
  const {
    sqlClient,
    boardType,
    layoutId,
    filePath,
    builtAt,
    gradesFilePath,
    stableBefore,
    stableBeforeIncludesActiveTransactions = false,
    deletionObserverConnectionAvailable = false,
  } = params;
  const streamBatchSize = params.streamBatchSize ?? 5000;
  const scopeParams: (string | number)[] = [boardType, layoutId, stableBefore];

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
      // ordering closes. SELECT set_config(...) is not equivalent here because
      // it can establish the transaction snapshot before the probe. Fail the
      // generated prefix + UUID through a strict allowlist before the one SET
      // statement which PostgreSQL does not accept a bind parameter for.
      if (
        !/^boardsesh-snapshot-export-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          exportApplicationName,
        )
      ) {
        throw new Error('snapshot export application name failed validation');
      }
      await tx.unsafe(`SET LOCAL application_name = '${exportApplicationName}'`);
      const fencedReplayBoundary = stableBeforeIncludesActiveTransactions
        ? selectFencedDeletionReplayBoundary(builtAt, stableBefore)
        : null;
      const deletionReplayMetadata: DeletionReplayMetadataResult = stableBeforeIncludesActiveTransactions
        ? fencedReplayBoundary
          ? { deletionsReplayFrom: fencedReplayBoundary, deletionsReplayFallbackReason: null }
          : { deletionsReplayFrom: null, deletionsReplayFallbackReason: 'invalid-probe-timestamp' }
        : await probeDeletionReplayBoundary({
            sqlClient,
            observerConnectionAvailable: deletionObserverConnectionAvailable,
            applicationName: exportApplicationName,
            artifactBuiltAt: builtAt,
            stableBefore,
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
  source: SnapshotDatabaseSource;
  fence: boolean;
  heartbeat: boolean;
};

function parseArgs(argv: string[]): ExportOptions {
  const options: ExportOptions = {
    dryRun: false,
    gzip: false,
    keyPrefix: DEFAULT_SNAPSHOT_KEY_PREFIX,
    source: 'primary',
    fence: false,
    heartbeat: false,
  };
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
    } else if (arg === '--source') {
      options.source = parseDatabaseSource(argv[(index += 1)]);
    } else if (arg.startsWith('--source=')) {
      options.source = parseDatabaseSource(arg.slice('--source='.length));
    } else if (arg === '--fence') {
      options.fence = true;
    } else if (arg === '--heartbeat') {
      options.heartbeat = true;
    } else {
      throw new Error(`Unknown board snapshot export argument: ${JSON.stringify(arg)}`);
    }
  }
  return options;
}

async function uploadRunHeartbeat(params: {
  options: ExportOptions;
  boundary: SnapshotReadBoundary;
  refreshedLayouts: number;
  manifestGeneratedAt: string;
}): Promise<void> {
  if (!params.options.heartbeat) return;
  const completedAt = new Date().toISOString();
  const imageDigest = requiredExporterImageDigest();
  const runKinds: readonly ('full' | 'refresh')[] =
    params.options.refreshThreshold === undefined ? ['full', 'refresh'] : ['refresh'];

  // A full run is also the newest refresh. Publish `full` first and `refresh`
  // last: the watchdog treats refresh as the manifest/lineage anchor, so a
  // failure between these writes cannot advertise the partial pair as healthy.
  for (const runKind of runKinds) {
    const heartbeatKey = `board-snapshots/ops/${runKind}.json`;
    const heartbeat = {
      formatVersion: 1,
      completedAt,
      runKind,
      source: params.boundary.source,
      imageDigest,
      keyPrefix: params.options.keyPrefix,
      stableBefore: params.boundary.stableBefore,
      targetLsn: params.boundary.targetLsn,
      replayLsn: params.boundary.replayLsn,
      systemIdentifier: params.boundary.systemIdentifier,
      timelineId: params.boundary.timelineId,
      manifestGeneratedAt: params.manifestGeneratedAt,
      refreshedLayouts: params.refreshedLayouts,
    };
    await uploadToS3(Buffer.from(JSON.stringify(heartbeat)), heartbeatKey, 'application/json', {
      cacheControl: HEARTBEAT_CACHE_CONTROL,
    });
    logger.info('[export-snapshots] heartbeat uploaded', { key: heartbeatKey, ...heartbeat });
  }
}

function parseDatabaseSource(raw: string | undefined): SnapshotDatabaseSource {
  if (raw !== 'primary' && raw !== 'replica') {
    throw new Error(`--source expects "primary" or "replica", got ${JSON.stringify(raw)}`);
  }
  return raw;
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
  const manifestObject = await getFromS3Strict(options.manifestKey);
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

    const objects = await listS3Objects(`${keyPrefix}/`);
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

  if (!options.dryRun && !isS3Configured()) {
    throw new Error(
      'S3 is not configured (AWS_S3_BUCKET_NAME / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY). Use --dry-run to build locally.',
    );
  }

  if (options.dryRun && options.heartbeat) {
    throw new Error('--heartbeat cannot be combined with --dry-run');
  }

  if (options.heartbeat && isFilteredRun) {
    throw new Error('--heartbeat cannot be combined with --board/--layout: a partial run is not a freshness signal');
  }

  if (options.heartbeat && (!options.gzip || keyPrefix !== 'board-snapshots/v1-gzip')) {
    throw new Error(
      '--heartbeat is reserved for the complete live gzip prefix (use --gzip --key-prefix board-snapshots/v1-gzip)',
    );
  }

  // Validate the immutable release identity before opening a database or
  // uploading artifacts; a bad heartbeat configuration must have zero S3 side
  // effects rather than fail after the manifest is already live.
  if (options.heartbeat) requiredExporterImageDigest();

  // Primary remains the default. Replica mode is an explicit operational gate:
  // it holds a direct primary session fence, excludes every cursor at/after a
  // primary-issued cutoff below all open transactions, then waits for the
  // standby to replay a later WAL position. No replica-local clock or replay
  // timestamp is allowed to choose the row boundary.
  const databaseContext = await createSnapshotDatabaseContext(options.source, options.fence || options.heartbeat);
  const sqlClient = databaseContext.sqlClient;
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
      source: databaseContext.boundary.source,
      stableBefore: databaseContext.boundary.stableBefore,
      targetLsn: databaseContext.boundary.targetLsn,
      replayLsn: databaseContext.boundary.replayLsn,
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
          stableBefore: databaseContext.boundary.stableBefore,
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
      if (!previousManifest) {
        throw new Error('threshold refresh cannot report healthy without a published manifest');
      }
      await databaseContext.assertPublishFence();
      await uploadRunHeartbeat({
        options,
        boundary: databaseContext.boundary,
        refreshedLayouts: 0,
        manifestGeneratedAt: previousManifest.generatedAt,
      });
      logger.info('[export-snapshots] threshold refresh complete — no stale layouts', {
        scanned: discoveredPairs.length,
        threshold: options.refreshThreshold,
        keyPrefix,
      });
      return;
    }

    for (const pair of pairs) {
      // Whole-run invariant, checked OUTSIDE the per-layout catch below: a lost
      // fence or a cutoff that aged past SNAPSHOT_MAX_CUTOFF_AGE_SECONDS is not
      // one layout's failure. Checking it here fails the first iteration before
      // a single artifact is uploaded (discovery, the previous-manifest read and
      // the threshold scan all run against the same cutoff), and aborts the run
      // at the first expiry instead of burning a full build for every remaining
      // layout only to have the manifest write reject them all.
      if (!options.dryRun) await databaseContext.assertPublishFence();
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
          stableBefore: databaseContext.boundary.stableBefore,
          stableBeforeIncludesActiveTransactions: databaseContext.boundary.stableBeforeIncludesActiveTransactions,
          deletionObserverConnectionAvailable: databaseContext.deletionObserverConnectionAvailable,
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
          const canBuildPublicUrl = isS3Configured() || snapshotPublicBaseUrl() !== '';
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
          await databaseContext.assertPublishFence();
          const uploaded = await uploadToS3(
            uploadBody,
            key,
            ARTIFACT_CONTENT_TYPE,
            options.gzip ? { contentEncoding: 'gzip' } : undefined,
          );
          // Uploaded BEFORE the manifest that references it, like the
          // whole-layout artifact — the manifest is always written last, so a
          // reader never sees a key that is not on S3 yet.
          const uploadedGrades = gradesUploadBody
            ? await uploadToS3(gradesUploadBody, gradesKey, ARTIFACT_CONTENT_TYPE, { contentEncoding: 'gzip' })
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
      await databaseContext.assertPublishFence();
      await uploadToS3(Buffer.from(JSON.stringify(manifest)), manifestKey, 'application/json', {
        cacheControl: MANIFEST_CACHE_CONTROL,
      });
      // A session lock cannot make the network PUT atomic with PostgreSQL, but
      // rechecking immediately after it catches a dropped/replaced coordinator
      // connection and fails the run instead of claiming successful health.
      // This recheck also covers the heartbeat below: nothing between them
      // touches the database, so a second call could only re-read the same
      // fence state.
      await databaseContext.assertPublishFence();
      logger.info('[export-snapshots] manifest uploaded', {
        entries: mergedEntries.length,
        refreshed: newEntries.length,
        key: manifestKey,
      });

      if (failures.length === 0) {
        await uploadRunHeartbeat({
          options,
          boundary: databaseContext.boundary,
          refreshedLayouts: newEntries.length,
          manifestGeneratedAt: manifest.generatedAt,
        });
      }

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
    await databaseContext.close();
  }
}

// Only run when executed directly (`node --import tsx .../export-board-snapshots.ts`),
// never when imported by a test. closePool remains defensive for storage or
// future helper code that materializes the process-wide database client; every
// snapshot read context closes its own explicit postgres.js pool.
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
