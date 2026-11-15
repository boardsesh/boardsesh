import { and, eq, like, lte, or, sql } from 'drizzle-orm';
import { verificationTokens } from '@boardsesh/db/schema/auth';
import type { AuthorityDatabase } from './adapter';
import { EXPIRED_BROWSER_BINDING_RECEIPT_PREFIX } from './expired-browser-binding';
import { getCredentialDatabase } from '../credential-database';

/** An expired receipt can no longer finalize or acknowledge. This independent
 * prefix never consumes email/reset/native/ordinary command records. */
export async function deleteExpiredBrowserBindingRetirementReceipts(database: AuthorityDatabase): Promise<number> {
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL statement_timeout='1000ms'`);
    await transaction.execute(sql`SET LOCAL lock_timeout='100ms'`);
    const expiredByDatabase = lte(verificationTokens.expires, sql`clock_timestamp() AT TIME ZONE 'UTC'`);
    const expired = await transaction
      .select({ identifier: verificationTokens.identifier, token: verificationTokens.token })
      .from(verificationTokens)
      .where(and(like(verificationTokens.identifier, `${EXPIRED_BROWSER_BINDING_RECEIPT_PREFIX}%`), expiredByDatabase))
      .orderBy(verificationTokens.expires, verificationTokens.identifier, verificationTokens.token)
      .limit(1_000)
      .for('update', { skipLocked: true });
    if (expired.length === 0) return 0;
    const removed = await transaction
      .delete(verificationTokens)
      .where(
        and(
          expiredByDatabase,
          or(
            ...expired.map((receipt) =>
              and(eq(verificationTokens.identifier, receipt.identifier), eq(verificationTokens.token, receipt.token)),
            ),
          ),
        ),
      )
      .returning({ token: verificationTokens.token });
    return removed.length;
  });
}

/** Drain even while issuance mode is legacy. Use the same qualified credential
 * pool; absent identity configuration has never produced these private rows. */
export async function runExpiredBrowserBindingRetirementMaintenance(): Promise<number | null> {
  if (!process.env.AUTH_IDENTITY_DATABASE_URL) return null;
  return deleteExpiredBrowserBindingRetirementReceipts(await getCredentialDatabase('private-web-v1'));
}
