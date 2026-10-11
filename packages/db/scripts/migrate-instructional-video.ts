/** Apply the repository's real migration journal only to the dedicated local tutorial database. */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { DRIZZLE_MIGRATIONS_FOLDER, readLedgerHashesWith, runMigrationJournalGate } from './migration-journal.js';
import { initializeJobQueueSchema } from '../src/job-queue-schema.js';

async function main(): Promise<void> {
  const target = new URL(process.env.DATABASE_URL ?? '');
  if (
    process.env.BOARDSESH_TUTORIAL_DEMO !== '1' ||
    !['localhost', '127.0.0.1'].includes(target.hostname) ||
    target.pathname !== '/boardsesh_tutorial'
  )
    throw new Error('Tutorial migrations require their isolated loopback database');
  const connection = postgres(target.href, { max: 1, prepare: false });
  try {
    const db = drizzle(connection);
    await migrate(db, { migrationsFolder: DRIZZLE_MIGRATIONS_FOLDER });
    await initializeJobQueueSchema(db);
    // Same journal check as dev migration, retaining the dev image's documented historic-gap default.
    await runMigrationJournalGate(process.env, readLedgerHashesWith(connection), DRIZZLE_MIGRATIONS_FOLDER);
    console.info('[tutorial-demo] Repository migrations applied');
  } finally {
    await connection.end();
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
