import { and, eq, exists, or, sql } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import type { Database } from '../../../db/client';
import { GraphQLError } from 'graphql';
import { getPostgresErrorCode } from '../../../utils/postgres-errors';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Only a rolled-back deadlock is safe to retry; media effects run after commit. */
export async function retryAccountDeletion<Result>(transaction: () => Promise<Result>): Promise<Result> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await transaction();
    } catch (error) {
      if (getPostgresErrorCode(error) !== '40P01') throw error;
      if (attempt >= 2) {
        throw new GraphQLError('Your account is busy. Please try deleting it again.', {
          extensions: { code: 'ACCOUNT_DELETE_RETRY_REQUIRED' },
        });
      }
    }
  }
}

/** Preserve restrictions before author FKs are cleared by account deletion. */
export async function withdrawDeletedAccountContent(tx: Transaction, userId: string): Promise<void> {
  // Called after spray/account locks. This is the same user lock acquired by
  // account audience changes and explicit publication writes.
  await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId)).for('update');
  // A deleted author's published climbs stay public with no author: a
  // published climb is public whoever set it, so no climb policy is written.
  // Their drafts are deleted with the account (`deleteAccount`); an unlisted
  // climb loses its owner, drops out of every list and still opens by its link.
  //
  // Once the author reference is cleared the climb looks like manufacturer
  // catalogue data, whose stored first-ascent credit is trusted as is. The
  // marker keeps that credit recomputed from ticks the viewer may read
  // (`privateSafeFirstAscentName`), and keeps the climb out of the snapshot
  // artifacts.
  await tx.update(schema.boardClimbs).set({ isBoardseshAuthored: true }).where(eq(schema.boardClimbs.userId, userId));

  // Personal media URLs remain identifying after creator/tick FKs become NULL.
  // Withdraw them even when currently public; imported vendor beta is untouched.
  await tx
    .insert(schema.contentPrivacy)
    .select(
      tx
        .select({
          entityType: sql<'beta'>`'beta'`.as('entity_type'),
          entityId:
            sql<string>`${schema.boardBetaLinks.boardType} || ':' || ${schema.boardBetaLinks.climbUuid} || ':' || ${schema.boardBetaLinks.link}`.as(
              'entity_id',
            ),
          ownerId: sql<string>`${userId}`.as('owner_id'),
          audience: sql<'only_me'>`'only_me'`.as('audience'),
          publicConsentRevision: sql<number | null>`NULL`.as('public_consent_revision'),
          updatedAt: sql<Date>`now()`.as('updated_at'),
        })
        .from(schema.boardBetaLinks)
        .where(
          or(
            eq(schema.boardBetaLinks.createdByUserId, userId),
            exists(
              tx
                .select({ uuid: schema.boardseshTicks.uuid })
                .from(schema.boardseshTicks)
                .where(
                  and(
                    eq(schema.boardseshTicks.uuid, schema.boardBetaLinks.tickUuid),
                    eq(schema.boardseshTicks.userId, userId),
                  ),
                ),
            ),
          ),
        ),
    )
    .onConflictDoUpdate({
      target: [schema.contentPrivacy.entityType, schema.contentPrivacy.entityId],
      set: { ownerId: userId, audience: 'only_me', publicConsentRevision: null, updatedAt: new Date() },
    });
}
