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

/** Env var that controls the journal-vs-ledger check in `packages/db/scripts/migrate.ts`. */
export const VERIFY_MIGRATION_JOURNAL_ENV = 'VERIFY_MIGRATION_JOURNAL';

/** The one value that turns the check off. Anything else — including unset — leaves it on. */
export const VERIFY_MIGRATION_JOURNAL_OFF = '0';

/**
 * Whether `migrate.ts` runs the per-entry check. On by default since #3978.
 *
 * It shipped opt-in (`=1`) for one reason: the `boardsesh-dev-db` image was
 * missing `0187_sad_freak`'s ledger row, so a default-on check would have
 * reddened every developer's `vp run db:migrate` for a defect in the image
 * rather than in their branch. Since #4474 the image applies every migration
 * with its ledger row, and its build fails unless the ledger row count equals
 * the journal entry count. `vp run db:up` applies only a verified contiguous
 * suffix before `db:migrate` runs, and stops on any gap with no SQL run (#3979).
 * So the condition that justified the opt-in is gone. Leaving it opt-in means
 * the check is off in exactly the place a gap is created: a developer's machine,
 * on the branch that creates it.
 *
 * `0` remains an escape hatch for the one shape this cannot help — a database
 * with a gap nobody can repair right now, where the operator needs `db:migrate`
 * to run anyway. The three workflows that already pass the literal `1`
 * (`ci.yml`, `production-deploy.yml`, `db-migration-renumber.yml`) keep working
 * unchanged.
 *
 * Lives here, in a dependency-free module, so the decision has unit coverage in
 * the `scripts` Vitest project — `packages/db` runs on `tsx --test` and is not
 * part of the CI test graph.
 */
export function isMigrationJournalGateArmed(env: Record<string, string | undefined>): boolean {
  return env[VERIFY_MIGRATION_JOURNAL_ENV] !== VERIFY_MIGRATION_JOURNAL_OFF;
}

/** One journal entry paired with the hash drizzle would record for its `.sql`. */
export interface ExpectedMigration {
  tag: string;
  hash: string;
}

/**
 * An `ExpectedMigration` plus the journal's `when`, which drizzle stamps into
 * `created_at`. The dev-db applier needs it to write the row drizzle would have
 * written; selection still keys on `hash`.
 */
export interface ExpectedMigrationWithWhen extends ExpectedMigration {
  when: number;
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
