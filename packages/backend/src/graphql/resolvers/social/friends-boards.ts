import { and, asc, count, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import type { ConnectionContext, FriendBoard } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { contentVisibilityCondition } from '@boardsesh/db/queries';
import { db } from '../../../db/client';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';
import { FriendsBoardsInputSchema } from '../../../validation/schemas';
import { resourceAccessCondition } from '../../../services/privacy';
import { enrichBoards } from './boards';
import { friendsBoardListingConditions } from './friends-board-listing';

type EnrichedBoard = Awaited<ReturnType<typeof enrichBoards>>[number];
type FriendBoardItem = Omit<FriendBoard, 'board'> & { board: EnrichedBoard | null };

/**
 * Friends' boards: home boards owned by people who follow the viewer, for the
 * "A friend's board" path and the picker shelf. "When I follow you, you can see
 * my boards": the owner's follow is their consent to be listed. Who sees what
 * is in docs/product/privacy.md ("Friends' boards").
 *
 * Every gate runs in the WHERE the count and the page share
 * (`friendsBoardListingConditions`, which the Bluetooth request card reuses).
 *
 * Who may open a board is unchanged: a row the viewer can climb on gets the full
 * `UserBoard` from `enrichBoards`, so the board's location audience still decides
 * its place. A Followers board whose owner the viewer does not follow, or an
 * opted-in Invite-only board the viewer holds no grant on, is a preview only:
 * no slug, serial, location, presence id or counts.
 *
 * The owner's name and avatar are always shown: the owner follows the viewer,
 * and the viewer's own followers list already names them.
 */
export async function readFriendsBoards(
  viewerId: string,
  input: { query?: string | null; limit?: number | null; offset?: number | null },
): Promise<{ items: FriendBoardItem[]; totalCount: number; hasMore: boolean }> {
  const limit = input.limit ?? 20;
  const offset = input.offset ?? 0;
  const boards = dbSchema.userBoards;
  const ownerName = sql<string | null>`COALESCE(${dbSchema.userProfiles.displayName}, ${dbSchema.users.name})`;
  const ownerAvatar = sql<string | null>`COALESCE(${dbSchema.userProfiles.avatarUrl}, ${dbSchema.users.image})`;

  const conditions: SQL[] = friendsBoardListingConditions(viewerId);
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
