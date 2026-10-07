import { GraphQLError } from 'graphql';
import { and, eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as dbSchema from '@boardsesh/db/schema';

type DrizzleTx = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Hold a spray climb against `deleteClimb` (#5960) for the rest of `tx`, or
 * refuse with `CLIMB_NOT_FOUND` when it is already gone.
 *
 * Every write that leaves a row pointing at a spray climb (a tick, a favourite,
 * a playlist entry, a comment, a vote) calls this inside the transaction that
 * writes the row, before the insert. `FOR KEY SHARE` conflicts with the
 * delete's `FOR UPDATE`:
 *
 *  - the delete holds the row: this waits for it to commit, then finds no row
 *    and throws. `CLIMB_NOT_FOUND` is on the offline drainer's permanent list,
 *    so a queued write dead-letters on its first attempt;
 *  - this holds the row: the delete waits for this transaction to commit, and
 *    its sweep of the reference tables (fresh READ COMMITTED statements) then
 *    sees the new row and removes it, or its tick count refuses the delete.
 *
 * `KEY SHARE` does not conflict with the `NO KEY UPDATE` that climb edits and
 * wall publishes take, so a favourite never queues behind an edit.
 *
 * Spray only. Catalogue climbs are never hard-deleted by a user, and several
 * writers deliberately accept a catalogue uuid the database does not hold yet.
 */
export async function lockSprayClimbAgainstDelete(tx: DrizzleTx, climbUuid: string): Promise<void> {
  const [lockedClimb] = await tx
    .select({ uuid: dbSchema.boardClimbs.uuid })
    .from(dbSchema.boardClimbs)
    .where(and(eq(dbSchema.boardClimbs.uuid, climbUuid), eq(dbSchema.boardClimbs.boardType, 'spray')))
    .limit(1)
    .for('key share');
  if (!lockedClimb) {
    throw new GraphQLError('Climb not found', { extensions: { code: 'CLIMB_NOT_FOUND' } });
  }
}

/**
 * The comment and vote form of the same hold. Those writers validate the climb
 * outside any transaction (`validateEntityExists`), so the climb may have gone
 * since: a missing row refuses here too, whatever the board. A spray climb is
 * then locked as above; a catalogue climb is left unlocked.
 */
export async function lockReferencedClimb(tx: DrizzleTx, climbUuid: string): Promise<void> {
  const [climb] = await tx
    .select({ boardType: dbSchema.boardClimbs.boardType })
    .from(dbSchema.boardClimbs)
    .where(eq(dbSchema.boardClimbs.uuid, climbUuid))
    .limit(1);
  if (!climb) throw new GraphQLError('Climb not found', { extensions: { code: 'CLIMB_NOT_FOUND' } });
  if (climb.boardType === 'spray') await lockSprayClimbAgainstDelete(tx, climbUuid);
}
