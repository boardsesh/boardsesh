/**
 * Repairs `created_at` in drizzle's applied-migration ledger so every row
 * carries its journal entry's `when` — the value drizzle itself writes.
 *
 * Why this exists (#4211): older `boardsesh-dev-db` images stamped both ledger
 * tables with the image's *build* wall clock instead of each journal entry's
 * `when`. Drizzle's applier is a single high-water mark — it reads
 * `max(created_at)` once and applies only entries whose `when` is strictly
 * greater — so an old volume can permanently skip a branch migration generated
 * before that image was built. The current image helper writes each exact
 * journal `when`; this repairs persistent volumes created by older images.
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

/** Read surface shared by the database client and its transaction callback. */
type LedgerQueryClient = Pick<postgres.Sql, 'unsafe'>;

/** Top-level client adds `begin` so the two-table repair stays atomic. */
export type LedgerClient = LedgerQueryClient & Pick<postgres.Sql, 'begin'>;

export interface LedgerTableRepairPlan {
  table: LedgerTable;
  present: boolean;
  repairs: LedgerTimestampRepair[];
}

/** False when the table does not exist — an older image has no `drizzle` schema at all. */
export async function ledgerTableExists(client: LedgerQueryClient, table: LedgerTable): Promise<boolean> {
  const rows = await client.unsafe<{ present: string | null }[]>('SELECT to_regclass($1)::text AS present', [
    `${table.schema}.${table.table}`,
  ]);
  return rows[0]?.present != null;
}

/**
 * `id`-ordered ledger rows. `created_at` is a bigint, which postgres.js hands
 * back as a string, so it is converted here rather than in the pure planner.
 */
export async function readLedgerTimestampRows(
  client: LedgerQueryClient,
  table: LedgerTable,
): Promise<LedgerTimestampRow[]> {
  const rows = await client.unsafe<{ id: number; hash: string; created_at: string | number | null }[]>(
    `SELECT id, hash, created_at FROM ${qualify(table)} ORDER BY id`,
  );
  return rows.map((row) => ({ id: Number(row.id), hash: row.hash, createdAt: Number(row.created_at ?? 0) }));
}

/**
 * Plans both ledger copies before any write, then applies and verifies the full
 * result in one transaction. A blocker in either copy therefore leaves both
 * copies untouched and stops the caller before it can invoke the migrator.
 */
export async function normalizeLedgerTables(
  client: LedgerClient,
  tables: readonly LedgerTable[],
  expected: readonly ExpectedMigrationWithWhen[],
  options: { dryRun?: boolean } = {},
): Promise<LedgerTableRepairPlan[]> {
  const dryRun = options.dryRun ?? false;
  const orderedTables = [...tables].sort((left, right) => qualify(left).localeCompare(qualify(right)));

  return client.begin(async (tx) => {
    await tx.unsafe(
      dryRun
        ? 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'
        : 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
    );

    const plans: LedgerTableRepairPlan[] = [];
    for (const table of orderedTables) {
      const present = await ledgerTableExists(tx, table);
      if (!present) {
        plans.push({ table, present, repairs: [] });
        continue;
      }

      // Prevent rows from changing between preflight, repair, and verification.
      // The fixed-order lock also makes the two ledger copies one atomic repair.
      if (!dryRun) await tx.unsafe(`LOCK TABLE ${qualify(table)} IN SHARE ROW EXCLUSIVE MODE`);
      const rows = await readLedgerTimestampRows(tx, table);
      try {
        plans.push({ table, present, repairs: planLedgerTimestampRepairs(expected, rows) });
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        throw new Error(`Refusing to normalize ${qualify(table)}: ${details}`);
      }
    }

    if (dryRun) return plans;

    for (const plan of plans) {
      if (!plan.present) continue;
      for (const repair of plan.repairs) {
        await tx.unsafe(`UPDATE ${qualify(plan.table)} SET created_at = $1 WHERE id = $2`, [repair.to, repair.id]);
      }
    }

    // Validate every resulting row while the locks are held. If an update was
    // incomplete or the remaining high-water mark could still skip a migration,
    // throwing here rolls both table copies back together.
    for (const plan of plans) {
      if (!plan.present) continue;
      let remainingRepairs: LedgerTimestampRepair[];
      try {
        remainingRepairs = planLedgerTimestampRepairs(expected, await readLedgerTimestampRows(tx, plan.table));
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        throw new Error(`Post-repair validation failed for ${qualify(plan.table)}: ${details}`);
      }
      if (remainingRepairs.length > 0) {
        throw new Error(
          `Post-repair validation failed for ${qualify(plan.table)}: ${remainingRepairs.length} timestamp ` +
            'repair(s) remain inside the transaction.',
        );
      }
    }

    return plans;
  });
}

/** Plan-and-apply for one table; absent tables remain a quiet no-op. */
export async function normalizeLedgerTable(
  client: LedgerClient,
  table: LedgerTable,
  expected: readonly ExpectedMigrationWithWhen[],
  options: { dryRun?: boolean } = {},
): Promise<LedgerTimestampRepair[]> {
  const [plan] = await normalizeLedgerTables(client, [table], expected, options);
  return plan?.repairs ?? [];
}

function reportTable(plan: LedgerTableRepairPlan, dryRun: boolean): void {
  const { table, repairs } = plan;
  const qualified = `${table.schema}.${table.table}`;
  if (!plan.present) {
    console.info(`   ${qualified}: absent; no rows to repair.`);
    return;
  }
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
    const plans = await normalizeLedgerTables(client, [DRIZZLE_LEDGER_TABLE, LEGACY_LEDGER_TABLE], expected, {
      dryRun,
    });
    const repairedRows = plans.reduce((count, plan) => count + plan.repairs.length, 0);
    for (const plan of plans) reportTable(plan, dryRun);
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
