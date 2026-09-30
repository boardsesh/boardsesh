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
// connection for its entire lifetime (`postgres(databaseUrl, { max: 1,
// max_lifetime: null })` in import-moonboard-catalog.ts) and pins it for both
// this lock and every per-board transaction. A transaction-pooling proxy
// (PgBouncer in transaction mode, a pooled Neon/RDS-Proxy endpoint, etc.)
// hands a DIFFERENT backend connection to each statement/transaction, so a
// session lock taken through one would sit on a connection none of the
// importer's own writes ever use — it would protect nothing, and the eventual
// unlock could land on a connection that never held it in the first place.
// Always point this script at a direct (non-pooled) connection string.
//
// `max_lifetime: null` matters just as much as `max: 1`: postgres.js's
// default max_lifetime (a random 30-60 minutes) transparently swaps the
// underlying connection out from under a long-running import, which silently
// drops this lock the moment it happens (see assertCatalogImportLockHeld
// below). A scheduler's retry-on-failure loop is only safe from overlapping
// runs once BOTH `max_lifetime: null` is set AND every board transaction
// re-checks the lock with assertCatalogImportLockHeld — the acquire-once-at-
// startup lock alone is not enough for a run long enough to hit the default
// max_lifetime.
// =============================================================================

export const MOONBOARD_CATALOG_IMPORT_LOCK_NAME = 'boardsesh:moonboard-catalog-import';

/**
 * FNV-1a, 64-bit, hashed over the input's UTF-8 bytes. A small, well-known,
 * dependency-free hash, chosen so the key below can be recomputed by hand
 * from the name above — useful when a `pg_locks` row shows the key and
 * someone needs to confirm what it is.
 *
 * Hashes bytes, not JS's UTF-16 code units: the textbook FNV-1a definition is
 * over an octet sequence, and `MOONBOARD_CATALOG_IMPORT_LOCK_NAME` is pure
 * ASCII so the two happen to agree for it today, but hashing code units
 * directly would silently diverge from the standard algorithm — and from
 * every other language's FNV-1a implementation — the moment the name (or a
 * future caller's input) contains anything outside ASCII, breaking the
 * "recompute by hand" promise above.
 * https://en.wikipedia.org/wiki/Fowler%E2%80%93Noll%E2%80%93Vo_hash_function
 */
