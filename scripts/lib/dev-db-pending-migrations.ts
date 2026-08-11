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
 * The selection here asks the per-entry question instead, through the same
 * `findUnappliedMigrations()` the production gate uses, so the two paths cannot
 * drift into disagreeing about what "applied" means.
 *
 * ## Hash parity with drizzle
 *
 * `packages/db` reads its hashes from drizzle's own `readMigrationFiles`, which
 * is the only way to be certain they match. Root `scripts/` cannot: `drizzle-orm`
 * is a `packages/db` dependency and Bun's isolated linker gives the repo root no
 * hoisted copy. So the sha256 is derived here from the raw `.sql` bytes — which
 * is exactly what drizzle 0.45's `readMigrationFiles` does, what
 * `packages/db/docker/Dockerfile.dev-db` writes with `sha256sum`, and what the
 * `bun --eval` block this replaces already computed. A drizzle bump that changed
 * the derivation would break the parity; `packages/db`'s journal-verification
 * integration test runs against drizzle's real hashes and is where that would
 * surface.
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
 * Journal entries with no matching ledger row, in journal order.
 *
 * Delegates the comparison to `findUnappliedMigrations` rather than repeating
 * its multiset walk: byte-identical `.sql` files share a hash, and two such
 * entries need two ledger rows rather than one. Re-selecting by tag afterwards
 * is exact because journal tags are unique — `scripts/check-db-migrations.ts`
 * fails a PR that introduces a duplicate.
 */
export function selectPendingMigrations(
  expected: readonly ExpectedMigrationWithWhen[],
  ledgerHashes: readonly string[],
): ExpectedMigrationWithWhen[] {
  const pendingTags = new Set(findUnappliedMigrations(expected, ledgerHashes));
  return expected.filter((migration) => pendingTags.has(migration.tag));
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

/** sha256 over the raw file bytes — see the hash-parity note in the module header. */
export function hashMigrationFile(migrationFilePath: string): string {
  return createHash('sha256').update(readFileSync(migrationFilePath, 'utf8')).digest('hex');
}

/**
 * Ledger hashes as `psql -t -A` prints them: one per line, with a trailing
 * newline and — for an empty ledger — a single blank line. Blank lines are
 * dropped rather than treated as a hash, which is what makes "fresh tracker,
 * nothing applied" select the whole journal instead of nothing.
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
