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

import { SCHEMA_STATEMENTS } from './schema';
import { applyBusyTimeout } from './pragmas';
import type { OfflineDatabase, SqlExecutor } from '../database';

export type Migration = {
  version: number;
  statements: string[];
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
    // Favorites re-keyed to (climb_uuid): a climb is the same climb whichever
    // board config or angle you hearted it on. SQLite can't change a primary key
    // in place, so the table is rebuilt.
    //
    // board_name/angle survive as NULLABLE columns: syncFavorites still emits
    // them for one release (a device on older JS declares them NOT NULL), and
    // keeping them here means those values land quietly instead of firing an
    // onSchemaDrift report on every launch. Local writes leave them NULL.
    //
    // The copy is ordered oldest-first so INSERT OR REPLACE collapses a climb
    // favorited at two angles onto the NEWEST row. Clearing the checkpoint makes
    // the device re-pull the whole (small) favorites set under the new shape.
    version: 5,
    statements: [
      `CREATE TABLE IF NOT EXISTS user_favorites_new (
  climb_uuid TEXT NOT NULL PRIMARY KEY,
  board_name TEXT,
  angle INTEGER,
  user_id TEXT,
  created_at TEXT,
  updated_at TEXT
);`,
      `INSERT OR REPLACE INTO user_favorites_new (climb_uuid, board_name, angle, user_id, created_at, updated_at)
  SELECT climb_uuid, board_name, angle, user_id, created_at, updated_at
  FROM user_favorites
  ORDER BY created_at;`,
      'DROP TABLE user_favorites;',
      'ALTER TABLE user_favorites_new RENAME TO user_favorites;',
      `DELETE FROM sync_meta WHERE key = 'checkpoint:user_favorites';`,
    ],
  },
];

const SCHEMA_VERSION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);
`.trim();

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((highest, migration) => Math.max(highest, migration.version), 0);

async function getCurrentVersion(db: SqlExecutor): Promise<number> {
  const row = await db.getFirstAsync<{ version: number }>('SELECT version FROM schema_version WHERE id = 1');
  return row?.version ?? 0;
}

async function stampVersion(db: SqlExecutor, version: number): Promise<void> {
  await db.runAsync('INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, ?)', [version]);
}

/**
 * Brings the database up to LATEST_SCHEMA_VERSION. Applies each pending migration
 * (version > current) in ascending order; every migration's statements plus its
 * version stamp run inside one exclusive transaction, so a crash mid-migration
 * leaves the stored version untouched and the migration re-runs cleanly next launch.
 */
export async function runMigrations(db: OfflineDatabase): Promise<void> {
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
      await stampVersion(txn, migration.version);
    });
  }
}
