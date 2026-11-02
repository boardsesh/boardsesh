import { and, eq, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { boardClimbs, climbMutationReceipts } from '@boardsesh/db/schema';
import { sprayClimbVisibilityCondition } from '@boardsesh/db/queries';
import type { UpdateClimbResult } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type ClimbUpdateDatabase = typeof db | Transaction;

/** Serialize one operation before any mutable eligibility checks, and commit
 * its receipt atomically with the edit. A replay never writes climb content. */
export async function withClimbUpdateReceipt(
  identity: {
    clientMutationId: string;
    uuid: string;
    boardType: string;
    userId: string;
    sprayWallUuid?: string | null;
  },
  update: (transaction: Transaction) => Promise<UpdateClimbResult>,
): Promise<UpdateClimbResult> {
  return db.transaction(async (transaction) => {
    const operationKey = `update:${identity.clientMutationId}`;
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${operationKey}, 0))`);
    const [receipt] = await transaction
      .select()
      .from(climbMutationReceipts)
      .where(eq(climbMutationReceipts.operationKey, operationKey));
    if (receipt) {
      if (
        receipt.userId !== identity.userId ||
        receipt.climbUuid !== identity.uuid ||
        receipt.boardType !== identity.boardType ||
        !receipt.result
      ) {
        throw new GraphQLError('Climb operation identity is unavailable', {
          extensions: { code: 'CLIMB_ID_CONFLICT' },
        });
      }
      // A receipt is acknowledgment, never permission: check current ownership
      // and wall access, but not the edit window or an archived wall's write gate.
      const [climb] = await transaction
        .select({ uuid: boardClimbs.uuid })
        .from(boardClimbs)
        .where(
          and(
            eq(boardClimbs.uuid, identity.uuid),
            eq(boardClimbs.boardType, identity.boardType),
            eq(boardClimbs.userId, identity.userId),
            sprayClimbVisibilityCondition(boardClimbs, identity.userId, identity.sprayWallUuid),
          ),
        );
      if (!climb) throw new GraphQLError('Climb not found', { extensions: { code: 'CLIMB_NOT_FOUND' } });
      return receipt.result;
    }
    const result = await update(transaction);
    await transaction.insert(climbMutationReceipts).values({
      operationKey,
      climbUuid: identity.uuid,
      boardType: identity.boardType,
      userId: identity.userId,
      result,
    });
    return result;
  });
}
