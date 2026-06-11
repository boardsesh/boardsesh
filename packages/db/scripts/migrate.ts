import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { config } from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type AppliedMigrationCountRow = {
  appliedMigrationCount: number | string | bigint | null;
};

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

    const migrationsFolder = path.resolve(__dirname, '../drizzle');
    const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
    console.info(`📋 Found ${journal.entries.length} migrations in journal`);

    await migrate(db, { migrationsFolder });

    const appliedMigrationRows = await client<AppliedMigrationCountRow[]>`
      SELECT COUNT(*)::int AS "appliedMigrationCount"
      FROM drizzle."__drizzle_migrations"
    `;
    const appliedMigrationCount = Number(appliedMigrationRows[0]?.appliedMigrationCount ?? 0);
    if (appliedMigrationCount !== journal.entries.length) {
      throw new Error(
        `Migration count verification failed: database has ${appliedMigrationCount} applied migrations, ` +
          `but the bundled journal has ${journal.entries.length}.`,
      );
    }

    console.info(`✅ Verified ${appliedMigrationCount} applied migrations`);
    console.info('✅ Migrations completed successfully');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

void runMigrations();
