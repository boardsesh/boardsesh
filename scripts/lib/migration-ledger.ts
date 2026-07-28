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

/**
 * Operator-facing message. Names every missing tag — an error that fires but
 * won't say which migration is missing leaves the operator no better off than
 * the runtime crash this check replaces.
 */
export function formatMigrationGapError(
  missingTags: readonly string[],
  expectedCount: number,
  ledgerCount: number,
): string {
  const plural = missingTags.length === 1 ? 'migration has' : 'migrations have';
  return (
    `Migration journal verification failed: ${missingTags.length} of ${expectedCount} journal ` +
    `${plural} no row in drizzle.__drizzle_migrations (${ledgerCount} rows present). ` +
    `Missing: ${missingTags.join(', ')}. ` +
    `These were skipped by drizzle's created_at high-water mark and will never re-apply on their own — ` +
    `apply each .sql by hand inside a transaction and insert its ledger row with the journal's "when" as created_at. ` +
    `See docs/db-migrations.md.`
  );
}
