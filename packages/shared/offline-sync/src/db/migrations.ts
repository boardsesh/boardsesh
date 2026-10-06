// Sequential on-device schema migration runner.
//
// Mirrors offline-sync-plan.md §"Schema migration across embedded + live databases":
// the app stamps an integer schema version into a single-row `schema_version` table
// and, on every launch, applies any migrations whose version is greater than the
// stored one, in order, each inside its own transaction. Running it again is a
// no-op (idempotent), so it is safe to call unconditionally at startup — including
// against a pre-warmed DB built at an older app version.
//
// Pure logic: it only touches the structural executor surface in ../database, so a
// node-based fake (or node:sqlite) can exercise the version bookkeeping without
// loading native expo-sqlite.
//
// DOWNGRADE RULE (docs/offline-sync-plan.md, "Older JS on a newer database"): JS can
// go backwards on a device. A reverted canary OTA, or a climber leaving the
// early-updates track, puts an older bundle on a database a newer bundle already
// migrated. This runner only moves forward, so it REFUSES such a database instead
// of running against a schema it does not know: see `readSchemaCompatibility`. It
// never rewrites, re-stamps or deletes the newer file.
//
// The other half of the rule is on whoever edits this file: a migration must leave
// a schema the PREVIOUS stable bundle can still read. Expand first (add a nullable
// column, a new table, an index); contract (drop, rename, tighten) a release later,
// once no bundle that reads the old shape can come back. CI holds a PR that changes
// this file until its description says so (`@boardsesh/pr-body`,
// offline-migration.ts).

import {
  BOARD_CLIMB_HOLD_POSTINGS,
  BOARD_CLIMB_HOLD_SETS,
  HOLDS_INDEX_CLIMBS,
  INDEX_CLIMBS_SYNC_SEQ,
  DEVICE_ONLY_STATEMENTS,
  SCHEMA_STATEMENTS,
  SPRAY_WALLS,
} from './schema';
import { applyBusyTimeout } from './pragmas';
import { requeueTransportDeadLetters, setDeadLetterRecoveryNotice } from '../mutation-queue/dead-letter-recovery';
import type { OfflineDatabase, SqlExecutor } from '../database';

export type Migration = {
  version: number;
  statements: string[];
  /**
   * An optional DATA step, run after `statements` and inside the SAME exclusive
   * transaction as the version stamp. Exists for the one thing a DDL string
   * cannot do: reuse the queue's own row transitions instead of restating them
   * as bulk SQL that can drift from them (issue #5335). Sharing the transaction
   * is what makes such a step interruption-safe — a killed app rolls the rows
   * and the stamp back together, and the migration re-runs cleanly next launch.
   */
  run?: (txn: SqlExecutor) => Promise<void>;
};

