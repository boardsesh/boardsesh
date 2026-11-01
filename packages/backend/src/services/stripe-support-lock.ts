import { eq } from 'drizzle-orm';
import { users } from '@boardsesh/db/schema';
import type { Database } from '../db/client';

export type SupportTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Serialize linked Checkout creation, acceptance and account deletion. */
export async function lockSupportAccount(transaction: SupportTransaction, userId: string) {
  const [account] = await transaction
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
  return account;
}
