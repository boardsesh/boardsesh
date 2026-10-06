/**
 * Installs the pg-boss schema and the pre-created queues on the LOCAL dev
 * database, so the backend can start against it.
 *
 * The backend never runs pg-boss DDL itself outside tests (`migrate` is off in
 * `createJobQueueClient`); in a deployment the migrator (`scripts/migrate.ts`)
 * owns it. `scripts/dev-db-up.sh` applies pending SQL migrations through psql
 * and never calls the migrator, so on a fresh dev-db volume the backend used to
 * exit with `pg-boss is not installed`. `dev-db-up.sh` runs this after its
 * migrations instead. Idempotent: pg-boss skips an installed schema and an
 * existing queue.
 *
 * Refuses any database that is not a local dev host: this is owner DDL, and
 * the deployment path grants roles this script does not know about.
 */
import { initializeJobQueueSchema } from '../src/job-queue-schema.js';
import { createScriptDb, getScriptDatabaseUrl, isLocalDatabaseUrl } from './db-connection.js';

const databaseUrl = getScriptDatabaseUrl();
if (!isLocalDatabaseUrl(databaseUrl)) {
  console.error('Refusing to install the job queue schema: DATABASE_URL is not a local dev database.');
  process.exit(1);
}

const { db, close } = createScriptDb(databaseUrl);
try {
  await initializeJobQueueSchema(db);
  console.info('  Job queue schema is installed.');
} finally {
  await close();
}
