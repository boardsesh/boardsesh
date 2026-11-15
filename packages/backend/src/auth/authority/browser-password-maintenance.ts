import { and, eq, like, lte, or, sql } from 'drizzle-orm';
import { verificationTokens } from '@boardsesh/db/schema/auth';
import type { AuthorityDatabase } from './adapter';
import { BROWSER_PASSWORD_RECEIPT_PREFIX } from './browser-password-policy';
import { getCredentialDatabase } from '../credential-database';

/** Receipt expiry is the fixed preparedAt+5min ACK deadline. Pending and
 * completed recovery evidence survive until that exact deadline. This prefix
 * cannot consume email/reset/native/ordinary command records. */
export async function deleteExpiredBrowserPasswordReceipts(database: AuthorityDatabase): Promise<number> {
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL statement_timeout='1000ms'`);
    await transaction.execute(sql`SET LOCAL lock_timeout='100ms'`);
    const expiredByDatabase = lte(verificationTokens.expires, sql`clock_timestamp() AT TIME ZONE 'UTC'`);
    const expired = await transaction
      .select({ identifier: verificationTokens.identifier, token: verificationTokens.token })
      .from(verificationTokens)
      .where(and(like(verificationTokens.identifier, `${BROWSER_PASSWORD_RECEIPT_PREFIX}%`), expiredByDatabase))
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
export async function runBrowserPasswordReceiptMaintenance(): Promise<number | null> {
  if (!process.env.AUTH_IDENTITY_DATABASE_URL) return null;
  return deleteExpiredBrowserPasswordReceipts(await getCredentialDatabase('private-web-v1'));
}
