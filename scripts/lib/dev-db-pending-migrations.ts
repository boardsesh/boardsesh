/// <reference types="node" />

/**
 * Which journal migrations a *dev* database still needs — keyed on the ledger
 * hash, never on a `created_at` high-water mark.
 *
 * Why this exists (#3979): `scripts/dev-db-up.sh` and `scripts/dev-db-discover.ts`
 * each reimplemented drizzle's applier, and each reimplemented its bug. Both read
 * `max(created_at)` from `drizzle."__drizzle_migrations"` once, before the loop,
 * and applied only journal entries whose `when` was strictly greater. A migration
 * whose `when` lands at or below that mark is skipped on that run and on every
 * run after it, because the mark only ever moves up — the same defect #2933
 * reported in `packages/db/scripts/migrate.ts` and #3977 fixed there.
 *
 * On a dev database the mark sits below a branch's migration for entirely
 * ordinary reasons: a rebase renumbered it, two branches collapsed their
 * migrations into one, or the pre-built image was built after the branch's `when`
 * was minted. The result is a checkout that reports "No pending migrations." and
 * a schema that is missing the table the branch just added.
 *
 * The selection here still compares journal entries by hash, through the same
 * `findUnappliedMigrations()` the production gate uses. Before returning any
 * SQL to execute, it also proves that the applied rows are an exact journal
 * prefix. An absent hash in the middle of an existing ledger is unverified
 * history, not permission to replay that migration's SQL.
 *
 * ## Hash parity with drizzle
 *
 * `packages/db` reads its hashes from drizzle's own `readMigrationFiles`, which
 * is the only way to be certain they match. Root `scripts/` cannot: `drizzle-orm`
 * is a `packages/db` dependency and pnpm's isolated linker gives the repo root no
 * hoisted copy. So the sha256 is re-derived here — the same derivation drizzle
 * 0.45 uses and the same one the `bun --eval` block this replaces already
 * computed: `readFileSync(file, 'utf8')`, then `sha256` of that string. Note that
 * this is the file decoded as UTF-8 and re-encoded, not the bytes on disk;
 * `Dockerfile.dev-db` writes `sha256sum` of the raw bytes and agrees with it only
 * because every migration is UTF-8 with no BOM (`check:db-migrations` reads the
 * folder the same way, and a BOM would break drizzle's own hash first). A drizzle
 * bump that changed the derivation would break the parity; `packages/db`'s
 * journal-verification integration test runs against drizzle's real hashes and is
 * where that would surface.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJournal } from './drizzle-migrations.js';
import { findUnappliedMigrations, type ExpectedMigrationWithWhen } from './migration-ledger.js';

/**
 * The separator between the three fields of one output line. `dev-db-up.sh`
 * reads them back with `IFS='|' read -r tag when hash`, and none of the three
 * can contain a pipe: tags match `NNNN_suffix`, `when` is digits, the hash is
 * hex.
 */
export const PENDING_MIGRATION_SEPARATOR = '|';

/**
 * Safe pending journal suffix after an exact, non-empty applied journal prefix.
 *
 * A missing hash is safe to apply automatically only when every preceding
 * journal entry has its ledger row. Otherwise the database may have lost a
 * historical row for SQL that already ran; replaying that SQL can delete user
 * data. We fail closed on holes, unknown hashes, duplicate/excess rows, and an
 * empty existing ledger. The shared missing-only comparator remains an extra
 * consistency check and preserves multiset behavior for byte-identical files.
 */