// Migration 1 stands up the full v1 schema. Future schema changes append
// { version: 2, statements: [...] }, etc. — never edit a shipped migration.
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: SCHEMA_STATEMENTS,
  },
  {
    // Structured climb characteristics (server `characteristics text[]`), stored
    // locally as a JSON-string TEXT like the other array columns. Synced so offline
    // browse + the BLE no-match guard can read them. Added as an ALTER (not a v1
    // CREATE edit) so existing v1 databases pick it up without a re-crawl.
    version: 2,
    statements: ['ALTER TABLE board_climbs ADD COLUMN characteristics TEXT;'],
  },
  {
    // Logbook read path: per-board tick list ordered by recency.
    version: 3,
    statements: [
      'CREATE INDEX IF NOT EXISTS idx_ticks_board_climbed_at ON boardsesh_ticks (board_type, climbed_at DESC);',
    ],
  },
  {
    // Boardsesh grade (the nightly data-science per-climb+angle grade). A new
    // per-board reference table, so it's a v4 CREATE rather than an edit to v1's
    // SCHEMA_STATEMENTS (which would be editing a shipped migration). Columns +
    // types mirror board_climb_stats' declaration in schema.ts and the syncClimbGrades
    // resolver's selectList (docs/sync-table-manifest.md): grades are floats (REAL),
    // ascensionist_count an INTEGER snapshot, computed_at the ISO cursor timestamp,
    // sync_seq the bigserial cursor. PK (board_type, climb_uuid, angle) matches the
    // table-config primaryKeyColumns so INSERT OR REPLACE dedupes on re-sync. Kept
    // inline (not added to SCHEMA_STATEMENTS) exactly like the v2 ALTER and v3 index.
    version: 4,
    statements: [
      `CREATE TABLE IF NOT EXISTS board_climb_grades (
  board_type TEXT NOT NULL,
  climb_uuid TEXT NOT NULL,
  angle INTEGER NOT NULL,
  local_grade REAL,
  universal_grade REAL,
  grade_low REAL,
  grade_high REAL,
  confidence TEXT,
  ascensionist_count INTEGER,
  computed_at TEXT,
  sync_seq INTEGER,
  PRIMARY KEY (board_type, climb_uuid, angle)
);`,
    ],
  },
  {
    // Community-hidden flag (server `board_climbs.is_hidden`), stored locally as
    // INTEGER like the other booleans. Synced so offline browse can filter out
    // climbs the community has hidden. Added as an ALTER (not a v1 CREATE edit)
    // so existing databases pick it up without a re-crawl.
    version: 5,
    statements: ['ALTER TABLE board_climbs ADD COLUMN is_hidden INTEGER;'],
  },
  {
    // One-time recovery of the sends #5295 threw away (issue #5335). Two
    // transport failures the old classifier did not recognise dead-lettered a
    // queued send on attempt 0 of 10; roughly 17 climbers have a row holding a
    // send they logged and believe is recorded. This puts exactly those rows
    // back on the queue — matched on the recorded error and nothing else, so a
    // row a server permanently rejected stays where it is.
    //
    // A data step rather than a statement list because the row transition must
    // BE `retryDeadLetter`, the same one the manual Sync-issues retry uses. It
    // is version-stamped like any other migration, which is what makes it
    // once-per-install, and it shares the migration's transaction, which is
    // what makes an interrupted launch leave every row either `pending` or
    // `dead_letter` and never a third thing.
    //
    // MUST ship with or after the #5295 classifier fix: revived rows meeting the
    // old classifier would dead-letter again on the first hiccup.
    version: 6,
    statements: [],
    run: async (txn) => {
      const requeued = await requeueTransportDeadLetters(txn);
      // Only a real recovery leaves a trace. Every fresh install runs this
      // migration against an empty queue, and none of them should owe anybody a
      // notice.
      if (requeued > 0) await setDeadLetterRecoveryNotice(txn, requeued);
    },
  },
  {
    // How many of a climb's holds have come off the wall (server
    // `board_climbs.missing_hold_count`, materialised by
    // `recomputeMissingHoldCounts` whenever a spray-wall reset lands). Nullable
    // INTEGER here because it is nullable there: every climb on the eight
    // catalogue boards carries NULL, holds do not come off a Kilter.
    //
    // This is what lets the offline climb search answer the Intact / Lost-holds
    // filter (SW-12) instead of declining it. An ALTER rather than a v1 edit, so
    // an existing database picks it up without a re-crawl — and, deliberately,
    // WITHOUT a `refreshRevision` bump; see the comment on `board_climbs` in
    // sync/table-config.ts for why a bump would be the expensive wrong answer.
    version: 7,
    statements: ['ALTER TABLE board_climbs ADD COLUMN missing_hold_count INTEGER;'],
  },
  {
    // Spray walls: the photo identity, geometry and holds of a runtime-created
    // wall (issue #5448). A new per-board reference table, so it is a v8 CREATE
    // rather than an edit to v1's SCHEMA_STATEMENTS, exactly like
    // board_climb_grades at v4. The DDL text lives in schema.ts with the rest of
    // the on-device DDL.
    //
    // No index: the table is read by its primary key (`layout_id`) and holds at
    // most `MAX_SPRAY_WALLS_PER_USER` rows per account.
    version: 8,
    statements: [SPRAY_WALLS],
  },
  {
    version: 9,
    statements: [
      `CREATE TABLE IF NOT EXISTS followed_author_snapshots (
        user_id TEXT PRIMARY KEY NOT NULL,
        snapshot TEXT NOT NULL
      );`,
    ],
  },
  {
    // The device-derived holds index (hold heatmap + similar climbs on device).
    //
    // Three tables built on the phone from `board_climbs.frames` by
    // holds-index/hold-index.ts: a local integer id per climb uuid, one packed
    // hold set per climb, and one packed posting list per (layout, hold). NOT
    // synced tables: no TABLE_CONFIGS entry, no checkpoint, no tombstones, and
    // never part of a snapshot artifact (DEVICE_ONLY_TABLES; the export refuses
    // DDL that names them). Freshness lives in one `holds-index:<scopeKey>`
    // sync_meta watermark per downloaded scope.
    //
    // `idx_climbs_sync_seq` is on `board_climbs` because the builder walks a
    // layout in `sync_seq` order from that watermark, and asks "is anything
    // newer than the watermark?" on every read of the index. No existing index
    // carries `sync_seq`, so both would sort the whole layout each time. It is
    // in DEVICE_ONLY_STATEMENTS, so the snapshot export leaves it out of artifacts.
    //
    // Changes no artifact table (the sync_seq index is device-only), so it does
    // not move ARTIFACT_SCHEMA_VERSION: v10 clients keep importing v9 artifacts.
    version: 10,
    statements: [HOLDS_INDEX_CLIMBS, BOARD_CLIMB_HOLD_SETS, BOARD_CLIMB_HOLD_POSTINGS, INDEX_CLIMBS_SYNC_SEQ],
  },
  {
    // Climb revisions on the device (#6023): the revision a tick was logged
    // against, and on each climb its current revision and the revision at which
    // its holds last changed. Mirrors of the three Postgres columns that
    // `syncTicks` and `syncClimbs` now emit.
    //
    // All three are nullable with no default, unlike the server's
    // `revision_number NOT NULL DEFAULT 1`: a row pulled before this migration
    // has never been told its revision, and NULL says so. A reader must treat
    // NULL as unknown and never as 1. No `refreshRevision` bump either; see
    // the comment on `board_climbs` in sync/table-config.ts.
    //
    // Expand-only, so the previous bundle can still read the file once it is
    // allowed to open it. It changes `board_climbs`, an artifact table, so it
    // moves ARTIFACT_SCHEMA_VERSION to 11: a snapshot built before it lacks two
    // columns this client has and is refused until the export rebuilds it.
    version: 11,
    statements: [
      'ALTER TABLE boardsesh_ticks ADD COLUMN climb_revision INTEGER;',
      'ALTER TABLE board_climbs ADD COLUMN revision_number INTEGER;',
      'ALTER TABLE board_climbs ADD COLUMN holds_revision_number INTEGER;',
    ],
  },
  {
    // Spray climbs retired by a full reset (#6024): the mirror of
    // `board_climbs.retired_by_reset`, which `syncClimbs` now emits. The local
    // search hides a retired climb from a wall's default list exactly as the
    // server's `retiredByResetCondition` does, and a downloaded wall reads
    // locally even while online, so the two must agree.
    //
    // Nullable, no default, SQLite boolean as INTEGER 0/1. NULL reads as not
    // retired, the server's rule too: every catalogue climb is NULL. No
    // `refreshRevision` bump; see the comment on `board_climbs` in
    // sync/table-config.ts.
    //
    // Expand-only, so the previous bundle can still read the file. It changes
    // `board_climbs`, an artifact table, so it moves ARTIFACT_SCHEMA_VERSION to
    // 12: an artifact built before it is refused until the export rebuilds it.
    version: 12,
    statements: ['ALTER TABLE board_climbs ADD COLUMN retired_by_reset INTEGER;'],
  },
];

