import { and, eq, exists, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import type { DbInstance } from '../../client/postgres';
import { boardClimbs, setterFollows, userFollows, userBoardMappings } from '../../schema/index';

const queryBuilder = new QueryBuilder();

/**
 * Shared membership rule for search and the Crew feed.
 *
 * Three correlated EXISTS arms, which suit a caller that already has a small
 * candidate set (the Crew feed). On a whole-layout aggregate they cannot drive
 * an index and are evaluated as a filter over every row of the layout; the
 * setter counts use `resolveFollowedAuthorLists` + `followedAuthorListCondition`
 * instead, which is the same rule bound as value lists.
 */
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

/** The viewer's follow graph for one board type, as the values it matches on. */
export type FollowedAuthorLists = {
  /** Followed setter names, plus the board usernames of followed users on this board type. */
  setterUsernames: string[];
  /** Followed Boardsesh users, matched on `board_climbs.user_id`. */
  userIds: string[];
};

/**
 * Resolve `followedAuthorCondition`'s three arms to value lists: two indexed
 * reads of tiny tables (at most tens of rows per viewer), plus the followed
 * users' board mappings when there are any.
 *
 * The mapping arm is resolved for ONE board type. That equals the correlated
 * arm (`m.board_type = board_climbs.board_type`) only for a query that pins
 * `board_climbs.board_type` to the same value, which every setter-count query
 * does.
 */
export async function resolveFollowedAuthorLists(
  db: DbInstance,
  followerId: string,
  boardType: string,
): Promise<FollowedAuthorLists> {
  const [setterRows, userRows] = await Promise.all([
    db
      .select({ setterUsername: setterFollows.setterUsername })
      .from(setterFollows)
      .where(eq(setterFollows.followerId, followerId)),
    db.select({ followingId: userFollows.followingId }).from(userFollows).where(eq(userFollows.followerId, followerId)),
  ]);
  const userIds = userRows.map((row) => row.followingId);

  const mappedRows =
    userIds.length === 0
      ? []
      : await db
          .select({ boardUsername: userBoardMappings.boardUsername })
          .from(userBoardMappings)
          .where(
            and(
              inArray(userBoardMappings.userId, userIds),
              eq(userBoardMappings.boardType, boardType),
              isNotNull(userBoardMappings.boardUsername),
            ),
          );

  const setterUsernames = new Set(setterRows.map((row) => row.setterUsername));
  for (const row of mappedRows) {
    if (row.boardUsername) setterUsernames.add(row.boardUsername);
  }
  return { setterUsernames: [...setterUsernames], userIds };
}

/** True when the viewer follows nobody the lists can match, so no climb can qualify. */
export function followedAuthorListsAreEmpty(lists: FollowedAuthorLists): boolean {
  return lists.setterUsernames.length === 0 && lists.userIds.length === 0;
}

/**
 * `followedAuthorCondition` over resolved lists. Both arms are plain
 * ScalarArrayOps, so the planner can BitmapOr `board_climbs_setter_username_idx`
 * with the user_id index instead of filtering the whole layout: 40k -> 541
 * buffers and 320-460 ms -> 49 ms on the replica for kilter layout 1.
 *
 * No `is_draft = false` inside the user_id arm: the correlated rule has none,
 * and a caller that excludes drafts already does so at the top level.
 */
export function followedAuthorListCondition(lists: FollowedAuthorLists): SQL {
  const arms: SQL[] = [];
  if (lists.setterUsernames.length > 0) arms.push(inArray(boardClimbs.setterUsername, lists.setterUsernames));
  if (lists.userIds.length > 0) arms.push(inArray(boardClimbs.userId, lists.userIds));
  if (arms.length === 0) return sql`false`;
  return or(...arms)!;
}
