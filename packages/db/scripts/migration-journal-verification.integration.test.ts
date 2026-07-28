/**
 * Real-database regression coverage for #2933.
 *
 * Drizzle's applier is a single high-water mark: `PgDialect.migrate()` snapshots
 * `max(created_at)` from `drizzle.__drizzle_migrations` once, before the loop,
 * and applies only journal entries whose `when` is strictly greater. A migration
 * appended with a `when` at or below that mark is skipped on that deploy and on
 * every deploy after it. Production hit exactly this with
 * `0129_numerous_star_brand`, and `migrate.ts`'s old latest-only assertion stayed
 * green through it.
 *
 * These tests drive drizzle's real `migrate()` against a throwaway database, so
 * the skip behaviour is observed rather than assumed, and the hash parity is
 * asserted against the rows drizzle itself INSERTed (not against a re-derived
 * sha256, which would be a tautology).
 *
 * Skips unless DATABASE_URL points at a local Postgres. It never touches the
 * shared dev database: every scenario creates and drops its own database.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { findUnappliedMigrations } from '../../../scripts/lib/migration-ledger.js';
import { inspectMigrationJournal, readExpectedMigrations, readLedgerHashesWith } from './migration-journal.js';

type ScratchJournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };

const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', 'postgres'];

function localDatabaseUrl(): string | null {
  const databaseUrl = process.env.MIGRATION_JOURNAL_DB_URL ?? process.env.DATABASE_URL;
  let resolved: string | null = null;
  if (databaseUrl) {
    try {
      const hostname = new URL(databaseUrl).hostname.toLowerCase();
      resolved = LOCAL_HOSTNAMES.includes(hostname) ? databaseUrl : null;
    } catch {
      resolved = null;
    }
  }
  // Skipping is the right local default, but a silent skip in CI is a false
  // green — the job exists precisely to run these against a real database.
  if (!resolved && process.env.CI) {
    throw new Error(
      'CI is set but no local Postgres URL is available: set MIGRATION_JOURNAL_DB_URL (or DATABASE_URL) ' +
        `to a host in ${LOCAL_HOSTNAMES.join(', ')}.`,
    );
  }
  return resolved;
}

/** Writes a v7 drizzle migrations folder with exactly `entries` in it. */
function writeMigrationsFolder(folder: string, entries: readonly { tag: string; when: number; sql: string }[]): void {
  fs.mkdirSync(path.join(folder, 'meta'), { recursive: true });
  const journalEntries: ScratchJournalEntry[] = entries.map((entry, idx) => ({
    idx,
    version: '7',
    when: entry.when,
    tag: entry.tag,
    breakpoints: true,
  }));
  fs.writeFileSync(
    path.join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'postgresql', entries: journalEntries }, null, 2),
  );
  for (const entry of entries) {
    fs.writeFileSync(path.join(folder, `${entry.tag}.sql`), entry.sql);
  }
}

const createdDatabases: { adminUrl: string; databaseName: string }[] = [];

/** Creates a throwaway database next to `adminUrl` and returns a URL for it. */
async function createScratchDatabase(adminUrl: string, label: string): Promise<string> {
  const databaseName = `bs_mjv_${label}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  const admin = postgres(adminUrl, { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end().catch(() => {});
  }
  createdDatabases.push({ adminUrl, databaseName });
  const scratchUrl = new URL(adminUrl);
  scratchUrl.pathname = `/${databaseName}`;
  return scratchUrl.toString();
}

after(async () => {
  for (const { adminUrl, databaseName } of createdDatabases) {
    const admin = postgres(adminUrl, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    } catch {
      // Best effort: a leaked scratch database is noise, not a test failure.
    } finally {
      await admin.end().catch(() => {});
    }
  }
});

async function applyMigrations(scratchUrl: string, migrationsFolder: string): Promise<void> {
  const client = postgres(scratchUrl, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end().catch(() => {});
  }
}

async function withScratchClient<T>(scratchUrl: string, run: (client: postgres.Sql) => Promise<T>): Promise<T> {
  const client = postgres(scratchUrl, { max: 1 });
  try {
    return await run(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function tableExists(scratchUrl: string, tableName: string): Promise<boolean> {
  return withScratchClient(scratchUrl, async (client) => {
    const rows = await client<
      { present: string | null }[]
    >`SELECT to_regclass(${`public.${tableName}`})::text AS present`;
    return rows[0]?.present != null;
  });
}

function makeTempFolder(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bs-mjv-${label}-`));
}

const PHASE_ONE = [
  { tag: '0000_a', when: 1000, sql: 'CREATE TABLE mjv_t_a (id int);' },
  { tag: '0001_b', when: 3000, sql: 'CREATE TABLE mjv_t_b (id int);' },
];
// The bug in one line: appended later, but `when` sits below 0001_b's 3000.
const STALE_WHEN_ENTRY = { tag: '0002_stale_when', when: 2000, sql: 'CREATE TABLE mjv_t_stale (id int);' };

