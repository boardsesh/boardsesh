import { and, eq, gt, isNotNull, isNull, lt, notExists, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { mobileRefreshTokens } from '@boardsesh/db/schema/auth';
import type { AuthorityDatabase } from './adapter';

const REVOKED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Pre-lineage rows have no family. Retain conservatively while any child can live. */
export async function cleanupNativeRefreshRows(database: AuthorityDatabase, now = new Date()): Promise<number> {
  const liveDescendant = alias(mobileRefreshTokens, 'live_refresh_descendant');
  const removed = await database
    .delete(mobileRefreshTokens)
    .where(
      and(
        or(
          and(
            isNotNull(mobileRefreshTokens.revokedAt),
            lt(mobileRefreshTokens.revokedAt, new Date(now.getTime() - REVOKED_RETENTION_MS)),
          ),
          lt(mobileRefreshTokens.expiresAt, now),
        ),
        notExists(
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
        ),
      ),
    )
    .returning({ id: mobileRefreshTokens.id });
  return removed.length;
}
