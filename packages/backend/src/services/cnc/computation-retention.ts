import { and, asc, inArray, lt } from 'drizzle-orm';
import type { DbInstance } from '@boardsesh/db/client';
import { cncComputations } from '@boardsesh/db/schema';

/** Expired computations are ephemeral; purchased artifacts never depend on them. */
export async function clearExpiredCncComputations(database: DbInstance): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const expired = await database
    .select({ id: cncComputations.id })
    .from(cncComputations)
    .where(lt(cncComputations.expiresAt, cutoff))
    .orderBy(asc(cncComputations.expiresAt))
    .limit(100);
  if (expired.length === 0) return 0;
  const removed = await database
    .delete(cncComputations)
    .where(
      and(
        inArray(
          cncComputations.id,
          expired.map((request) => request.id),
        ),
        lt(cncComputations.expiresAt, cutoff),
      ),
    )
    .returning({ id: cncComputations.id });
  return removed.length;
}
