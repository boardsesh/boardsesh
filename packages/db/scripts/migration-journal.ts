import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { Sql } from 'postgres';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  findUnappliedMigrations,
  formatMigrationGapError,
  type ExpectedMigration,
} from '../../../scripts/lib/migration-ledger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The drizzle folder `migrate.ts` applies and `verify-migration-journal.ts` checks. */
export const DRIZZLE_MIGRATIONS_FOLDER = path.resolve(__dirname, '../drizzle');

type MigrationJournalEntry = { tag: string; when: number };
type MigrationJournal = { entries: MigrationJournalEntry[] };

/**
 * Injected read of `drizzle."__drizzle_migrations"`. A function rather than a
 * client so the integration test can point the same check at a throwaway
 * database, and so nothing here owns a connection.
 */
export type ReadLedgerHashes = () => Promise<readonly string[]>;

/**
 * The one query this check runs against a real database. A single SELECT on
 * drizzle's own bookkeeping table — no writes, nothing schema-dependent — which
 * is what makes `verify-migration-journal.ts` safe to point at production.
 */
export function readLedgerHashesWith(client: Sql): ReadLedgerHashes {
  return async () => {
    const rows = await client<{ hash: string }[]>`SELECT hash FROM drizzle."__drizzle_migrations"`;
    return rows.map((row) => row.hash);
  };
}

export interface MigrationJournalReport {
  expectedCount: number;
  ledgerCount: number;
  /** Journal-order tags with no ledger row. Empty means the database is complete. */
  missingTags: string[];
  /**
   * The same gap with each tag's hash attached. The repair inserts a ledger row
   * carrying that hash, and re-deriving the sha256 by hand is exactly the parity
   * liability this module exists to avoid — so the operator is handed the hash
   * drizzle would have written rather than told to compute one.
   */
  missing: ExpectedMigration[];
}

/**
 * Journal entries paired with the hash drizzle records for each one.
 *
 * The hashes come from drizzle's own exported `readMigrationFiles` rather than a
 * re-derived sha256: any re-derivation is a permanent parity liability (file
 * encoding, BOM, line endings, or a future drizzle change all silently turn this
 * deploy gate into a false positive). `readMigrationFiles` walks
 * `journal.entries` in order and returns one entry per journal entry, so zipping
 * it back against the journal by index is exact — same file, same parse.
 *
 * `MigrationMeta` carries no `tag`, so the index zip is the only join available,
 * and it rests on drizzle's iteration order. Rather than trust that silently,
 * both invariants that would break the pairing are checked below: one file per
 * journal entry, and each file's `folderMillis` equal to that entry's `when`. A
 * drizzle version that reordered or filtered `readMigrationFiles` would throw
 * here instead of quietly attaching the wrong tag to a hash.
 *
 * Both invariants are unreachable against drizzle 0.45.x: `readMigrationFiles`
 * iterates `journal.entries` in order, pushes exactly one entry per journal
 * entry (or throws `No file ... found`), and copies `folderMillis` straight from
 * `journalEntry.when` — the same journal this function parses. They are a
 * tripwire for a future drizzle bump, not a live guard, which is why the
 * `readFiles` seam exists at all: without it there is nothing to test.
 */
export function readExpectedMigrations(
  migrationsFolder: string = DRIZZLE_MIGRATIONS_FOLDER,
  // Seam for the ordering guard's own test (see above). No production caller
  // passes this — drizzle reads the same journal we do, so the invariants
  // cannot be misaligned from the outside.
  readFiles: (config: {
    migrationsFolder: string;
  }) => readonly { folderMillis: number; hash: string }[] = readMigrationFiles,
): ExpectedMigration[] {
  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as MigrationJournal;
  const migrationFiles = readFiles({ migrationsFolder });
  if (migrationFiles.length !== journal.entries.length) {
    throw new Error(
      `Migration journal verification failed: drizzle read ${migrationFiles.length} migration files ` +
        `for ${journal.entries.length} journal entries in ${migrationsFolder}.`,
    );
  }
  return migrationFiles.map((migrationFile, index) => {
    const journalEntry = journal.entries[index];
    if (migrationFile.folderMillis !== journalEntry.when) {
      throw new Error(
        `Migration journal verification failed: drizzle's migration file at position ${index} has ` +
          `folderMillis ${migrationFile.folderMillis}, but journal entry ${journalEntry.tag} has ` +
          `when ${journalEntry.when}. readMigrationFiles no longer returns journal order.`,
      );
    }
    return { tag: journalEntry.tag, hash: migrationFile.hash };
  });
}

/**
 * Read-only: one `SELECT hash FROM drizzle."__drizzle_migrations"` plus local
 * file reads. Safe to point at production.
 */
export async function inspectMigrationJournal(
  readLedgerHashes: ReadLedgerHashes,
  migrationsFolder: string = DRIZZLE_MIGRATIONS_FOLDER,
): Promise<MigrationJournalReport> {
  const expected = readExpectedMigrations(migrationsFolder);
  const ledgerHashes = await readLedgerHashes();
  const missingTags = findUnappliedMigrations(expected, ledgerHashes);
  const missingTagSet = new Set(missingTags);
  return {
    expectedCount: expected.length,
    ledgerCount: ledgerHashes.length,
    missingTags,
    missing: expected.filter((migration) => missingTagSet.has(migration.tag)),
  };
}

/** Throws with every missing tag named, or returns the (clean) report. */
export async function assertMigrationJournalApplied(
  readLedgerHashes: ReadLedgerHashes,
  migrationsFolder: string = DRIZZLE_MIGRATIONS_FOLDER,
): Promise<MigrationJournalReport> {
  const report = await inspectMigrationJournal(readLedgerHashes, migrationsFolder);
  if (report.missingTags.length > 0) {
    throw new Error(formatMigrationGapError(report.missingTags, report.expectedCount, report.ledgerCount));
  }
  return report;
}

/** Env var that turns the deploy gate on. Set by production-deploy.yml and db-migration-renumber.yml. */
export const VERIFY_MIGRATION_JOURNAL_ENV = 'VERIFY_MIGRATION_JOURNAL';

/**
 * The deploy gate exactly as `migrate.ts` runs it: verify when
 * `VERIFY_MIGRATION_JOURNAL=1`, otherwise do nothing and touch no database.
 *
 * This lives here rather than inline in `migrate.ts` so the fail-closed
 * behaviour — the whole point of #2933 — is reachable from a test. `migrate.ts`
 * is a top-level script that connects on import and has no seam, so an inline
 * gate would be uncovered: swapping the throwing check for the reporting one
 * would restore the pre-fix "detect the gap, log it, deploy anyway" semantics
 * with the suite still green.
 *
 * Returns the report when the gate ran, `null` when it was off.
 */
export async function runMigrationJournalGate(
  env: Record<string, string | undefined>,
  readLedgerHashes: ReadLedgerHashes,
  migrationsFolder: string = DRIZZLE_MIGRATIONS_FOLDER,
): Promise<MigrationJournalReport | null> {
  if (env[VERIFY_MIGRATION_JOURNAL_ENV] !== '1') {
    return null;
  }
  return assertMigrationJournalApplied(readLedgerHashes, migrationsFolder);
}
