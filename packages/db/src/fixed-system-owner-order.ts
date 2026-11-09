import { sql } from 'drizzle-orm';
import type { DbInstance } from './client';

export type FixedSystemOwnerOrderMode = 'legacy' | 'cooperative-staging';
export type FixedSystemOwnerTransaction = Parameters<Parameters<DbInstance['transaction']>[0]>[0];

/** A database-local key shared by the three fixed system identities and adopted content writers. */
export const FIXED_SYSTEM_OWNER_LOCK_NAMESPACE = 0x42534155;
export const FIXED_SYSTEM_OWNER_LOCK_KEY = 1;

export class FixedSystemOwnerOrderError extends Error {
  constructor(readonly code: 'busy' | 'invalid_mode' | 'invalid_transaction' | 'invalid_result') {
    super('Fixed system-owner coordination is temporarily unavailable.');
    this.name = 'FixedSystemOwnerOrderError';
  }
}

/** Capture once at the outer operation entry, before its first asynchronous work or commit. */
export function captureFixedSystemOwnerOrderMode(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): FixedSystemOwnerOrderMode {
  const mode = environment.CURRENT_STORE_FIXED_SYSTEM_OWNER_ORDER_MODE;
  if (mode === undefined || mode === '' || mode === 'legacy') return 'legacy';
  if (mode === 'cooperative-staging') return mode;
  throw new FixedSystemOwnerOrderError('invalid_mode');
}

/**
 * Borrow an existing outer transaction. Identity authorities enter after the
 * manifest and any existing job-attempt fence; content writers enter before
 * content locks. This helper owns no client, transaction, commit or retry.
 *
 * Acquisition never queues: contention rejects this transaction. Acquire at
 * outer entry, before later savepoints, so their rollback cannot release the
 * prefix. Calling this only inside a savepoint does not establish that order.
 * Long transaction hold times and unadopted producers remain activation gates.
 *
 * Exclusive is for the fixed identity authorities. Content writers and account
 * deletion only need to exclude those authorities, not each other, so they take
 * the shared form below.
 */
export async function lockFixedSystemOwnerTransaction(transaction: FixedSystemOwnerTransaction): Promise<void> {
  await acquireFixedSystemOwnerKey(transaction, 'exclusive');
}

/** Excludes the fixed identity authorities without excluding other shared holders. */
export async function lockSharedFixedSystemOwnerTransaction(transaction: FixedSystemOwnerTransaction): Promise<void> {
  await acquireFixedSystemOwnerKey(transaction, 'shared');
}

async function acquireFixedSystemOwnerKey(
  transaction: FixedSystemOwnerTransaction,
  strength: 'exclusive' | 'shared',
): Promise<void> {
  // Catch accidental pool/root-database calls. This is not proof that the caller
  // entered before all of its other locks; actual outer callers must enforce it.
  if (
    typeof transaction !== 'object' ||
    transaction === null ||
    typeof transaction.rollback !== 'function' ||
    typeof transaction.execute !== 'function'
  ) {
    throw new FixedSystemOwnerOrderError('invalid_transaction');
  }
  const rows: unknown = await transaction.execute(
    strength === 'exclusive'
      ? sql`SELECT pg_catalog.pg_try_advisory_xact_lock(${FIXED_SYSTEM_OWNER_LOCK_NAMESPACE}, ${FIXED_SYSTEM_OWNER_LOCK_KEY}) AS acquired`
      : sql`SELECT pg_catalog.pg_try_advisory_xact_lock_shared(${FIXED_SYSTEM_OWNER_LOCK_NAMESPACE}, ${FIXED_SYSTEM_OWNER_LOCK_KEY}) AS acquired`,
  );
  if (!Array.isArray(rows) || rows.length !== 1) throw new FixedSystemOwnerOrderError('invalid_result');
  const observed: unknown = rows[0];
  if (
    typeof observed !== 'object' ||
    observed === null ||
    !Object.hasOwn(observed, 'acquired') ||
    !('acquired' in observed) ||
    typeof observed.acquired !== 'boolean'
  ) {
    throw new FixedSystemOwnerOrderError('invalid_result');
  }
  if (!observed.acquired) throw new FixedSystemOwnerOrderError('busy');
}

/** Default-off content adoption; shared, so adopted writers never exclude each other. */
export async function lockCooperativeFixedSystemOwnerTransaction(
  transaction: FixedSystemOwnerTransaction,
  mode: FixedSystemOwnerOrderMode,
): Promise<void> {
  if (mode === 'legacy') return;
  if (mode !== 'cooperative-staging') throw new FixedSystemOwnerOrderError('invalid_mode');
  await lockSharedFixedSystemOwnerTransaction(transaction);
}
