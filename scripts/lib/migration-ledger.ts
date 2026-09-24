/**
 * Pure comparison between the migration journal and drizzle's applied-migration
 * ledger (`drizzle.__drizzle_migrations`).
 *
 * Why this exists: drizzle's applier is a single high-water mark, not a
 * reconciliation. `PgDialect.migrate()` reads `max(created_at)` from the ledger
 * once, before the loop, and applies only journal entries whose `when` is
 * strictly greater. A migration whose `when` lands at or below that mark is
 * skipped on that deploy — and on every deploy after it, because the mark only
 * ever moves up. Nothing in drizzle ever asks "which specific migrations are
 * missing?", so the gap is invisible until a query hits the absent object at
 * runtime (production hit exactly this: `relation "location_sync_gym_sources"
 * does not exist`, days after the deploy that skipped `0129_numerous_star_brand`).
 *
 * `packages/db/scripts/migrate.ts` used to verify the wrong thing — it asserted
 * `max(created_at) >= the newest journal entry's when`, which is precisely the
 * one condition a below-the-mark gap cannot violate. This module asks the
 * per-entry question instead.
 *
 * Two properties of the real data shape the API:
 *
 *  - **The key is `hash`, not `created_at`.** The `boardsesh-dev-db` image
 *    bulk-loads its ledger with synthetic timestamps (34 distinct `created_at`
 *    values are duplicated, one of them 13 times), so 180 of 188 journal entries
 *    have no `created_at`-matching row there. Hashes survive the bulk load:
 *    187 of 188 match. Matching on `created_at` would false-positive on
 *    essentially every local and CI database.
 *  - **Missing-only, never extra.** Ledger rows whose hash matches no journal
 *    entry are legitimate renumber residue (two exist on the local dev DB right
 *    now). Failing on those would block deploys for a non-problem.
 *
 * Callers get the hashes from drizzle's own exported `readMigrationFiles`
 * (`drizzle-orm/migrator`) rather than re-deriving sha256, so the hash can't
 * drift from what the migrator actually inserts.
 */

/** One journal entry paired with the hash drizzle would record for its `.sql`. */
export interface ExpectedMigration {
  tag: string;
  hash: string;
}

/**
 * The same entry with the journal's own `when` attached — the value drizzle
 * writes into `created_at` when it applies a migration itself
 * (`PgDialect.migrate()` inserts `migration.folderMillis`, which
 * `readMigrationFiles` copies straight from `journalEntry.when`).
 *
 * Only the timestamp planner below needs it; everything else keys on `hash`.
 */
export interface ExpectedMigrationWithWhen extends ExpectedMigration {
  when: number;
}

/** One row of `drizzle."__drizzle_migrations"`, as the normaliser reads it. */
export interface LedgerTimestampRow {
  id: number;
  hash: string;
  createdAt: number;
}

/** A single `UPDATE … SET created_at = to WHERE id = id`, with the tag for the log line. */
export interface LedgerTimestampRepair {
  id: number;
  tag: string;
  from: number;
  to: number;
}

/**
 * Ledger rows whose `created_at` is not the journal `when` drizzle would have
 * written, paired with the value they should carry.
 *
 * Why any row is ever wrong: the `boardsesh-dev-db` image applies the journal in
 * a psql loop and stamps each ledger row with the image's *build* wall clock
 * instead of the entry's `when`. That makes the ledger's high-water mark a build
 * timestamp, so drizzle's applier skips every journal entry whose `when` predates
 * the image build and which the image did not itself apply — a branch's migration
 * generated before that build — permanently, and `VERIFY_MIGRATION_JOURNAL=1`
 * reports it as a genuine gap. Rewriting `created_at` to `when` writes the value
 * drizzle itself writes, so this is a no-op on any drizzle-managed database and a
 * repair only where something else did the stamping.
 *
 * Pairing is positional within a hash, not a `Map<hash, when>` lookup:
 * byte-identical `.sql` files share a hash (see the `0177_illegal_omega_red`
 * note in `scripts/lib/drizzle-migrations.ts`), and a map would stamp both ledger
 * rows with the first entry's `when`. The k-th ledger row bearing hash H (in `id`
 * order — the order they were inserted) pairs with the k-th journal entry bearing
 * hash H.
 *
 * Ledger rows whose hash matches no journal entry are left alone, the same rule
 * `findUnappliedMigrations` applies in the other direction: those are renumber
 * residue, and inventing a timestamp for them would be a guess.
 */
