/**
 * Which board should a logged climb be drawn on?
 *
 * The ladder itself lives in `@boardsesh/board-config` (`resolveRenderBoard`) so
 * web, mobile and the backend agree. This module is the backend's half: loading
 * the boards to reason about, keyed by the climber the ascent belongs to — not
 * by whoever is looking at the feed. That's why the resolution happens here
 * rather than in the clients: a viewer only knows their own boards, and drawing
 * someone else's ascents on *your* wall would be a different wrong answer.
 *
 * Feeds resolve one page at a time, so one query per page covers every row.
 */
import { and, inArray, isNull, or } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { RenderBoardCandidate } from '@boardsesh/board-config';
import { db } from '../../../db/client';

export type OwnerBoardsByUserId = Map<string, RenderBoardCandidate[]>;

/** `user_boards.set_ids` is a CSV string; every consumer wants numbers. */
export function parseBoardSetIds(csv: string | null | undefined): number[] {
  if (!csv) return [];
  return csv
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((setId) => Number.isInteger(setId) && setId > 0);
}

/**
 * Every board the given users have — owned or followed, any board type or
 * layout — as render candidates. Ordered owned-first then by `user_boards.id`,
 * which is the tie-break `resolveRenderBoard` relies on when two boards of the
 * same size both fit.
 *
 * Returns an empty map for an empty input, and omits users with no boards.
 */
export async function fetchOwnerBoards(userIds: readonly string[]): Promise<OwnerBoardsByUserId> {
  const byUserId: OwnerBoardsByUserId = new Map();
  const uniqueUserIds = Array.from(new Set(userIds.filter((userId) => userId.length > 0)));
  if (uniqueUserIds.length === 0) return byUserId;

  const follows = await db
    .select({ userId: dbSchema.boardFollows.userId, boardUuid: dbSchema.boardFollows.boardUuid })
    .from(dbSchema.boardFollows)
    .where(inArray(dbSchema.boardFollows.userId, uniqueUserIds));

  const followedUuids = Array.from(new Set(follows.map((follow) => follow.boardUuid)));
  const ownedCondition = inArray(dbSchema.userBoards.ownerId, uniqueUserIds);
  const matchCondition =
    followedUuids.length > 0 ? or(ownedCondition, inArray(dbSchema.userBoards.uuid, followedUuids))! : ownedCondition;

  const boards = await db
    .select({
      id: dbSchema.userBoards.id,
      uuid: dbSchema.userBoards.uuid,
      ownerId: dbSchema.userBoards.ownerId,
      boardType: dbSchema.userBoards.boardType,
      layoutId: dbSchema.userBoards.layoutId,
      sizeId: dbSchema.userBoards.sizeId,
      setIds: dbSchema.userBoards.setIds,
    })
    .from(dbSchema.userBoards)
    .where(and(matchCondition, isNull(dbSchema.userBoards.deletedAt)))
    .orderBy(dbSchema.userBoards.id);

  const followersByBoardUuid = new Map<string, string[]>();
  for (const follow of follows) {
    const existing = followersByBoardUuid.get(follow.boardUuid);
    if (existing) existing.push(follow.userId);
    else followersByBoardUuid.set(follow.boardUuid, [follow.userId]);
  }

  const addBoard = (userId: string, candidate: RenderBoardCandidate) => {
    const existing = byUserId.get(userId);
    if (existing) existing.push(candidate);
    else byUserId.set(userId, [candidate]);
  };

  const requestedUserIds = new Set(uniqueUserIds);
  for (const board of boards) {
    const candidate: Omit<RenderBoardCandidate, 'isOwned'> = {
      boardType: board.boardType,
      layoutId: Number(board.layoutId),
      sizeId: Number(board.sizeId),
      setIds: parseBoardSetIds(board.setIds),
    };
    if (requestedUserIds.has(board.ownerId)) {
      addBoard(board.ownerId, { ...candidate, isOwned: true });
    }
    for (const followerId of followersByBoardUuid.get(board.uuid) ?? []) {
      // A climber can follow a board they also own; the owned entry already covers it.
      if (followerId !== board.ownerId) addBoard(followerId, { ...candidate, isOwned: false });
    }
  }

  // Owned boards first, so `resolveRenderBoard`'s owned-beats-followed tie-break
  // sees them in a stable order (each group already ordered by user_boards.id).
  for (const [userId, candidates] of byUserId) {
    byUserId.set(userId, [
      ...candidates.filter((candidate) => candidate.isOwned),
      ...candidates.filter((candidate) => !candidate.isOwned),
    ]);
  }

  return byUserId;
}

/**
 * The board a tick was logged against, as a render candidate. Built from the
 * `user_boards` columns a feed query already LEFT JOINs. Null when the tick
 * carries no board association or the join produced nothing.
 */
export function toTickBoardCandidate(board: {
  boardType: string | null;
  layoutId: number | string | null;
  sizeId: number | string | null;
  setIds: string | null;
}): RenderBoardCandidate | null {
  if (board.boardType == null || board.layoutId == null || board.sizeId == null) return null;
  const setIds = parseBoardSetIds(board.setIds);
  if (setIds.length === 0) return null;
  return {
    boardType: board.boardType,
    layoutId: Number(board.layoutId),
    sizeId: Number(board.sizeId),
    setIds,
    isOwned: true,
  };
}
