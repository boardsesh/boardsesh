/**
 * Repairs `created_at` in drizzle's applied-migration ledger so every row
 * carries its journal entry's `when` — the value drizzle itself writes.
 *
 * Why this exists (#4211): the `boardsesh-dev-db` image applies the journal in a
 * psql loop and stamps both ledger tables with the image's *build* wall clock
 * (`$(date +%s)000`). Drizzle's applier is a single high-water mark — it reads
 * `max(created_at)` once and applies only entries whose `when` is strictly
 * greater — so a build timestamp sitting ~13 orders of magnitude of wall clock
 * above every journal `when` means the next migration anyone adds is skipped on
 * that database forever. `vp run db:migrate` reports success, the table never
 * appears, and `VERIFY_MIGRATION_JOURNAL=1` (correctly) calls it a gap.
 *
 * `Dockerfile.dev-db` now stamps `when`, but that only helps images built after
 * this lands: CI pins a digest and developers keep a persistent `db_data`
 * volume. This script fixes what is already on disk, in place.
 *
 * It is a *dev/CI* tool. Production's ledger is written by drizzle and is
 * already `when`-valued, so there is nothing to repair there — the URL guard
 * below refuses a non-local target unless `--force`, so this can never be
 * mistaken for a production ledger-mutation tool.
 *
 * Usage:
 *   DATABASE_URL=postgres://… vp run db:normalize-ledger
 *   DATABASE_URL=postgres://… vp run db:normalize-ledger -- --dry-run
 */
import postgres from 'postgres';
import path from 'path';
import { fileURLToPath } from 'url';
import { describeDatabaseHost, getScriptDatabaseUrl, isLocalDatabaseUrl } from './db-connection.js';
import { readExpectedMigrations } from './migration-journal.js';
import {
  planLedgerTimestampRepairs,
  type ExpectedMigrationWithWhen,
  type LedgerTimestampRepair,
  type LedgerTimestampRow,
} from '../../../scripts/lib/migration-ledger.js';

/** A ledger table, qualified. Both are literals in this module — never user input. */
export interface LedgerTable {
  schema: string;
  table: string;
}

/** Where drizzle 0.45 keeps the ledger. */
export const DRIZZLE_LEDGER_TABLE: LedgerTable = { schema: 'drizzle', table: '__drizzle_migrations' };

/**
 * Where older drizzle kept it, and where the dev-db image still writes a copy.
 * `scripts/dev-db-up.sh`'s `sync_drizzle_migration_tracker` seeds the drizzle
 * table from this one when the drizzle table is empty, so leaving this one
 * build-stamped would re-introduce the bad high-water mark on the next fresh
 * volume.
 */
export const LEGACY_LEDGER_TABLE: LedgerTable = { schema: 'public', table: '__drizzle_migrations' };

function qualify(table: LedgerTable): string {
  return `"${table.schema}"."${table.table}"`;
}

/** Postgres client surface this module needs. Narrow on purpose so tests can pass a scratch client. */
export type LedgerClient = Pick<postgres.Sql, 'unsafe' | 'begin'>;

/** False when the table does not exist — an older image has no `drizzle` schema at all. */
export async function ledgerTableExists(client: LedgerClient, table: LedgerTable): Promise<boolean> {
  const rows = await client.unsafe<{ present: string | null }[]>('SELECT to_regclass($1)::text AS present', [
    `${table.schema}.${table.table}`,
  ]);
  return rows[0]?.present != null;
}

/**
 * `id`-ordered ledger rows. `created_at` is a bigint, which postgres.js hands
 * back as a string, so it is converted here rather than in the pure planner.
 */
export async function readLedgerTimestampRows(client: LedgerClient, table: LedgerTable): Promise<LedgerTimestampRow[]> {
  const rows = await client.unsafe<{ id: number; hash: string; created_at: string | number | null }[]>(
    `SELECT id, hash, created_at FROM ${qualify(table)} ORDER BY id`,
  );
  return rows.map((row) => ({ id: Number(row.id), hash: row.hash, createdAt: Number(row.created_at ?? 0) }));
}