export function planLedgerTimestampRepairs(
  expected: readonly ExpectedMigrationWithWhen[],
  ledgerRows: readonly LedgerTimestampRow[],
): LedgerTimestampRepair[] {
  const entriesByHash = new Map<string, ExpectedMigrationWithWhen[]>();
  for (const migration of expected) {
    const entries = entriesByHash.get(migration.hash);
    if (entries) {
      entries.push(migration);
    } else {
      entriesByHash.set(migration.hash, [migration]);
    }
  }

  const nextIndexByHash = new Map<string, number>();
  const repairs: LedgerTimestampRepair[] = [];
  for (const row of [...ledgerRows].sort((left, right) => left.id - right.id)) {
    const entries = entriesByHash.get(row.hash);
    if (!entries) continue;
    const nextIndex = nextIndexByHash.get(row.hash) ?? 0;
    const entry = entries[nextIndex];
    if (!entry) continue;
    nextIndexByHash.set(row.hash, nextIndex + 1);
    if (row.createdAt === entry.when) continue;
    repairs.push({ id: row.id, tag: entry.tag, from: row.createdAt, to: entry.when });
  }
  return repairs;
}

/**
 * Journal-order list of tags that have no matching row in the ledger.
 *
 * Multiset-aware on purpose: two byte-identical `.sql` files share a hash, and
 * this repo has carried duplicate-content migrations before (see the
 * `0177_illegal_omega_red` note in `scripts/lib/drizzle-migrations.ts`). Two
 * such entries need two ledger rows, not one — a `Set`-based implementation
 * would silently call the second one applied.
 *
 * Extra ledger hashes with no journal entry are ignored; see the module header.
 */
export function findUnappliedMigrations(
  expected: readonly ExpectedMigration[],
  ledgerHashes: readonly string[],
): string[] {
  const remainingByHash = new Map<string, number>();
  for (const hash of ledgerHashes) {
    remainingByHash.set(hash, (remainingByHash.get(hash) ?? 0) + 1);
  }

  const missingTags: string[] = [];
  for (const migration of expected) {
    const remaining = remainingByHash.get(migration.hash) ?? 0;
    if (remaining > 0) {
      remainingByHash.set(migration.hash, remaining - 1);
    } else {
      missingTags.push(migration.tag);
    }
  }
  return missingTags;
}

export interface MissingMigrationPartition {
  /** Gaps the baseline accounts for, at the exact content it was recorded against. */
  baselined: ExpectedMigration[];
  /** Everything else. Anything here fails the deploy. */
  unbaselined: ExpectedMigration[];
  /**
   * The subset of `unbaselined` whose tag *is* baselined but whose `.sql` no
   * longer hashes to the recorded value — reported separately because the
   * operator's next step is different: look at the edit, not at the ledger.
   */
  editedSinceBaseline: ExpectedMigration[];
}

/**
 * Splits a gap into the part a recorded baseline already accounts for and the
 * part that is new. Only the new part fails a deploy; see
 * `migration-ledger-baseline.ts` for why the baseline exists at all.
 *
 * Matched on tag *and* hash. Tag alone would outlive the file it was recorded
 * against: edit a baselined `.sql` and drizzle expects a new hash, the database
 * still has no matching row, and the old `when` stops it from replaying — so the
 * gate would wave through DDL that never ran, which is the failure it exists to
 * catch. Hash alone would be wrong in the other direction, since byte-identical
 * `.sql` files share a hash and an unrelated new migration could inherit a
 * tolerated one's exemption.
 */
