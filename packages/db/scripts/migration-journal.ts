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
 */
export function readExpectedMigrations(migrationsFolder: string = DRIZZLE_MIGRATIONS_FOLDER): ExpectedMigration[] {
  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as MigrationJournal;
  const migrationFiles = readMigrationFiles({ migrationsFolder });
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
  return {
    expectedCount: expected.length,
    ledgerCount: ledgerHashes.length,
    missingTags: findUnappliedMigrations(expected, ledgerHashes),
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
