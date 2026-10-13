import { and, eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { alias, QueryBuilder } from 'drizzle-orm/pg-core';
import { boardClimbs } from '@boardsesh/db/schema';
import { ownedOrPublicClimbCondition, sprayClimbVisibilityCondition } from '@boardsesh/db/queries';

const queryBuilder = new QueryBuilder();

/**
 * Proposals may disclose only a published, listed climb, whoever set it, or
 * the viewer's own climb. No account privacy or item audience applies to the
 * climb. The spray half is the wall's rule.
 *
 * Listed, not the by-reference rule of the climb's own page: a proposal is not
 * a read of the climb by its link. The moderation feed lists proposals across
 * a board, and a proposal uuid travels in notifications, so an unlisted climb's
 * proposals stay with its owner. Strangers cannot open one there anyway:
 * `loadTargetClimb` refuses a proposal on an unlisted climb to anyone else.
 */
export function proposalClimbVisibilityCondition(
  reference: { boardType: SQLWrapper; climbUuid: SQLWrapper },
  viewerId: string | null | undefined,
): SQL {
  const climb = alias(boardClimbs, 'privacy_proposal_climb');
  return sql`EXISTS (${queryBuilder
    .select({ uuid: climb.uuid })
    .from(climb)
    .where(
      and(
        eq(climb.uuid, reference.climbUuid),
        eq(climb.boardType, reference.boardType),
        ownedOrPublicClimbCondition(
          { isDraft: climb.isDraft, isListed: climb.isListed, userId: climb.userId },
          viewerId,
        ),
        sprayClimbVisibilityCondition({ boardType: climb.boardType, layoutId: climb.layoutId }, viewerId),
      ),
    )})`;
}
