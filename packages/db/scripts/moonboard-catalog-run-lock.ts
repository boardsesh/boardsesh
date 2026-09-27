import { sql, type SQLWrapper } from 'drizzle-orm';
import { executeFirstRow } from '../src/client/postgres.js';

// =============================================================================
// Run lock for the MoonBoard catalog importer
// =============================================================================
// import-moonboard-catalog.ts runs ONE Postgres transaction per board file, so
// mutual exclusion across a whole run needs a lock that outlives any single
// transaction — a SESSION-scoped advisory lock, taken once before the first
// board and released once after the last one, not a transaction-scoped lock
// that would release itself the moment the first board's transaction commits
// (leaving every later board unprotected).
//
// That only works because the importer opens exactly one direct Postgres
// connection for its entire lifetime (`postgres(databaseUrl, { max: 1 })` in
// import-moonboard-catalog.ts) and pins it for both this lock and every
// per-board transaction. A transaction-pooling proxy (PgBouncer in
// transaction mode, a pooled Neon/RDS-Proxy endpoint, etc.) hands a
// DIFFERENT backend connection to each statement/transaction, so a session
// lock taken through one would sit on a connection none of the importer's
// own writes ever use — it would protect nothing, and the eventual unlock
// could land on a connection that never held it in the first place. Always
// point this script at a direct (non-pooled) connection string.
// =============================================================================

export const MOONBOARD_CATALOG_IMPORT_LOCK_NAME = 'boardsesh:moonboard-catalog-import';

/**
 * FNV-1a, 64-bit. A small, well-known, dependency-free hash, chosen so the key
 * below can be recomputed by hand from the name above — useful when a
 * `pg_locks` row shows the key and someone needs to confirm what it is.
 * https://en.wikipedia.org/wiki/Fowler%E2%80%93Noll%E2%80%93Vo_hash_function
 */
export function fnv1a64(input: string): bigint {
  const OFFSET_BASIS = 0xcbf29ce484222325n;
  const PRIME = 0x100000001b3n;
  const MASK_64_BITS = (1n << 64n) - 1n;
  let hash = OFFSET_BASIS;
  for (let index = 0; index < input.length; index++) {
    hash = (hash ^ BigInt(input.charCodeAt(index))) & MASK_64_BITS;
    hash = (hash * PRIME) & MASK_64_BITS;
  }
  return hash;
}

// pg_try_advisory_lock takes a signed bigint. Masking off the top bit keeps
// the hash inside the positive int64 range without two's-complement
// arithmetic, at the cost of one bit of entropy this use has no need for.
const MASK_63_BITS = (1n << 63n) - 1n;

/** The advisory-lock key, derived once from MOONBOARD_CATALOG_IMPORT_LOCK_NAME above. */
export const MOONBOARD_CATALOG_IMPORT_LOCK_KEY: bigint = fnv1a64(MOONBOARD_CATALOG_IMPORT_LOCK_NAME) & MASK_63_BITS;

/**
 * The minimal database surface the lock needs — deliberately shaped like
 * `GymActivityStatsDb` in queries/gyms/activity-stats.ts, so a real Drizzle
 * handle and a test double are both structurally assignable.
 */
export type CatalogRunLockDb = {
  execute(query: SQLWrapper | string): PromiseLike<unknown>;
};

/**
 * Takes the session-scoped advisory lock, non-blocking. Returns false when
 * another run already holds it — the caller must exit without starting any
 * board transaction, since the lock is what makes skipping that safe.
 */
export async function acquireCatalogImportLock(db: CatalogRunLockDb): Promise<boolean> {
  const row = await executeFirstRow<{ locked: boolean }>(
    db,
    sql`SELECT pg_try_advisory_lock(${MOONBOARD_CATALOG_IMPORT_LOCK_KEY}) AS locked`,
  );
  return row?.locked === true;
}

/**
 * Releases the lock this same connection took. Safe to call even when the
 * lock was never acquired — `pg_advisory_unlock` on a key this session does
 * not hold just returns false, it does not error.
 */
export async function releaseCatalogImportLock(db: CatalogRunLockDb): Promise<void> {
  await executeFirstRow<{ unlocked: boolean }>(
    db,
    sql`SELECT pg_advisory_unlock(${MOONBOARD_CATALOG_IMPORT_LOCK_KEY}) AS unlocked`,
  );
}