/**
 * Applies the whole plan in one transaction: a half-repaired ledger has a
 * high-water mark nobody predicted, which is the failure mode this fixes.
 */
export async function applyLedgerTimestampRepairs(
  client: LedgerClient,
  table: LedgerTable,
  repairs: readonly LedgerTimestampRepair[],
): Promise<void> {
  if (repairs.length === 0) return;
  await client.begin(async (tx) => {
    for (const repair of repairs) {
      await tx.unsafe(`UPDATE ${qualify(table)} SET created_at = $1 WHERE id = $2`, [repair.to, repair.id]);
    }
  });
}

/**
 * Plan-and-apply for one table. Returns the plan (empty when the table is
 * absent or already correct) so callers can report it.
 */
export async function normalizeLedgerTable(
  client: LedgerClient,
  table: LedgerTable,
  expected: readonly ExpectedMigrationWithWhen[],
  options: { dryRun?: boolean } = {},
): Promise<LedgerTimestampRepair[]> {
  if (!(await ledgerTableExists(client, table))) return [];
  const repairs = planLedgerTimestampRepairs(expected, await readLedgerTimestampRows(client, table));
  if (!options.dryRun) {
    await applyLedgerTimestampRepairs(client, table, repairs);
  }
  return repairs;
}

function reportTable(table: LedgerTable, repairs: readonly LedgerTimestampRepair[], dryRun: boolean): void {
  const qualified = `${table.schema}.${table.table}`;
  if (repairs.length === 0) {
    console.info(`   ${qualified}: already carries the journal's timestamps.`);
    return;
  }
  console.info(`   ${qualified}: ${dryRun ? 'would repair' : 'repaired'} ${repairs.length} row(s).`);
  for (const repair of repairs) {
    console.info(`     • ${repair.tag}: ${repair.from} → ${repair.to}`);
  }
}

async function normalizeLedgerTimestamps(argv: readonly string[]): Promise<void> {
  const dryRun = argv.includes('--dry-run');
  const force = argv.includes('--force');
  const databaseUrl = getScriptDatabaseUrl();

  if (!isLocalDatabaseUrl(databaseUrl) && !force) {
    console.error(
      `❌ Refusing to normalise the migration ledger on ${describeDatabaseHost(databaseUrl)}: this is a dev/CI ` +
        'repair for databases whose ledger was stamped by something other than drizzle. Production ledgers are ' +
        'already written by drizzle. Pass --force if you are certain.',
    );
    process.exitCode = 1;
    return;
  }

  console.info(
    `🕒 Normalising migration ledger timestamps on: ${describeDatabaseHost(databaseUrl)}${dryRun ? ' (dry run)' : ''}`,
  );

  const client = postgres(databaseUrl, { max: 1 });
  try {
    const expected = readExpectedMigrations();
    let repairedRows = 0;
    for (const table of [DRIZZLE_LEDGER_TABLE, LEGACY_LEDGER_TABLE]) {
      const repairs = await normalizeLedgerTable(client, table, expected, { dryRun });
      repairedRows += repairs.length;
      reportTable(table, repairs, dryRun);
    }
    console.info(
      repairedRows === 0
        ? '✅ Nothing to repair — every ledger row already carries its journal `when`.'
        : `✅ ${dryRun ? 'Planned' : 'Wrote'} ${repairedRows} ledger timestamp repair(s).`,
    );
  } catch (error) {
    console.error('❌ Migration ledger timestamp normalisation failed:', error);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

// Only when run as a script. The exported helpers above are imported by
// packages/db/scripts/migration-journal-verification.integration.test.ts, which
// must not connect to the developer's dev database on import.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  void normalizeLedgerTimestamps(process.argv.slice(2));
}
