// Sequential on-device schema migration runner.
//
// Mirrors offline-sync-plan.md §"Schema migration across embedded + live databases":
// the app stamps an integer schema version into a single-row `schema_version` table
// and, on every launch, applies any migrations whose version is greater than the
// stored one, in order, each inside its own transaction. Running it again is a
// no-op (idempotent), so it is safe to call unconditionally at startup — including
// against a pre-warmed DB built at an older app version.
//
// Pure logic: it only touches the structural subset of SQLiteDatabase below, so a
// node-based fake (or node:sqlite) can exercise the version bookkeeping without
// loading native expo-sqlite.

import { SCHEMA_STATEMENTS } from './schema';

// The minimal slice of expo-sqlite's SQLiteDatabase the runner depends on. The
// variadic param shape mirrors SQLiteDatabase's variadic overloads so a real
// SQLiteDatabase (and a node:sqlite test adapter) is structurally assignable.
type RunnerBindParams = (string | number | null)[];
export type MigrationRunnerDb = {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, ...params: RunnerBindParams): Promise<unknown>;
  getFirstAsync<T>(source: string, ...params: RunnerBindParams): Promise<T | null>;
  withExclusiveTransactionAsync(task: (txn: MigrationRunnerDb) => Promise<void>): Promise<void>;
};

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
];

const SCHEMA_VERSION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);
`.trim();

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((highest, migration) => Math.max(highest, migration.version), 0);

async function getCurrentVersion(db: MigrationRunnerDb): Promise<number> {
  const row = await db.getFirstAsync<{ version: number }>('SELECT version FROM schema_version WHERE id = 1');
  return row?.version ?? 0;
}

async function stampVersion(db: MigrationRunnerDb, version: number): Promise<void> {
  await db.runAsync('INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, ?)', version);
}

/**
 * Brings the database up to LATEST_SCHEMA_VERSION. Applies each pending migration
 * (version > current) in ascending order; every migration's statements plus its
 * version stamp run inside one exclusive transaction, so a crash mid-migration
 * leaves the stored version untouched and the migration re-runs cleanly next launch.
 */
export async function runMigrations(db: MigrationRunnerDb): Promise<void> {
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
