import { and, eq, exists, or, sql, type SQL } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { boardClimbs, setterFollows, userFollows, userBoardMappings } from '../../schema/index';

const queryBuilder = new QueryBuilder();

/** Shared membership rule for search, setter counts, and the Crew feed. */
export function followedAuthorCondition(followerId: string | undefined): SQL {
  if (!followerId) return sql`false`;
  return or(
    exists(
      queryBuilder
        .select({ present: sql`1` })
        .from(setterFollows)
        .where(
          and(eq(setterFollows.followerId, followerId), eq(setterFollows.setterUsername, boardClimbs.setterUsername)),
        ),
    ),
    exists(
      queryBuilder
        .select({ present: sql`1` })
        .from(userFollows)
        .where(and(eq(userFollows.followerId, followerId), eq(userFollows.followingId, boardClimbs.userId))),
    ),
    exists(
      queryBuilder
        .select({ present: sql`1` })
        .from(userFollows)
        .innerJoin(userBoardMappings, eq(userBoardMappings.userId, userFollows.followingId))
        .where(
          and(
            eq(userFollows.followerId, followerId),
            eq(userBoardMappings.boardType, boardClimbs.boardType),
            eq(userBoardMappings.boardUsername, boardClimbs.setterUsername),
          ),
        ),
    ),
  )!;
}