export function fnv1a64(input: string): bigint {
  const OFFSET_BASIS = 0xcbf29ce484222325n;
  const PRIME = 0x100000001b3n;
  const MASK_64_BITS = (1n << 64n) - 1n;
  let hash = OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(input)) {
    hash = (hash ^ BigInt(byte)) & MASK_64_BITS;
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

// Every query below interpolates this bigint straight into a Drizzle `sql`
// tag. postgres.js serialises a JS `bigint` parameter as OID 20 (int8)
// natively (see its src/types.js), so this needs no cast or string
// conversion on our side — but that's a claim about the real driver talking
// to a real server, which the hermetic unit tests in
// moonboard-catalog-run-lock.test.ts (a recording DB double) cannot exercise.
// moonboard-catalog-run-lock.integration.test.ts, which runs against the CI
// job's real Postgres, is what actually proves it.

/**
 * The minimal database surface the lock needs — deliberately shaped like
 * `GymActivityStatsDb` in queries/gyms/activity-stats.ts, so a real Drizzle
 * handle and a test double are both structurally assignable.
 */
export type CatalogRunLockDb = {
  execute(query: SQLWrapper | string): PromiseLike<unknown>;
};

export type CatalogLockAcquireResult = { acquired: true; backendPid: number } | { acquired: false };

/**
 * Takes the session-scoped advisory lock, non-blocking. Returns
 * `{ acquired: false }` when another run already holds it — the caller must
 * exit without starting any board transaction, since the lock is what makes
 * skipping that safe.
 *
 * On success also returns `pg_backend_pid()` for the connection that just
 * took the lock. The caller must hold onto it and pass it to
 * `assertCatalogImportLockHeld` before every board transaction — see that
 * function for why.
 */
export async function acquireCatalogImportLock(db: CatalogRunLockDb): Promise<CatalogLockAcquireResult> {
  const row = await executeFirstRow<{ locked: boolean; backend_pid: number }>(
    db,
    sql`SELECT pg_try_advisory_lock(${MOONBOARD_CATALOG_IMPORT_LOCK_KEY}) AS locked, pg_backend_pid() AS backend_pid`,
  );
  if (row?.locked !== true) return { acquired: false };
  return { acquired: true, backendPid: row.backend_pid };
}

export type CatalogLockCheckResult = { ok: true } | { ok: false; reason: string };

/**
 * Re-verifies, immediately before every board transaction, that the lock
 * taken at startup (see acquireCatalogImportLock) is still actually held by
 * this connection.
 *
 * postgres.js defaults `max_lifetime` to a random 30-60 minutes and
 * transparently closes and reopens the underlying socket once a connection
 * has lived that long, even mid-run. Postgres releases every session-scoped
 * advisory lock the instant that backend disconnects, and the reconnect hands
 * back a BRAND NEW backend that never took the lock — the importer would then
 * keep writing board after board with no mutual exclusion at all, and nothing
 * would tell it. The importer passes `max_lifetime: null` to disable this
 * outright, but this check is a second line of defence: against
 * `max_lifetime` being reintroduced by mistake, an idle/network-triggered
 * disconnect, or anything else that could swap the backend out from under a
 * long-running import without an exception being thrown at the time.
 *
 * Checks two independent things, because either alone can be fooled:
 *  - `pg_backend_pid()` is unchanged: this is still the exact server process
 *    that took the lock. A reconnect always gets a new pid.
 *  - `pg_locks` still lists our key, granted, for that pid: guards against
 *    the pid coincidentally repeating (recycled by the OS after this process
 *    happened to reconnect twice) or the lock having been released some other
 *    way without a reconnect.
 *
 * A single-bigint `pg_advisory_lock` key is split by Postgres into two int4
 * halves stored as `pg_locks.classid`/`objid` (high/low 32 bits), with
 * `objsubid = 1` marking it as the one-bigint-argument form (as opposed to
 * `objsubid = 2` for the two-int4-argument form) — see `SetLocktagInt8` in
 * Postgres's lockfuncs.c. The query below reproduces that split from the same
 * key constant so it never has to be kept in sync by hand.
 */
export async function assertCatalogImportLockHeld(
  db: CatalogRunLockDb,
  expectedBackendPid: number,
): Promise<CatalogLockCheckResult> {
  const row = await executeFirstRow<{ backend_pid: number; held: boolean }>(
    db,
    sql`
      SELECT
        pg_backend_pid() AS backend_pid,
        EXISTS (
          SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory'
            AND pid = pg_backend_pid()
            AND granted
            AND objsubid = 1
            AND classid = ((${MOONBOARD_CATALOG_IMPORT_LOCK_KEY}::bigint >> 32) & 4294967295)::oid
            AND objid = (${MOONBOARD_CATALOG_IMPORT_LOCK_KEY}::bigint & 4294967295)::oid
        ) AS held
    `,
  );
  if (row === undefined) {
    return { ok: false, reason: 'could not verify the run lock — the check query returned no row' };
  }
  if (row.backend_pid !== expectedBackendPid) {
    return {
      ok: false,
      reason:
        `the database connection was silently replaced mid-run (backend pid ${expectedBackendPid} -> ` +
        `${row.backend_pid}); the run lock this process took no longer protects anything`,
    };
  }
  if (!row.held) {
    return { ok: false, reason: `the run lock is no longer held by backend pid ${row.backend_pid}` };
  }
  return { ok: true };
}

/**
 * Releases the lock this same connection took. Safe to call even when the
 * lock was never acquired — `pg_advisory_unlock` on a key this session does
 * not hold just returns false and makes Postgres log a WARNING notice; it
 * does not raise an error.
 */
export async function releaseCatalogImportLock(db: CatalogRunLockDb): Promise<void> {
  await executeFirstRow<{ unlocked: boolean }>(
    db,
    sql`SELECT pg_advisory_unlock(${MOONBOARD_CATALOG_IMPORT_LOCK_KEY}) AS unlocked`,
  );
}
