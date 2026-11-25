import { sql } from 'drizzle-orm';
import type { CurrentStoreTransaction } from './foundation-context';

export const PRIVATE_AUTH_COMMAND_MS = 7_000;

export function requirePrivateCommandBudget(deadline: number): number {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) throw new Error('Password authentication unavailable');
  return remaining;
}

/** Remaining wall-clock budget bounds the actual transaction, not only its HTTP reply. */
export async function privateCommandTransactionSettings(transaction: CurrentStoreTransaction, deadline: number) {
  const remaining = Math.min(5_000, requirePrivateCommandBudget(deadline));
  await transaction.execute(
    sql`SELECT set_config('statement_timeout', ${String(remaining)}, true), set_config('lock_timeout', ${String(Math.min(4_000, remaining))}, true), set_config('transaction_timeout', ${String(remaining)}, true)`,
  );
}
