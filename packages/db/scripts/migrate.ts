import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  DRIZZLE_MIGRATIONS_FOLDER,
  describeBaselinedGap,
  readExpectedMigrations,
  readLedgerHashesWith,
  runMigrationJournalGate,
} from './migration-journal.js';
import { migrationExecutionContractFromEnvironment, reserveMigrationOwnerSession } from './migration-owner-role.js';
import { runMigrationWithRuntimeAclContract } from './migration-runtime-acl.js';
import { scriptDatabaseConnectionOptions } from './db-connection.js';

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

  // TODO(#4656): host-agnostic form — see db-connection.ts for why a CI term
  // here would break the workflows that migrate a localhost service container.
  if (process.env.VERCEL && isLocalUrl) {
    console.error('❌ Refusing to run migrations with local DATABASE_URL in Vercel build');
    console.error('   Set DATABASE_URL in Vercel project environment variables');
    process.exit(1);
  }

  let dbHost = 'unknown';
  try {
    const parsedDatabaseUrl = new URL(databaseUrl);
    if (parsedDatabaseUrl.protocol === 'postgres:' || parsedDatabaseUrl.protocol === 'postgresql:') {
      dbHost = parsedDatabaseUrl.hostname || 'unknown';
    }
  } catch {
    // postgres-js will provide the actionable parse error without us logging
    // any substring which might contain URL userinfo.
  }
  console.info(`🔄 Running migrations on: ${dbHost}`);

  const connectionPool = postgres(databaseUrl, scriptDatabaseConnectionOptions(databaseUrl));
  let closeMigrationSession: (() => Promise<void>) | undefined;
  try {
    // SET ROLE is session state. Reserve one physical connection so no pool
    // reconnect or checkout can silently put later DDL back under the LOGIN
    // credential while a migration is in progress.
    const migrationContract = migrationExecutionContractFromEnvironment(process.env);

    let client: postgres.Sql;
    if (migrationContract) {
      const migrationSession = await reserveMigrationOwnerSession(connectionPool, migrationContract.owner);
      client = migrationSession.client;
      closeMigrationSession = migrationSession.close;
      console.info(`🔐 Running DDL as NOLOGIN owner: ${migrationContract.owner.ownerRole}`);
    } else {
      // No session state is needed in local/dev mode. Keep the normal pool:
      // postgres-js ReservedSql omits runtime fields Drizzle requires.
      client = connectionPool;
    }

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

    if (migrationContract) {
      await runMigrationWithRuntimeAclContract(
        client as postgres.ReservedSql,
        {
          ownerRole: migrationContract.owner.ownerRole,
          runtimeRole: migrationContract.runtimeRole,
          schemas: migrationContract.runtimeSchemas,
        },
        () => migrate(db, { migrationsFolder }),
      );
      console.info(`🔒 Reconciled runtime ACLs for ${migrationContract.runtimeRole}`);
    } else {
      await migrate(db, { migrationsFolder });
    }

    // Per-entry, hash-keyed verification (#2933). The old check asserted
    // `max(created_at) >= the newest journal entry's when`, which is exactly the
    // one condition a below-the-high-water-mark gap cannot violate, and the
    // count mismatch that *would* have caught it was a console.warn. See
    // scripts/lib/migration-ledger.ts for the mechanism.
    //
    // Still behind the env gate: the boardsesh-dev-db image is missing
    // 0187_sad_freak's ledger row, so a default-on check would redden every
    // developer's `vp run db:migrate` today. Both places that matter
    // (production-deploy.yml, db-migration-renumber.yml) already set it. The
    // gate itself is `runMigrationJournalGate` so it has test coverage; this
    // file connects on import and offers no seam of its own.
    const report = await runMigrationJournalGate(process.env, readLedgerHashesWith(client), migrationsFolder);
    if (report) {
      // Named on every armed run, not only on failure: production's pre-gate
      // backlog is tolerated, not resolved (scripts/lib/migration-ledger-baseline.ts).
      const baselinedGap = describeBaselinedGap(report);
      if (baselinedGap) {
        console.warn(`⚠️  ${baselinedGap}`);
      }
      console.info(
        `✅ Verified all ${report.expectedCount - report.baselinedMissing.length} unbaselined journal ` +
          `migrations are recorded (${report.ledgerCount} ledger rows)`,
      );
    }

    console.info('✅ Migrations completed successfully');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exitCode = 1;
  } finally {
    await closeMigrationSession?.().catch(() => {});
    await connectionPool.end().catch(() => {});
  }
}

void runMigrations();
