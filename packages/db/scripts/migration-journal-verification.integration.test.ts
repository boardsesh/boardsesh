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
import { PRODUCTION_LEDGER_BASELINE, type LedgerBaseline } from '../../../scripts/lib/migration-ledger-baseline.js';
import { DRIZZLE_LEDGER_TABLE, normalizeLedgerTable } from './normalize-ledger-timestamps.js';
import {
  DRIZZLE_MIGRATIONS_FOLDER,
  assertMigrationJournalApplied,
  describeBaselinedGap,
  inspectMigrationJournal,
  readExpectedMigrations,
  readLedgerHashesWith,
  runMigrationJournalGate,
} from './migration-journal.js';

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

    // The gate must also be incapable of failing closed on a healthy database:
    // `migrate` is the `needs:` gate for both production deploy jobs, so a
    // false positive here stops every release.
    await assert.doesNotReject(
      withScratchClient(scratchUrl, (client) =>
        assertMigrationJournalApplied(readLedgerHashesWith(client), migrationsFolder),
      ),
    );
    await assert.doesNotReject(
      withScratchClient(scratchUrl, (client) =>
        runMigrationJournalGate({ VERIFY_MIGRATION_JOURNAL: '1' }, readLedgerHashesWith(client), migrationsFolder),
      ),
    );
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

    // Detecting the gap is not the fix — failing on it is. These two pin the
    // fail-closed behaviour #2933 asks for, so the check cannot be quietly
    // downgraded back to "report it and deploy anyway".
    await assert.rejects(
      withScratchClient(scratchUrl, (client) =>
        assertMigrationJournalApplied(readLedgerHashesWith(client), migrationsFolder),
      ),
      /Migration journal verification failed:[\s\S]*0002_stale_when/,
    );
    await assert.rejects(
      withScratchClient(scratchUrl, (client) =>
        runMigrationJournalGate({ VERIFY_MIGRATION_JOURNAL: '1' }, readLedgerHashesWith(client), migrationsFolder),
      ),
      /0002_stale_when/,
      'migrate.ts runs the check through runMigrationJournalGate — it must throw, not report',
    );

    // Gate off: the same broken database passes untouched. That is what keeps
    // `vp run db:migrate` usable against the dev-db image (#3978) — and it must
    // not read the ledger at all, so a future default-on flip is a visible change.
    let ledgerReads = 0;
    const gateOff = await withScratchClient(scratchUrl, (client) => {
      const readHashes = readLedgerHashesWith(client);
      return runMigrationJournalGate(
        {},
        () => {
          ledgerReads += 1;
          return readHashes();
        },
        migrationsFolder,
      );
    });
    assert.equal(gateOff, null, 'an unset VERIFY_MIGRATION_JOURNAL must skip the check');
    assert.equal(ledgerReads, 0, 'the gate must not query the ledger when it is off');

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

  it('only arms the deploy gate on an exact VERIFY_MIGRATION_JOURNAL=1', async () => {
    // No database needed: the ledger reader is a stub, so this pins the env
    // contract on its own. `production-deploy.yml` and `db-migration-renumber.yml`
    // both pass the literal '1'; anything else must leave the check off rather
    // than half-on.
    const migrationsFolder = makeTempFolder('gate');
    writeMigrationsFolder(migrationsFolder, PHASE_ONE);
    const emptyLedger = async () => [];

    for (const value of [undefined, '', '0', 'true', 'yes']) {
      const report = await runMigrationJournalGate(
        value === undefined ? {} : { VERIFY_MIGRATION_JOURNAL: value },
        emptyLedger,
        migrationsFolder,
      );
      assert.equal(report, null, `VERIFY_MIGRATION_JOURNAL=${String(value)} must not arm the gate`);
    }

    await assert.rejects(
      runMigrationJournalGate({ VERIFY_MIGRATION_JOURNAL: '1' }, emptyLedger, migrationsFolder),
      /Missing: 0000_a, 0001_b/,
    );
  });

  it('tolerates a baselined gap and still fails on the one beside it', async (context) => {
    const adminUrl = localDatabaseUrl();
    if (!adminUrl) {
      context.skip('set DATABASE_URL to a local Postgres to run');
      return;
    }
    // The production shape after the gate first armed: a gap that predates the
    // check (baselined) sitting alongside one that does not. Only the second may
    // block a deploy — but the first must still be reported, or nobody repairs it.
    const migrationsFolder = makeTempFolder('baselined');
    const scratchUrl = await createScratchDatabase(adminUrl, 'baselined');
    writeMigrationsFolder(migrationsFolder, PHASE_ONE);
    await applyMigrations(scratchUrl, migrationsFolder);

    // 0000_a's row goes missing (a restore, or an earlier hand repair), and a
    // second migration lands below the high-water mark and is skipped.
    const [firstEntry] = readExpectedMigrations(migrationsFolder);
    await withScratchClient(scratchUrl, async (client) => {
      await client`DELETE FROM drizzle."__drizzle_migrations" WHERE hash = ${firstEntry.hash}`;
    });
    writeMigrationsFolder(migrationsFolder, [...PHASE_ONE, STALE_WHEN_ENTRY]);
    await applyMigrations(scratchUrl, migrationsFolder);

    const baseline: LedgerBaseline = { recordedAt: '2026-07-30', source: 'test', migrations: [firstEntry] };
    const report = await withScratchClient(scratchUrl, (client) =>
      inspectMigrationJournal(readLedgerHashesWith(client), migrationsFolder, baseline),
    );
    assert.deepEqual(report.missingTags, ['0000_a', '0002_stale_when']);
    assert.deepEqual(
      report.baselinedMissing.map((migration) => migration.tag),
      ['0000_a'],
    );
    assert.deepEqual(
      report.unbaselinedMissing.map((migration) => migration.tag),
      ['0002_stale_when'],
    );
    // The repair hash travels with the baselined tag too — that is what shrinking
    // the baseline needs.
    assert.equal(report.baselinedMissing[0].hash, firstEntry.hash);
    const warning = describeBaselinedGap(report);
    assert.ok(warning?.includes('0000_a'), 'a tolerated gap must still be named on every run');
    assert.ok(!warning?.includes('0002_stale_when'));

    await assert.rejects(
      withScratchClient(scratchUrl, (client) =>
        runMigrationJournalGate({ VERIFY_MIGRATION_JOURNAL: '1' }, readLedgerHashesWith(client), migrationsFolder, {
          ...baseline,
        }),
      ),
      /Missing: 0002_stale_when/,
      'the unbaselined gap must still fail the deploy, and the message must not blame the baselined one',
    );

    // Baseline both and the deploy proceeds — the state production is in today.
    const bothBaselined = await withScratchClient(scratchUrl, (client) =>
      runMigrationJournalGate({ VERIFY_MIGRATION_JOURNAL: '1' }, readLedgerHashesWith(client), migrationsFolder, {
        ...baseline,
        migrations: readExpectedMigrations(migrationsFolder).filter((migration) => migration.tag !== '0001_b'),
      }),
    );
    assert.deepEqual(bothBaselined?.unbaselinedMissing, []);
    assert.equal(bothBaselined?.baselinedMissing.length, 2);
  });

  it('stops tolerating a baselined migration once its .sql changes', async (context) => {
    const adminUrl = localDatabaseUrl();
    if (!adminUrl) {
      context.skip('set DATABASE_URL to a local Postgres to run');
      return;
    }
    // Editing an applied migration does not re-run it — drizzle's mark is past it
    // — so a tag-only exemption would report "known gap, deploy on" while the new
    // statements exist in no database. The recorded hash is what makes that fatal.
    const migrationsFolder = makeTempFolder('edited');
    const scratchUrl = await createScratchDatabase(adminUrl, 'edited');
    writeMigrationsFolder(migrationsFolder, PHASE_ONE);
    await applyMigrations(scratchUrl, migrationsFolder);

    const [entryAsRecorded] = readExpectedMigrations(migrationsFolder);
    await withScratchClient(scratchUrl, async (client) => {
      await client`DELETE FROM drizzle."__drizzle_migrations" WHERE hash = ${entryAsRecorded.hash}`;
    });
    const baseline: LedgerBaseline = { recordedAt: '2026-07-30', source: 'test', migrations: [entryAsRecorded] };

    // As recorded: tolerated.
    const tolerated = await withScratchClient(scratchUrl, (client) =>
      runMigrationJournalGate({ VERIFY_MIGRATION_JOURNAL: '1' }, readLedgerHashesWith(client), migrationsFolder, {
        ...baseline,
      }),
    );
    assert.deepEqual(tolerated?.unbaselinedMissing, []);

    // Same tag, new body: fatal, and the message points at the edit.
    writeMigrationsFolder(migrationsFolder, [
      { ...PHASE_ONE[0], sql: `${PHASE_ONE[0].sql} ALTER TABLE mjv_t_a ADD COLUMN added_later int;` },
      PHASE_ONE[1],
    ]);
    const edited = readExpectedMigrations(migrationsFolder)[0];
    assert.notEqual(edited.hash, entryAsRecorded.hash, 'the edit must change the hash drizzle expects');

    const report = await withScratchClient(scratchUrl, (client) =>
      inspectMigrationJournal(readLedgerHashesWith(client), migrationsFolder, { ...baseline }),
    );
    assert.deepEqual(report.baselinedMissing, []);
    assert.deepEqual(
      report.editedSinceBaseline.map((migration) => migration.tag),
      ['0000_a'],
    );
    assert.equal(describeBaselinedGap(report), null, 'nothing is tolerated, so there is no warning to print');

    await assert.rejects(
      withScratchClient(scratchUrl, (client) =>
        runMigrationJournalGate({ VERIFY_MIGRATION_JOURNAL: '1' }, readLedgerHashesWith(client), migrationsFolder, {
          ...baseline,
        }),
      ),
      /0000_a[\s\S]*no longer hashes to the recorded value/,
    );
  });

  it('keeps the production baseline hashes in step with the files on disk', () => {
    // The recorded hashes come from drizzle's readMigrationFiles, so they can only
    // be checked where drizzle is a dependency. Editing a baselined .sql reddens
    // this at PR time instead of turning the exemption fatal mid-deploy.
    const currentHashByTag = new Map(
      readExpectedMigrations().map((migration) => [migration.tag, migration.hash] as const),
    );
    for (const migration of PRODUCTION_LEDGER_BASELINE.migrations) {
      assert.equal(
        currentHashByTag.get(migration.tag),
        migration.hash,
        `${migration.tag} no longer hashes to its recorded baseline value — an applied migration was edited, ` +
          'so the new statements are in no database. Write a new migration instead.',
      );
    }
  });

  it('rejects a baseline tag that is not in the journal', async () => {
    // A renamed or mistyped tag would silently tolerate nothing while looking
    // like it tolerated something. No database needed.
    const migrationsFolder = makeTempFolder('stale-baseline');
    writeMigrationsFolder(migrationsFolder, PHASE_ONE);
    const [firstEntry] = readExpectedMigrations(migrationsFolder);

    await assert.rejects(
      inspectMigrationJournal(async () => [], migrationsFolder, {
        recordedAt: '2026-07-30',
        source: 'test',
        migrations: [firstEntry, { tag: '0404_never_existed', hash: 'hash-of-a-tag-that-never-existed' }],
      }),
      /baseline is stale: 0404_never_existed/,
    );
  });

  it('applies the production baseline only to the real migrations folder', async () => {
    // The default baseline names tags from packages/db/drizzle. A synthetic
    // folder must get an empty one, or every scenario above would trip the
    // journal-membership check instead of testing what it means to test.
    const migrationsFolder = makeTempFolder('default-baseline');
    writeMigrationsFolder(migrationsFolder, PHASE_ONE);

    const report = await inspectMigrationJournal(async () => [], migrationsFolder);
    assert.deepEqual(report.baseline.migrations, []);
    assert.deepEqual(
      report.unbaselinedMissing.map((migration) => migration.tag),
      ['0000_a', '0001_b'],
    );
  });

  it('recognises the real migrations folder however its path was written', async () => {
    // A trailing slash or a path built with join() names the same folder, and
    // falling through to the empty baseline there would show up as a blocked
    // production deploy rather than as an error that explains itself.
    for (const spelling of [
      DRIZZLE_MIGRATIONS_FOLDER,
      `${DRIZZLE_MIGRATIONS_FOLDER}/`,
      path.join(DRIZZLE_MIGRATIONS_FOLDER, '..', 'drizzle'),
    ]) {
      const report = await inspectMigrationJournal(async () => [], spelling);
      assert.deepEqual(
        report.baseline.migrations,
        PRODUCTION_LEDGER_BASELINE.migrations,
        `${spelling} must resolve to the production baseline`,
      );
    }
  });

  it('unblocks a build-clock-stamped ledger so drizzle applies the next migration (#4211)', async (context) => {
    const adminUrl = localDatabaseUrl();
    if (!adminUrl) {
      context.skip('set DATABASE_URL to a local Postgres to run');
      return;
    }
    // The dev-db image's exact shape: the journal is applied by a psql loop that
    // stamps every ledger row with the image's build clock instead of the
    // entry's `when`. That single value is a high-water mark drizzle can never
    // clear, so every migration written after the image was built is skipped —
    // on that deploy and on every one after it.
    const migrationsFolder = makeTempFolder('build-clock');
    const scratchUrl = await createScratchDatabase(adminUrl, 'build_clock');
    writeMigrationsFolder(migrationsFolder, PHASE_ONE);
    await applyMigrations(scratchUrl, migrationsFolder);

    // As drizzle left it, there is nothing to repair — the normaliser writes the
    // same value drizzle already wrote.
    const drizzleManagedPlan = await withScratchClient(scratchUrl, (client) =>
      normalizeLedgerTable(client, DRIZZLE_LEDGER_TABLE, readExpectedMigrations(migrationsFolder), { dryRun: true }),
    );
    assert.deepEqual(drizzleManagedPlan, [], 'a drizzle-managed ledger must need no repair');

    const BUILD_CLOCK = 1_800_000_000_000;
    await withScratchClient(scratchUrl, async (client) => {
      await client`UPDATE drizzle."__drizzle_migrations" SET created_at = ${BUILD_CLOCK}`;
    });

    // A new migration lands, appended above every journal `when` but far below
    // the build clock.
    const laterEntry = { tag: '0002_later', when: 4000, sql: 'CREATE TABLE mjv_t_later (id int);' };
    writeMigrationsFolder(migrationsFolder, [...PHASE_ONE, laterEntry]);
    await applyMigrations(scratchUrl, migrationsFolder);

    assert.equal(
      await tableExists(scratchUrl, 'mjv_t_later'),
      false,
      'the build-clock high-water mark is expected to make drizzle skip the new migration',
    );
    await assert.rejects(
      withScratchClient(scratchUrl, (client) =>
        assertMigrationJournalApplied(readLedgerHashesWith(client), migrationsFolder),
      ),
      /0002_later/,
      'the gate must see the skip as a real gap',
    );

    // The repair: rewrite created_at to each entry's own `when`.
    const repairs = await withScratchClient(scratchUrl, (client) =>
      normalizeLedgerTable(client, DRIZZLE_LEDGER_TABLE, readExpectedMigrations(migrationsFolder)),
    );
    assert.deepEqual(
      repairs.map((repair) => ({ tag: repair.tag, to: repair.to })),
      [
        { tag: '0000_a', to: 1000 },
        { tag: '0001_b', to: 3000 },
      ],
      'only the two rows the image stamped exist, and each takes its own journal when',
    );

    await applyMigrations(scratchUrl, migrationsFolder);
    assert.equal(await tableExists(scratchUrl, 'mjv_t_later'), true, 'the repaired ledger must let the migration run');
    await assert.doesNotReject(
      withScratchClient(scratchUrl, (client) =>
        assertMigrationJournalApplied(readLedgerHashesWith(client), migrationsFolder),
      ),
    );

    // And drizzle's own row for the newly applied migration already carries the
    // journal `when`, so a second pass finds nothing to do.
    const secondPass = await withScratchClient(scratchUrl, (client) =>
      normalizeLedgerTable(client, DRIZZLE_LEDGER_TABLE, readExpectedMigrations(migrationsFolder), { dryRun: true }),
    );
    assert.deepEqual(secondPass, [], 'the repair must be idempotent');
  });

  it('leaves a ledger table it cannot find alone (#4211)', async (context) => {
    const adminUrl = localDatabaseUrl();
    if (!adminUrl) {
      context.skip('set DATABASE_URL to a local Postgres to run');
      return;
    }
    // Older images have no legacy public."__drizzle_migrations" (and a brand new
    // database has no drizzle schema at all). `vp run db:up` runs the normaliser
    // unconditionally, so an absent table must be a quiet no-op, not a crash.
    const migrationsFolder = makeTempFolder('absent-table');
    const scratchUrl = await createScratchDatabase(adminUrl, 'absent_table');
    writeMigrationsFolder(migrationsFolder, PHASE_ONE);

    const plan = await withScratchClient(scratchUrl, (client) =>
      normalizeLedgerTable(client, DRIZZLE_LEDGER_TABLE, readExpectedMigrations(migrationsFolder)),
    );
    assert.deepEqual(plan, []);
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
