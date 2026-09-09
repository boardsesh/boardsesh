/**
 * The deploy step that owns `max_parallel_workers_per_gather` (#5352).
 *
 * Why a step and not a migration: `ALTER DATABASE ... SET` needs database
 * ownership, and the production migration role is deliberately NOT the database
 * owner — `reserveMigrationOwnerSession` asserts `ownerDoesNotOwnDatabase`
 * before it runs a single statement. Migration 0225 therefore raised
 * `insufficient_privilege` on every production deploy, swallowed it into a
 * `RAISE WARNING`, and was recorded as applied: a no-op that reports success.
 * The reproduction and the whole decision tree live in serial-plan-default.ts.
 *
 * Exit code 1 when application sessions can still plan a Gather. That is the
 * point — a warning in a migration log is what let five rounds of this bug ship.
 *
 * Usage:
 *   DATABASE_URL=... [ADMIN_DATABASE_URL=...] vp run db:verify-serial-plan
 *   vp run db:verify-serial-plan -- --check-only   # never write, even with ADMIN_DATABASE_URL
 */
import postgres from 'postgres';
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { runSerialPlanVerification, type SerialPlanClient, type SerialPlanConnection } from './serial-plan-default.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same env files, in the same order, as migrate.ts.
config({ path: path.resolve(__dirname, '../../../.boardsesh/dev-db.env') });
config({ path: path.resolve(__dirname, '../../../.env.local') });
config({ path: path.resolve(__dirname, '../../web/.env.local') });
config({ path: path.resolve(__dirname, '../../web/.env.development.local') });

function connectionOpener(connectionString: string): () => Promise<SerialPlanConnection> {
  return async () => {
    const pool = postgres(connectionString, { max: 1 });
    return { client: pool as unknown as SerialPlanClient, close: () => pool.end() };
  };
}

async function main(): Promise<void> {
  const applicationUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!applicationUrl) {
    console.error('❌ DATABASE_URL or POSTGRES_URL is not set');
    process.exitCode = 1;
    return;
  }

  // `--check-only` exists for a dry run against production from a laptop: it
  // reports without ever issuing DDL, even when an admin credential is present.
  const checkOnly = process.argv.includes('--check-only');
  const adminUrl = checkOnly ? undefined : process.env.ADMIN_DATABASE_URL;

  process.exitCode = await runSerialPlanVerification({
    openApplicationClient: connectionOpener(applicationUrl),
    openAdminClient: adminUrl ? connectionOpener(adminUrl) : null,
    log: (message) => console.info(message),
    warn: (message) => console.warn(message),
  });
}

void main();