const SCHEMA_VERSION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);
`.trim();

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((highest, migration) => Math.max(highest, migration.version), 0);

/** The tables a snapshot artifact carries: the whole-layout file's two, plus the grades file's one. */
export const ARTIFACT_TABLES = ['board_climbs', 'board_climb_stats', 'board_climb_grades'] as const;

/**
 * The highest migration version that changed a table a snapshot artifact
 * carries: a statement naming one of ARTIFACT_TABLES (whole word, the same
 * match the export's `boardSnapshotDdlStatements` uses to pick artifact DDL),
 * leaving out DEVICE_ONLY_STATEMENTS, which never reach an artifact.
 *
 * This, not LATEST_SCHEMA_VERSION, is how old an artifact may be. An artifact
 * built at a schema below it may lack a column this client has, and importing
 * it would NULL-fill that column and stamp the cursor past the rows (the
 * SnapshotSchemaStaleError case). An artifact built below LATEST but at or above
 * this has every artifact column this client has. Only device-side tables
 * changed since then, so rejecting it would send every fresh download to the
 * paged crawl until the export republished, with no data reason.
 *
 * Only DDL counts. A migration whose `run` data step rewrites artifact rows
 * must also name the table in `statements`, or this derivation will not see it.
 */
export function artifactSchemaVersion(migrations: readonly Migration[]): number {
  const deviceOnly = new Set(DEVICE_ONLY_STATEMENTS.map((statement) => statement.trim()));
  const namesArtifactTable = (statement: string): boolean =>
    !deviceOnly.has(statement.trim()) && ARTIFACT_TABLES.some((table) => new RegExp(`\\b${table}\\b`).test(statement));
  return migrations.reduce(
    (highest, migration) =>
      migration.statements.some(namesArtifactTable) ? Math.max(highest, migration.version) : highest,
    0,
  );
}

export const ARTIFACT_SCHEMA_VERSION = artifactSchemaVersion(MIGRATIONS);

async function getCurrentVersion(db: SqlExecutor): Promise<number> {
  const row = await db.getFirstAsync<{ version: number }>('SELECT version FROM schema_version WHERE id = 1');
  return row?.version ?? 0;
}

async function stampVersion(db: SqlExecutor, version: number): Promise<void> {
  await db.runAsync('INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, ?)', [version]);
}

/**
 * Whether this bundle may open a database stamped at `storedVersion`.
 *
 * `newer` is the downgrade case: the file was migrated by a bundle that knows
 * more migrations than this one. It is an OUTCOME, not an error. Nothing is
 * wrong with the file, and reporting it as a failed init would file it next to
 * corruption and lock contention, where the only fixes on offer are the wrong
 * ones.
 */
export type SchemaCompatibility = {
  status: 'compatible' | 'newer';
  storedVersion: number;
  supportedVersion: number;
};

/** The pure half of `readSchemaCompatibility`: compare two version numbers. */
export function classifySchemaVersion(
  storedVersion: number,
  supportedVersion: number = LATEST_SCHEMA_VERSION,
): SchemaCompatibility {
  return {
    status: storedVersion > supportedVersion ? 'newer' : 'compatible',
    storedVersion,
    supportedVersion,
  };
}

/**
 * Reads the stored schema version and says whether this bundle may open the file.
 *
 * READ-ONLY, which is the point: the caller runs it before any setup DDL, so a
 * database from a newer bundle is recognised before this one has written a byte
 * to it. That is why it looks the table up in `sqlite_master` instead of doing
 * what `runMigrations` does (`CREATE TABLE IF NOT EXISTS schema_version`). A
 * database with no `schema_version` table is a fresh one, at version 0.
 */
export async function readSchemaCompatibility(
  db: SqlExecutor,
  supportedVersion: number = LATEST_SCHEMA_VERSION,
): Promise<SchemaCompatibility> {
  const table = await db.getFirstAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'",
  );
  const storedVersion = table ? await getCurrentVersion(db) : 0;
  return classifySchemaVersion(storedVersion, supportedVersion);
}

/**
 * Thrown by anything asked to use a database `readSchemaCompatibility` called
 * `newer`. A class of its own so a caller can tell "this bundle is too old for
 * the file" from a real SQLite failure.
 */
export class SchemaNewerThanAppError extends Error {
  readonly storedVersion: number;
  readonly supportedVersion: number;

  constructor(storedVersion: number, supportedVersion: number) {
    super(
      `Offline database is at schema v${storedVersion}; this app version only knows v${supportedVersion}. ` +
        'Refusing to use it until the app updates.',
    );
    this.name = 'SchemaNewerThanAppError';
    this.storedVersion = storedVersion;
    this.supportedVersion = supportedVersion;
  }
}

/**
 * Brings the database up to LATEST_SCHEMA_VERSION. Applies each pending migration
 * (version > current) in ascending order; every migration's statements, its
 * optional data step, and its version stamp run inside one exclusive transaction,
 * so a crash mid-migration leaves the stored version untouched, rolls back
 * whatever the migration had done, and re-runs cleanly next launch.
 *
 * Returns `newer`, having touched nothing, when the file was migrated by a bundle
 * with more migrations than this one (see the downgrade rule at the top of this
 * file). A caller that gets `newer` back must not use the database.
 */
export async function runMigrations(db: OfflineDatabase): Promise<SchemaCompatibility> {
  const compatibility = await readSchemaCompatibility(db);
  if (compatibility.status === 'newer') return compatibility;

  await db.execAsync(SCHEMA_VERSION_TABLE);

  const currentVersion = await getCurrentVersion(db);
  const pending = MIGRATIONS.filter((migration) => migration.version > currentVersion).sort(
    (left, right) => left.version - right.version,
  );

  for (const migration of pending) {
    await db.withExclusiveTransactionAsync(async (txn) => {
      // Migrations run on their own connection (busy_timeout defaults to 0); wait for
      // any straggling write on the main connection rather than failing the migration.
      await applyBusyTimeout(txn);
      for (const statement of migration.statements) {
        await txn.execAsync(statement);
      }
      await migration.run?.(txn);
      await stampVersion(txn, migration.version);
    });
  }

  return classifySchemaVersion(LATEST_SCHEMA_VERSION);
}
