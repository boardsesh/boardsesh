import { and, eq, exists, inArray, ne, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { SYSTEM_BOARD_OWNER_ID } from '../board-presence/shared';

// ============================================
// Who runs a gym, for a list of gyms in one query
// ============================================
//
// A leaf module on purpose: gyms.ts, gym-matching.ts and the directory reports
// all need it, and gyms.ts already imports gym-matching.ts, so it can't live in
// either of those without an import cycle.

/**
 * Correlated twin of `ownerHoldsClaimOrHandoverSql` in gyms.ts, for a query
 * over `gyms`: the gym's current owner holds an approved claim on it, or
 * received it in an admin handover. Change both together.
 */
export function ownerHoldsClaimOrHandoverColumn() {
  return sql<boolean>`(${exists(
    db
      .select({ one: sql`1` })
      .from(dbSchema.gymClaims)
      .where(
        and(
          eq(dbSchema.gymClaims.gymId, dbSchema.gyms.id),
          eq(dbSchema.gymClaims.claimantUserId, dbSchema.gyms.ownerId),
          eq(dbSchema.gymClaims.status, 'approved'),
        ),
      ),
  )} OR ${exists(
    db
      .select({ one: sql`1` })
      .from(dbSchema.gymOwnerReassignments)
      .where(
        and(
          eq(dbSchema.gymOwnerReassignments.gymUuid, dbSchema.gyms.uuid),
          eq(dbSchema.gymOwnerReassignments.newOwnerId, dbSchema.gyms.ownerId),
        ),
      ),
  )})`;
}

/**
 * The gyms among these whose staff run them (`listingState` RUN_BY_GYM): a real
 * owner who holds an approved claim or got the gym from our team. Nobody can
 * claim one (docs/product/gym-board-governance.md, PR 7).
 */
export async function gymIdsRunByStaff(gymIds: readonly number[]): Promise<Set<number>> {
  const ids = [...new Set(gymIds)];
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: dbSchema.gyms.id })
    .from(dbSchema.gyms)
    .where(
      and(
        inArray(dbSchema.gyms.id, ids),
        ne(dbSchema.gyms.ownerId, SYSTEM_BOARD_OWNER_ID),
        ownerHoldsClaimOrHandoverColumn(),
      ),
    );
  return new Set(rows.map((row) => row.id));
}
