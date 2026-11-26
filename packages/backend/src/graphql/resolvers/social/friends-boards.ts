import { and, asc, count, eq, ilike, isNull, ne, notExists, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { ConnectionContext, FriendBoard } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { contentVisibilityCondition, mutualFollowListingCondition } from '@boardsesh/db/queries';
import { db } from '../../../db/client';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';
import { FriendsBoardsInputSchema } from '../../../validation/schemas';
import { privacyControlsEnabled, resourceAccessCondition } from '../../../services/privacy';
import { enrichBoards } from './boards';

/**
 * Friends' boards: home boards owned by the viewer's friends, people they follow
 * who follow them back, for the "A friend's board" path and the picker shelf.
 * Who sees what is in docs/product/privacy.md ("Friends' boards").
 *
 * Every gate runs in the WHERE the count and the page share:
 * - the owner and the viewer follow each other (`user_follows`, which holds
 *   approved follows only). A one-way follow, either way, lists nothing;
 * - a live home board: not deleted or merged away, not a spray wall, and not at
 *   someone else's gym or at a public listed gym (`homeWallCondition`);
 * - not the viewer's own board and not one their Your boards already shows: a
 *   `board_follows` row they can still open, read the way `myBoards` reads it.
 *   A save they can no longer open (the board went Invite-only since) stays
 *   listed, so they can ask for it again;
 * - the follow and audience rule (`mutualFollowListingCondition`).
 *
 * Who may open a board is unchanged: a row the viewer can climb on gets the full
 * `UserBoard` from `enrichBoards`, so the board's location audience still decides
 * its place. The viewer follows the owner, so a Followers board always opens;
 * only an opted-in Invite-only board the viewer holds no grant on is a preview:
 * no slug, serial, location, presence id or counts.
 *
 * The owner's name and avatar are always shown. The viewer is an approved
 * follower of the owner, which is the rule `canViewActivityIdentity` names a
 * private owner on, so `FriendBoard.owner` and the full board's `owner*` fields
 * agree.
 */
/**
 * A home wall, gym or not: no gym, a gym that is gone, or a gym the board's own
 * owner runs that is not a public listed gym (a home wall that minted a private
 * or unlisted gym). A board at someone else's gym, or at a public listed gym,
 * is found through that gym instead. One primary-key lookup per board.
 */
function homeWallCondition(gymIdColumn: SQLWrapper, ownerIdColumn: SQLWrapper): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM gyms friend_gym
    WHERE friend_gym.id = ${gymIdColumn} AND friend_gym.deleted_at IS NULL
      AND (friend_gym.owner_id <> ${ownerIdColumn} OR (friend_gym.is_public AND friend_gym.is_listed)))`;
}

type EnrichedBoard = Awaited<ReturnType<typeof enrichBoards>>[number];
type FriendBoardItem = Omit<FriendBoard, 'board'> & { board: EnrichedBoard | null };

export async function readFriendsBoards(
  viewerId: string,
  input: { query?: string | null; limit?: number | null; offset?: number | null },
): Promise<{ items: FriendBoardItem[]; totalCount: number; hasMore: boolean }> {
  const limit = input.limit ?? 20;
  const offset = input.offset ?? 0;
  const boards = dbSchema.userBoards;
  const ownerName = sql<string | null>`COALESCE(${dbSchema.userProfiles.displayName}, ${dbSchema.users.name})`;
  const ownerAvatar = sql<string | null>`COALESCE(${dbSchema.userProfiles.avatarUrl}, ${dbSchema.users.image})`;

  const conditions: SQL[] = [
    isNull(boards.deletedAt),
    isNull(boards.mergedIntoBoardUuid),
    homeWallCondition(boards.gymId, boards.ownerId),
    ne(boards.boardType, 'spray'),
    ne(boards.ownerId, viewerId),
    notExists(
      db
        .select({ id: dbSchema.boardFollows.id })
        .from(dbSchema.boardFollows)
        .where(
          and(
            eq(dbSchema.boardFollows.userId, viewerId),
            eq(dbSchema.boardFollows.boardUuid, boards.uuid),
            // The same access check myBoards puts on a saved board.
            resourceAccessCondition('board', boards.uuid, viewerId),
          ),
        ),
    ),
    // With the controls off the owner cannot reach the switch or answer a
    // request, so the switch reads as off and only openable boards are listed.
    mutualFollowListingCondition(boards.uuid, boards.ownerId, viewerId, {
      honourListedToFollowers: privacyControlsEnabled(),
    }),
  ];
  const query = input.query?.trim();
  if (query) {
    const pattern = `%${query.replace(/[%_\\]/g, '\\$&')}%`;
    conditions.push(or(ilike(boards.name, pattern), ilike(ownerName, pattern))!);
  }
  const whereClause = and(...conditions);

  const [countRow] = await db
    .select({ count: count() })
    .from(boards)
    .innerJoin(dbSchema.users, eq(dbSchema.users.id, boards.ownerId))
    .leftJoin(dbSchema.userProfiles, eq(dbSchema.userProfiles.userId, boards.ownerId))
    .where(whereClause);
  const totalCount = Number(countRow?.count ?? 0);
  if (totalCount === 0 || offset >= totalCount) return { items: [], totalCount, hasMore: false };

  // Order keys only, never returned. The viewer's own logs on the board read
  // `boardsesh_ticks_board_user_idx`. The owner's latest log walks
  // `boardsesh_ticks_user_climbed_at_idx` down to the first log the viewer may
  // read (`contentVisibilityCondition` asks about this viewer, follow or not),
  // so an Only me log does not move the owner's boards up the list.
  const viewerLastLog = sql`(SELECT max(viewer_tick.climbed_at) FROM boardsesh_ticks viewer_tick
    WHERE viewer_tick.board_id = ${boards.id} AND viewer_tick.user_id = ${viewerId})`;
  const ownerLastLog = sql`(SELECT owner_tick.climbed_at FROM boardsesh_ticks owner_tick
    WHERE owner_tick.user_id = ${boards.ownerId}
      AND ${contentVisibilityCondition('tick', sql`owner_tick.uuid`, sql`owner_tick.user_id`, viewerId)}
    ORDER BY owner_tick.climbed_at DESC LIMIT 1)`;

  const rows = await db
    .select({
      board: boards,
      ownerName,
      ownerAvatar,
      canClimb: sql<boolean>`${resourceAccessCondition('board', boards.uuid, viewerId)}`,
      requested: sql<boolean>`EXISTS (SELECT 1 FROM resource_grants friend_request
        WHERE friend_request.kind = 'board' AND friend_request.resource_id = ${boards.uuid}
          AND friend_request.user_id = ${viewerId} AND friend_request.status = 'pending')`,
    })
    .from(boards)
    .innerJoin(dbSchema.users, eq(dbSchema.users.id, boards.ownerId))
    .leftJoin(dbSchema.userProfiles, eq(dbSchema.userProfiles.userId, boards.ownerId))
    .where(whereClause)
    .orderBy(
      sql`${viewerLastLog} DESC NULLS LAST`,
      sql`${ownerLastLog} DESC NULLS LAST`,
      sql`lower(${ownerName}) ASC NULLS LAST`,
      asc(boards.name),
      // Total order for OFFSET paging.
      asc(boards.id),
    )
    .limit(limit)
    .offset(offset);

  const climbable = rows.filter((row) => row.canClimb).map((row) => ({ board: row.board }));
  const enriched = new Map((await enrichBoards(climbable, viewerId)).map((board) => [board.uuid, board]));

  const items: FriendBoardItem[] = [];
  for (const row of rows) {
    const fullBoard = row.canClimb ? enriched.get(row.board.uuid) : undefined;
    // Readable in the WHERE but not by the time it was enriched (a revoke in
    // between): leave it out rather than downgrade it to a request card.
    if (row.canClimb && !fullBoard) continue;
    items.push({
      viewerAccess: fullBoard ? 'CAN_CLIMB' : row.requested ? 'REQUESTED' : 'CAN_REQUEST',
      owner: { userId: row.board.ownerId, displayName: row.ownerName, avatarUrl: row.ownerAvatar },
      preview: {
        uuid: row.board.uuid,
        name: row.board.name,
        boardType: row.board.boardType,
        layoutId: Number(row.board.layoutId),
        sizeId: Number(row.board.sizeId),
        setIds: row.board.setIds,
        angle: Number(row.board.angle),
      },
      board: fullBoard ?? null,
    });
  }
  return { items, totalCount, hasMore: offset + rows.length < totalCount };
}

export const friendsBoardsQueries = {
  friendsBoards: async (_: unknown, { input }: { input?: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 30, 'friendsBoards');
    const validated = validateInput(FriendsBoardsInputSchema, input ?? {}, 'input');
    return readFriendsBoards(ctx.userId!, validated);
  },
};
