import { and, eq, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { alias, QueryBuilder } from 'drizzle-orm/pg-core';
import { boardClimbs } from '@boardsesh/db/schema';
import { contentVisibilityCondition, sprayClimbVisibilityCondition } from '@boardsesh/db/queries';

const queryBuilder = new QueryBuilder();

/** Proposals may disclose only a currently readable, published source climb. */
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
        contentVisibilityCondition('climb', climb.uuid, climb.userId, viewerId),
        sprayClimbVisibilityCondition({ boardType: climb.boardType, layoutId: climb.layoutId }, viewerId),
        or(viewerId ? eq(climb.userId, viewerId) : sql`false`, and(eq(climb.isDraft, false), eq(climb.isListed, true))),
      ),
    )})`;
}
