import { and, eq, exists, not, or, sql } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import { contentVisibilityCondition } from '@boardsesh/db/queries';
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
  await tx.update(schema.boardClimbs).set({ isBoardseshAuthored: true }).where(eq(schema.boardClimbs.userId, userId));

  await tx
    .insert(schema.contentPrivacy)
    .select(
      tx
        .select({
          entityType: sql<'climb'>`'climb'`.as('entity_type'),
          entityId: schema.boardClimbs.uuid,
          ownerId: schema.boardClimbs.userId,
          audience: sql<'only_me'>`'only_me'`.as('audience'),
          publicConsentRevision: sql<number | null>`NULL`.as('public_consent_revision'),
          updatedAt: sql<Date>`now()`.as('updated_at'),
        })
        .from(schema.boardClimbs)
        .where(
          and(
            eq(schema.boardClimbs.userId, userId),
            eq(schema.boardClimbs.isDraft, false),
            not(contentVisibilityCondition('climb', schema.boardClimbs.uuid, schema.boardClimbs.userId, null)),
          ),
        ),
    )
    .onConflictDoUpdate({
      target: [schema.contentPrivacy.entityType, schema.contentPrivacy.entityId],
      set: { audience: 'only_me', publicConsentRevision: null, updatedAt: new Date() },
    });

  // Keep the existing public-climb retention promise, including a private
  // account's current explicit Public choice. Restricted/stale policies remain.
  await tx.delete(schema.contentPrivacy).where(
    and(
      eq(schema.contentPrivacy.entityType, 'climb'),
      eq(schema.contentPrivacy.ownerId, userId),
      exists(
        tx
          .select({ uuid: schema.boardClimbs.uuid })
          .from(schema.boardClimbs)
          .where(
            and(
              eq(schema.boardClimbs.uuid, schema.contentPrivacy.entityId),
              eq(schema.boardClimbs.userId, userId),
              eq(schema.boardClimbs.isDraft, false),
              contentVisibilityCondition('climb', schema.boardClimbs.uuid, schema.boardClimbs.userId, null),
            ),
          ),
      ),
    ),
  );

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
