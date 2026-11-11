import { executeFirstRow, type DbInstance } from '@boardsesh/db/client';
import { users } from '@boardsesh/db/schema/auth';
import { sql } from 'drizzle-orm';
import type { CurrentStoreTransaction } from './foundation-context';

/**
 * Links sent before the switch are keyed by address, not account: the old web
 * routes stored `password-reset:<address>` or the bare address with the secret.
 * One such link can be bound to an account only when the address names exactly
 * one, so binding waits for BA-02 (#4847) to make Postgres enforce that.
 */

/**
 * True once Postgres keeps one account per address: a valid unique index on
 * exactly `lower(email)` of `users`, with no predicate. BA-02 adds it. Until
 * then every pre-switch link stays `legacy_unbound`, as before this check.
 */
export async function isEmailUniquenessEnforced(executor: DbInstance | CurrentStoreTransaction): Promise<boolean> {
  // Catalog read: Drizzle has no query builder for pg_index.
  const row = await executeFirstRow<{ enforced: boolean }>(
    executor,
    sql`SELECT EXISTS (
      SELECT 1
      FROM pg_index AS email_index
      WHERE email_index.indrelid = to_regclass('public.users')
        AND email_index.indisunique
        AND email_index.indisvalid
        AND email_index.indisready
        AND email_index.indislive
        AND email_index.indpred IS NULL
        AND email_index.indnkeyatts = 1
        AND pg_get_expr(email_index.indexprs, email_index.indrelid) = 'lower(email)'
    ) AS enforced`,
  );
  return row?.enforced === true;
}

/** Every account whose stored address lowercases to `key`, at most two. */
export async function accountsHoldingAddress(
  executor: DbInstance | CurrentStoreTransaction,
  key: string,
): Promise<{ id: string }[]> {
  return executor
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${key}`)
    .limit(2);
}

/**
 * A legacy link was issued exactly one lifetime before its deadline. It dies on
 * any later recorded security mutation (a staged reset, change, set or deletion;
 * the legacy set-password route records none), as a UID-bound receipt
 * does when the subject generation moves.
 */
export function issuedBeforeRevocation(
  deadline: Date,
  lifetimeMs: number,
  cutoff: { readonly revokedThrough: Date } | undefined,
): boolean {
  return cutoff !== undefined && deadline.getTime() - lifetimeMs < cutoff.revokedThrough.getTime();
}
