import { and, eq, gt, isNotNull, isNull, lt, notExists, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { mobileRefreshTokens, users } from '@boardsesh/db/schema/auth';
import type { AuthorityDatabase } from './adapter';
import { requireReadCommitted } from '../current-store/foundation-context';
import { transactionSettings } from '../current-store/command-context';

const REVOKED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Pre-lineage rows have no family. Retain conservatively while any child can live. */
export async function cleanupNativeRefreshRows(
  database: AuthorityDatabase,
  requestedNow = new Date(),
): Promise<number> {
  const now = new Date(requestedNow.getTime());
  const liveDescendant = alias(mobileRefreshTokens, 'live_refresh_descendant');
  const expired = or(
    and(
      isNotNull(mobileRefreshTokens.revokedAt),
      lt(mobileRefreshTokens.revokedAt, new Date(now.getTime() - REVOKED_RETENTION_MS)),
    ),
    lt(mobileRefreshTokens.expiresAt, now),
  );
  const noLiveDescendant = notExists(
    database
      .select({ id: liveDescendant.id })
      .from(liveDescendant)
      .where(
        and(
          eq(liveDescendant.userId, mobileRefreshTokens.userId),
          isNull(liveDescendant.revokedAt),
          gt(liveDescendant.expiresAt, now),
        ),
      ),
  );
  const candidates = await database
    .selectDistinct({ userId: mobileRefreshTokens.userId })
    .from(mobileRefreshTokens)
    .where(and(expired, noLiveDescendant));
  let removedCount = 0;
  for (const { userId } of candidates) {
    removedCount += await database.transaction(async (transaction) => {
      await transactionSettings(transaction);
      await requireReadCommitted(transaction);
      await transaction.execute(sql`SELECT pg_advisory_xact_lock_shared(6975, 2)`);
      // Issuance holds KEY SHARE on this user before consuming the parent.
      // Wait here, before taking any refresh-row lock, then use a NEW statement
      // snapshot so a child committed during that wait remains visible.
      const [subject] = await transaction
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .for('update');
      if (!subject) return 0;
      const removed = await transaction
        .delete(mobileRefreshTokens)
        .where(and(eq(mobileRefreshTokens.userId, userId), expired, noLiveDescendant))
        .returning({ id: mobileRefreshTokens.id });
      return removed.length;
    });
  }
  return removedCount;
}
