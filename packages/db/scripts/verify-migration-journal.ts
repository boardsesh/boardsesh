/**
 * Read-only pre-flight for the migration journal check that `migrate.ts` runs
 * under `VERIFY_MIGRATION_JOURNAL=1`.
 *
 * Why it exists separately: `migrate` is the gate job for both `deploy-web` and
 * `deploy-backend` in `production-deploy.yml`, so a gap in the target database's
 * ledger blocks the whole production deploy. This script answers "would that
 * gate fire?" without applying anything — one
 * `SELECT hash FROM drizzle."__drizzle_migrations"` plus local file reads. No
 * writes, no `migrate()` call, no DDL.
 *
 * Usage: `DB_URL=postgres://... vp run db:verify-journal`
 * Exit 0 = every journal migration is recorded. Exit 1 = missing tags listed.
 */
import postgres from 'postgres';
import { describeDatabaseHost, getScriptDatabaseUrl } from './db-connection.js';
import { inspectMigrationJournal, readLedgerHashesWith } from './migration-journal.js';
import { MIGRATION_GAP_REMEDIATION } from '../../../scripts/lib/migration-ledger.js';

async function verifyMigrationJournal(): Promise<void> {
  const databaseUrl = getScriptDatabaseUrl();
  console.info(`🔎 Verifying migration journal against: ${describeDatabaseHost(databaseUrl)} (read-only)`);

  const client = postgres(databaseUrl, { max: 1 });
  try {
    const report = await inspectMigrationJournal(readLedgerHashesWith(client));
    if (report.missingTags.length > 0) {
      console.error(
        `❌ ${report.missingTags.length} of ${report.expectedCount} journal migrations have no row in ` +
          `drizzle.__drizzle_migrations (${report.ledgerCount} rows present).`,
      );
      for (const tag of report.missingTags) {
        console.error(`   • ${tag}`);
      }
      console.error(`   ${MIGRATION_GAP_REMEDIATION}`);
      process.exitCode = 1;
      return;
    }
    console.info(`✅ All ${report.expectedCount} journal migrations are recorded (${report.ledgerCount} ledger rows).`);
  } catch (error) {
    console.error('❌ Migration journal verification failed:', error);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

void verifyMigrationJournal();