export function partitionMissingMigrations(
  missing: readonly ExpectedMigration[],
  baselinedMigrations: readonly ExpectedMigration[],
): MissingMigrationPartition {
  const recordedHashByTag = new Map(baselinedMigrations.map((migration) => [migration.tag, migration.hash]));
  const partition: MissingMigrationPartition = { baselined: [], unbaselined: [], editedSinceBaseline: [] };
  for (const migration of missing) {
    const recordedHash = recordedHashByTag.get(migration.tag);
    if (recordedHash === migration.hash) {
      partition.baselined.push(migration);
      continue;
    }
    partition.unbaselined.push(migration);
    if (recordedHash !== undefined) {
      partition.editedSinceBaseline.push(migration);
    }
  }
  return partition;
}

/**
 * What the operator does next. Shared so the deploy-gate throw and the
 * `db:verify-journal` CLI (which prints its tag list across lines) cannot drift
 * into telling two different stories about the same condition.
 */
export const MIGRATION_GAP_REMEDIATION =
  "These will never re-apply on their own (most often drizzle's created_at high-water mark skipped them, " +
  "but a database can also carry the schema without the ledger row) — check first whether each migration's " +
  'objects already exist: if they do, insert only the ledger row; if they do not, apply the .sql by hand inside ' +
  'a transaction and insert the row in the same transaction. See docs/db-migrations.md.';

/**
 * Operator-facing message. Names every missing tag — an error that fires but
 * won't say which migration is missing leaves the operator no better off than
 * the runtime crash this check replaces.
 */
export function formatMigrationGapError(
  missingTags: readonly string[],
  expectedCount: number,
  ledgerCount: number,
  editedSinceBaselineTags: readonly string[] = [],
): string {
  const plural = missingTags.length === 1 ? 'migration has' : 'migrations have';
  return (
    `Migration journal verification failed: ${missingTags.length} of ${expectedCount} journal ` +
    `${plural} no row in drizzle.__drizzle_migrations (${ledgerCount} rows present). ` +
    `Missing: ${missingTags.join(', ')}. ` +
    (editedSinceBaselineTags.length > 0 ? `${formatEditedBaselineNote(editedSinceBaselineTags)} ` : '') +
    MIGRATION_GAP_REMEDIATION
  );
}

/**
 * The one gap shape whose next step is not a ledger repair: a baselined `.sql`
 * whose content changed. The recorded exemption no longer applies, and the edit
 * itself is the thing to look at — an applied migration never re-runs, so the new
 * statements are not in any database.
 */
export function formatEditedBaselineNote(editedSinceBaselineTags: readonly string[]): string {
  const plural = editedSinceBaselineTags.length === 1 ? 'is' : 'are';
  return (
    `${editedSinceBaselineTags.join(', ')} ${plural} in the recorded ledger baseline but no longer ` +
    `${editedSinceBaselineTags.length === 1 ? 'hashes' : 'hash'} to the recorded value: the .sql changed after ` +
    'the baseline was taken, so the exemption no longer covers it. Move the new statements into a new migration ' +
    'rather than editing an applied one — an edit never re-runs.'
  );
}

/**
 * Printed on every armed run, not only when something else is wrong. A tolerated
 * gap that stops being mentioned is a gap nobody repairs — and the honest reading
 * of these tags is "production may be missing this DDL", not "resolved".
 */
export function formatBaselinedGapWarning(
  baselinedTags: readonly string[],
  recordedAt: string,
  expectedCount: number,
): string {
  const subject =
    baselinedTags.length === 1 ? 'migration has no ledger row and is' : 'migrations have no ledger row and are';
  return (
    `${baselinedTags.length} of ${expectedCount} journal ${subject} covered by the ` +
    `baseline recorded ${recordedAt} — the deploy is not blocked on it. Repair pending: ` +
    `${baselinedTags.join(', ')}. See docs/db-migrations.md and shrink the list in ` +
    'scripts/lib/migration-ledger-baseline.ts as each one is repaired.'
  );
}
