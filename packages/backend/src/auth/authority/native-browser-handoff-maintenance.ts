import { and, eq, like, lte, or, sql } from 'drizzle-orm';
import { verificationTokens } from '@boardsesh/db/schema/auth';
import type { AuthorityDatabase } from './adapter';
import { NATIVE_BROWSER_HANDOFF_RECEIPT_PREFIX } from './native-browser-handoff';
import { getCredentialDatabase } from '../credential-database';

export const NATIVE_BROWSER_HANDOFF_CLEANUP_BATCH_SIZE = 1000;

/** Mode independent and clocked by the same primary as redemption. The stored
 * legacy column is timestamp WITHOUT timezone; its UTC values must not be
 * reinterpreted in a connection's local timezone. Host clock changes cannot
 * remove a receipt while its signed capability is redeemable. */
export async function deleteExpiredNativeBrowserHandoffClaims(database: AuthorityDatabase): Promise<number> {
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL statement_timeout='1000ms'`);
    await transaction.execute(sql`SET LOCAL lock_timeout='100ms'`);
    const expiredByDatabase = lte(verificationTokens.expires, sql`clock_timestamp() AT TIME ZONE 'UTC'`);
    const expired = await transaction
      .select({ identifier: verificationTokens.identifier, token: verificationTokens.token })
      .from(verificationTokens)
      .where(and(like(verificationTokens.identifier, `${NATIVE_BROWSER_HANDOFF_RECEIPT_PREFIX}%`), expiredByDatabase))
      .orderBy(verificationTokens.expires, verificationTokens.identifier, verificationTokens.token)
      .limit(NATIVE_BROWSER_HANDOFF_CLEANUP_BATCH_SIZE)
      .for('update', { skipLocked: true });
    if (expired.length === 0) return 0;
    const removed = await transaction
      .delete(verificationTokens)
      .where(
        and(
          expiredByDatabase,
          or(
            ...expired.map((claim) =>
              and(eq(verificationTokens.identifier, claim.identifier), eq(verificationTokens.token, claim.token)),
            ),
          ),
        ),
      )
      .returning({ token: verificationTokens.token });
    return removed.length;
  });
}

/** Browser rollout mode may be off while spent receipts remain. Reuse only the
 * qualified credential connection; its compatible profiles already own this
 * receipt relation. An absent configured principal has never issued these
 * capabilities. A configured but unqualified connection remains an outage. */
export async function runNativeBrowserHandoffMaintenance(): Promise<number | null> {
  if (!process.env.AUTH_IDENTITY_DATABASE_URL) return null;
  return deleteExpiredNativeBrowserHandoffClaims(await getCredentialDatabase('private-web-v1'));
}
