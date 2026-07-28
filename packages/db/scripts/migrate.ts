import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  DRIZZLE_MIGRATIONS_FOLDER,
  assertMigrationJournalApplied,
  readExpectedMigrations,
  readLedgerHashesWith,
} from './migration-journal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment files (same as drizzle.config.ts)
config({ path: path.resolve(__dirname, '../../../.boardsesh/dev-db.env') });
config({ path: path.resolve(__dirname, '../../../.env.local') });
config({ path: path.resolve(__dirname, '../../web/.env.local') });
config({ path: path.resolve(__dirname, '../../web/.env.development.local') });

async function runMigrations() {
  // Check for DATABASE_URL first, then POSTGRES_URL (Vercel integration)
  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;

  if (!databaseUrl) {
    console.error('❌ DATABASE_URL or POSTGRES_URL is not set');
    console.error(
      '   Available env vars:',
      Object.keys(process.env)
        .filter((k) => k.includes('DATABASE') || k.includes('POSTGRES'))
        .join(', ') || 'none',
    );
    process.exit(1);
  }

  // Safety: Block local dev URLs in production builds
  const isLocalUrl =
    databaseUrl.includes('localhost') || databaseUrl.includes('localtest.me') || databaseUrl.includes('127.0.0.1');

  if (process.env.VERCEL && isLocalUrl) {
    console.error('❌ Refusing to run migrations with local DATABASE_URL in Vercel build');
    console.error('   Set DATABASE_URL in Vercel project environment variables');
    process.exit(1);
  }

  const dbHost = databaseUrl.split('@')[1]?.split('/')[0] || 'unknown';
  console.info(`🔄 Running migrations on: ${dbHost}`);

  const client = postgres(databaseUrl, { max: 1 });
  try {
    const db = drizzle(client, {
      logger: {
        logQuery: (query: string) => {
          const preview = query.slice(0, 200).replace(/\s+/g, ' ').trim();
          const timestamp = new Date().toISOString().split('T')[1].slice(0, 8);
          console.info(`[${timestamp}] ${preview}${query.length > 200 ? '...' : ''}`);
        },
      },
    });

    const migrationsFolder = DRIZZLE_MIGRATIONS_FOLDER;
    const expectedMigrations = readExpectedMigrations(migrationsFolder);
    if (expectedMigrations.length === 0) {
      throw new Error('Migration journal is empty');
    }
    console.info(`📋 Found ${expectedMigrations.length} migrations in journal`);

    await migrate(db, { migrationsFolder });

    // Per-entry, hash-keyed verification (#2933). The old check asserted
    // `max(created_at) >= the newest journal entry's when`, which is exactly the
    // one condition a below-the-high-water-mark gap cannot violate, and the
    // count mismatch that *would* have caught it was a console.warn. See
    // scripts/lib/migration-ledger.ts for the mechanism.
    //
    // Still behind the env gate: the boardsesh-dev-db image is missing
    // 0187_sad_freak's ledger row, so a default-on check would redden every
    // developer's `vp run db:migrate` today. Both places that matter
    // (production-deploy.yml, db-migration-renumber.yml) already set it.
    if (process.env.VERIFY_MIGRATION_JOURNAL === '1') {
      const report = await assertMigrationJournalApplied(readLedgerHashesWith(client), migrationsFolder);
      console.info(
        `✅ Verified all ${report.expectedCount} journal migrations are recorded ` +
          `(${report.ledgerCount} ledger rows)`,
      );
    }

    console.info('✅ Migrations completed successfully');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

void runMigrations();