export function selectPendingMigrations(
  expected: readonly ExpectedMigrationWithWhen[],
  ledgerHashes: readonly string[],
): ExpectedMigrationWithWhen[] {
  if (expected.length === 0) {
    if (ledgerHashes.length > 0) {
      throw unsafeLedgerError(`the ledger has ${ledgerHashes.length} row(s), but the journal has no entries.`);
    }
    return [];
  }

  if (ledgerHashes.length === 0) {
    throw unsafeLedgerError('the existing database has an empty migration ledger.');
  }

  for (const [index, ledgerHash] of ledgerHashes.entries()) {
    const expectedMigration = expected[index];
    if (!expectedMigration) {
      throw unsafeLedgerError(`ledger row ${index + 1} has an excess hash ${ledgerHash}.`);
    }
    if (ledgerHash === expectedMigration.hash) continue;

    const matchingJournalIndex = expected.findIndex((migration) => migration.hash === ledgerHash);
    if (matchingJournalIndex > index) {
      const laterMigration = expected[matchingJournalIndex];
      throw unsafeLedgerError(
        `the applied ledger has an unverified historical gap before ${expectedMigration.tag}; ` +
          `row ${index + 1} matches later journal entry ${laterMigration?.tag ?? 'unknown'} instead.`,
      );
    }
    if (matchingJournalIndex >= 0) {
      throw unsafeLedgerError(
        `ledger row ${index + 1} repeats or reorders hash ${ledgerHash}, already expected at journal row ` +
          `${matchingJournalIndex + 1}.`,
      );
    }
    throw unsafeLedgerError(`ledger row ${index + 1} has an unknown hash ${ledgerHash}.`);
  }

  const safeSuffix = expected.slice(ledgerHashes.length);
  const appliedHashes = new Set(ledgerHashes);
  const ambiguousDuplicate = safeSuffix.find((migration) => appliedHashes.has(migration.hash));
  if (ambiguousDuplicate) {
    throw unsafeLedgerError(
      `pending migration ${ambiguousDuplicate.tag} has the same hash as an applied row, so its position in history cannot be verified.`,
    );
  }

  const missingTags = findUnappliedMigrations(expected, ledgerHashes);
  if (
    missingTags.length !== safeSuffix.length ||
    safeSuffix.some((migration, index) => missingTags[index] !== migration.tag)
  ) {
    throw unsafeLedgerError('the ledger and journal do not describe one contiguous applied prefix.');
  }
  return safeSuffix;
}

function unsafeLedgerError(reason: string): Error {
  return new Error(
    `Refusing to apply dev-database migrations: ${reason} ` +
      'Missing hashes do not prove that historical SQL never ran. No migration SQL was executed. ' +
      'Have the database owner verify and reconcile its history before retrying.',
  );
}

/**
 * Every journal entry paired with its `.sql`'s sha256 and the journal's own
 * `when` — the value drizzle stamps into `created_at`, so a row this applier
 * writes is indistinguishable from one drizzle wrote.
 */
export function readJournalMigrations(drizzleDir: string): ExpectedMigrationWithWhen[] {
  const journal = parseJournal(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8'));
  return journal.entries.map((entry) => ({
    tag: entry.tag,
    when: entry.when,
    hash: hashMigrationFile(join(drizzleDir, `${entry.tag}.sql`)),
  }));
}

/** sha256 of the file read as UTF-8 — see the hash-parity note in the module header. */
export function hashMigrationFile(migrationFilePath: string): string {
  return createHash('sha256').update(readFileSync(migrationFilePath, 'utf8')).digest('hex');
}

/**
 * Ledger hashes as `psql -t -A` prints them: one per line, with a trailing
 * newline and — for an empty ledger — a single blank line. Blank lines are
 * dropped rather than treated as a hash; the selector rejects an empty existing
 * ledger instead of assuming it is safe to replay the full migration history.
 */
export function parseLedgerHashes(psqlOutput: string): string[] {
  return psqlOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** One `tag|when|hash` line per pending migration, in journal order. */
export function formatPendingMigrations(pending: readonly ExpectedMigrationWithWhen[]): string {
  return pending
    .map((migration) => [migration.tag, migration.when, migration.hash].join(PENDING_MIGRATION_SEPARATOR))
    .join('\n');
}
