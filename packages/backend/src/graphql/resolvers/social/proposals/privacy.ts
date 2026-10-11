import { and, eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { alias, QueryBuilder } from 'drizzle-orm/pg-core';
import { boardClimbs } from '@boardsesh/db/schema';
import { climbDraftVisibilityCondition, sprayClimbVisibilityCondition } from '@boardsesh/db/queries';

const queryBuilder = new QueryBuilder();

/**
 * Proposals may disclose only a climb the viewer may read by reference: a
 * published one, whoever set it, or the viewer's own draft. No account privacy
 * or item audience applies to the climb. The spray half is the wall's rule.
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
        climbDraftVisibilityCondition({ isDraft: climb.isDraft, userId: climb.userId }, viewerId),
        sprayClimbVisibilityCondition({ boardType: climb.boardType, layoutId: climb.layoutId }, viewerId),
      ),
    )})`;
}
