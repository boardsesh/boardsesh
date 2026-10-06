import { sql, type SQL } from 'drizzle-orm';

// SPAC, distinct from the SPRY per-wall namespace. Hash collisions merely
// serialize unrelated accounts; they cannot grant access or skip any check.
const SPRAY_ACCOUNT_LOCK_NAMESPACE = 0x53504143;

/** Creator and account deletion take this before reading owned walls. */
export async function lockSprayWallAccount(
  tx: { execute: (query: SQL) => Promise<unknown> },
  userId: string,
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${SPRAY_ACCOUNT_LOCK_NAMESPACE}, hashtext(${userId}))`);
}