describe('migration journal verification (#2933)', () => {
  it('matches the hashes drizzle itself writes to the ledger', async (context) => {
    const adminUrl = localDatabaseUrl();
    if (!adminUrl) {
      context.skip('set DATABASE_URL to a local Postgres to run');
      return;
    }
    // Non-tautological on purpose: this compares readExpectedMigrations' hashes
    // against the rows drizzle's own migrate() INSERTed, so a future drizzle
    // version changing how the ledger hash is computed turns this red instead of
    // turning the production deploy gate into a false positive.
    const migrationsFolder = makeTempFolder('parity');
    writeMigrationsFolder(migrationsFolder, [...PHASE_ONE, STALE_WHEN_ENTRY]);
    const scratchUrl = await createScratchDatabase(adminUrl, 'parity');

    await applyMigrations(scratchUrl, migrationsFolder);

    const expected = readExpectedMigrations(migrationsFolder);
    const ledgerHashes = await withScratchClient(scratchUrl, (client) => readLedgerHashesWith(client)());
    assert.equal(expected.length, 3);
    for (const migration of expected) {
      assert.ok(
        ledgerHashes.includes(migration.hash),
        `drizzle recorded no ledger row matching ${migration.tag}'s hash`,
      );
    }
  });

  it('reports a healthy database as complete', async (context) => {
    const adminUrl = localDatabaseUrl();
    if (!adminUrl) {
      context.skip('set DATABASE_URL to a local Postgres to run');
      return;
    }
    const migrationsFolder = makeTempFolder('healthy');
    writeMigrationsFolder(migrationsFolder, PHASE_ONE);
    const scratchUrl = await createScratchDatabase(adminUrl, 'healthy');

    await applyMigrations(scratchUrl, migrationsFolder);

    const report = await withScratchClient(scratchUrl, (client) =>
      inspectMigrationJournal(readLedgerHashesWith(client), migrationsFolder),
    );
    assert.deepEqual(report.missingTags, [], 'a fully applied database must not trip the deploy gate');
    assert.equal(report.expectedCount, 2);
    assert.equal(report.ledgerCount, 2);
  });

  it('catches the migration drizzle skips below its created_at high-water mark', async (context) => {
    const adminUrl = localDatabaseUrl();
    if (!adminUrl) {
      context.skip('set DATABASE_URL to a local Postgres to run');
      return;
    }
    const migrationsFolder = makeTempFolder('gap');
    const scratchUrl = await createScratchDatabase(adminUrl, 'gap');

    // Deploy 1: journal ends at when=3000.
    writeMigrationsFolder(migrationsFolder, PHASE_ONE);
    await applyMigrations(scratchUrl, migrationsFolder);

    // Deploy 2: a third migration lands with when=2000, below the mark.
    writeMigrationsFolder(migrationsFolder, [...PHASE_ONE, STALE_WHEN_ENTRY]);
    await applyMigrations(scratchUrl, migrationsFolder);

    assert.equal(await tableExists(scratchUrl, 'mjv_t_a'), true);
    assert.equal(await tableExists(scratchUrl, 'mjv_t_b'), true);
    assert.equal(
      await tableExists(scratchUrl, 'mjv_t_stale'),
      false,
      'drizzle is expected to skip the below-high-water-mark migration',
    );

    const { latestCreatedAt, ledgerCount, missingTags } = await withScratchClient(scratchUrl, async (client) => {
      const rows = await client<{ latestCreatedAt: string | null; ledgerCount: number }[]>`
        SELECT MAX(created_at)::bigint AS "latestCreatedAt", COUNT(*)::int AS "ledgerCount"
        FROM drizzle."__drizzle_migrations"
      `;
      const report = await inspectMigrationJournal(readLedgerHashesWith(client), migrationsFolder);
      return {
        latestCreatedAt: Number(rows[0]?.latestCreatedAt ?? 0),
        ledgerCount: Number(rows[0]?.ledgerCount ?? 0),
        missingTags: report.missingTags,
      };
    });

    // main's old assertion: max(created_at) >= the newest journal `when`. It
    // passes here, which is the whole reason the gap shipped to production.
    const newestJournalWhen = Math.max(...[...PHASE_ONE, STALE_WHEN_ENTRY].map((entry) => entry.when));
    assert.equal(latestCreatedAt >= newestJournalWhen, true, 'the old latest-only check is expected to pass');
    assert.equal(ledgerCount, 2);

    assert.deepEqual(missingTags, ['0002_stale_when'], 'the per-entry check must name the skipped migration');

    // And it never self-heals: a third deploy does not create the table either.
    await applyMigrations(scratchUrl, migrationsFolder);
    assert.equal(await tableExists(scratchUrl, 'mjv_t_stale'), false, 'a later deploy is expected not to self-heal');
  });

  it('catches a ledger row deleted out from under a fully applied database', async (context) => {
    const adminUrl = localDatabaseUrl();
    if (!adminUrl) {
      context.skip('set DATABASE_URL to a local Postgres to run');
      return;
    }
    const migrationsFolder = makeTempFolder('deleted');
    writeMigrationsFolder(migrationsFolder, PHASE_ONE);
    const scratchUrl = await createScratchDatabase(adminUrl, 'deleted');
    await applyMigrations(scratchUrl, migrationsFolder);

    const expected = readExpectedMigrations(migrationsFolder);
    const firstEntryHash = expected[0].hash;
    await withScratchClient(scratchUrl, async (client) => {
      await client`DELETE FROM drizzle."__drizzle_migrations" WHERE hash = ${firstEntryHash}`;
    });

    const afterDeletion = await withScratchClient(scratchUrl, (client) =>
      inspectMigrationJournal(readLedgerHashesWith(client), migrationsFolder),
    );
    assert.deepEqual(afterDeletion.missingTags, ['0000_a']);

    // migrate() does not restore it — the high-water mark is still at 3000.
    await applyMigrations(scratchUrl, migrationsFolder);
    const afterRerun = await withScratchClient(scratchUrl, (client) =>
      inspectMigrationJournal(readLedgerHashesWith(client), migrationsFolder),
    );
    assert.deepEqual(afterRerun.missingTags, ['0000_a'], 'a re-run is expected not to restore the deleted row');

    // The repair needs the hash, not just the tag: re-deriving a sha256 by hand
    // is the parity liability this whole check exists to avoid.
    assert.deepEqual(
      afterDeletion.missing.map((migration) => migration.tag),
      ['0000_a'],
    );
    assert.equal(afterDeletion.missing[0].hash, firstEntryHash);
  });

  it('ignores ledger rows that belong to no journal entry', async (context) => {
    const adminUrl = localDatabaseUrl();
    if (!adminUrl) {
      context.skip('set DATABASE_URL to a local Postgres to run');
      return;
    }
    // Renumbering leaves orphan rows behind (two on the shared dev database).
    // Failing on those would block deploys for benign residue.
    const migrationsFolder = makeTempFolder('orphan');
    writeMigrationsFolder(migrationsFolder, PHASE_ONE);
    const scratchUrl = await createScratchDatabase(adminUrl, 'orphan');
    await applyMigrations(scratchUrl, migrationsFolder);

    await withScratchClient(scratchUrl, async (client) => {
      await client`
        INSERT INTO drizzle."__drizzle_migrations" (hash, created_at)
        VALUES (${'hash-of-a-renumbered-away-migration'}, ${500})
      `;
    });

    const report = await withScratchClient(scratchUrl, (client) =>
      inspectMigrationJournal(readLedgerHashesWith(client), migrationsFolder),
    );
    assert.deepEqual(report.missingTags, []);
    assert.equal(report.ledgerCount, 3);
  });

  it('refuses to pair tags with hashes when drizzle stops returning journal order', () => {
    // No database needed. The ordering guard cannot be tripped from outside —
    // drizzle reads the same journal we do, so folderMillis always matches —
    // hence the injected reader. This pins the behaviour a future drizzle that
    // reorders or filters readMigrationFiles would hit: throw, never silently
    // attach the wrong tag to a hash.
    const migrationsFolder = makeTempFolder('ordering');
    writeMigrationsFolder(migrationsFolder, PHASE_ONE);

    const inOrder = readExpectedMigrations(migrationsFolder);
    assert.deepEqual(
      inOrder.map((migration) => migration.tag),
      ['0000_a', '0001_b'],
    );

    assert.throws(
      () =>
        readExpectedMigrations(migrationsFolder, () => [
          { folderMillis: 3000, hash: 'hash-of-0001_b' },
          { folderMillis: 1000, hash: 'hash-of-0000_a' },
        ]),
      /no longer returns journal order/,
    );

    assert.throws(
      () => readExpectedMigrations(migrationsFolder, () => [{ folderMillis: 1000, hash: 'hash-of-0000_a' }]),
      /drizzle read 1 migration files for 2 journal entries/,
    );
  });

  it('keeps findUnappliedMigrations multiset-aware for byte-identical migrations', () => {
    // No database needed; pins the property the real folder could regain via a
    // renumber that copies a .sql file without deleting the original.
    const duplicate = 'identical-sql-body';
    assert.deepEqual(
      findUnappliedMigrations(
        [
          { tag: '0000_original', hash: duplicate },
          { tag: '0001_copy', hash: duplicate },
        ],
        [duplicate],
      ),
      ['0001_copy'],
    );
  });
});
