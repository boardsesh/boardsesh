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
      for (const statement of migration.statements) {
        await txn.execAsync(statement);
      }
      await stampVersion(txn, migration.version);
    });
  }
}
