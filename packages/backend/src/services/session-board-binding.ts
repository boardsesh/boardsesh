import { GraphQLError } from 'graphql';
import { parseBoardPath, parseNamedBoardPath } from '@boardsesh/board-config';
import { and, eq, isNull } from 'drizzle-orm';
import { userBoards, users } from '@boardsesh/db/schema';
import { db } from '../db/client';
import type { DbTransaction } from '../db/after-commit';
import { lockActiveBoardForWrite } from './board-reference-lock';
import { getPostgresErrorCode } from '../utils/postgres-errors';
import { canAccessResource, canAccessResourceWithoutLink, isLiveSessionMemberOnHomeWall } from './privacy';

export const SESSION_BOARD_LOCK_TIMEOUT_MS = 2000;

/** Session inserts take this FK lock before a board, matching account/privacy writers. */
export async function lockSessionCreatorBeforeBoards(
  transaction: DbTransaction,
  creatorUserId: string | null | undefined,
): Promise<void> {
  if (creatorUserId)
    await transaction.select({ id: users.id }).from(users).where(eq(users.id, creatorUserId)).for('key share').limit(1);
}

/**
 * The board a session path names, or null for a plain config path. A home
 * board's `/b/<slug>` path is its link, so the board's policy decides with the
 * link reading: an Unlisted board binds for anyone holding the path, and a
 * Followers or Invite-only board still needs the viewer's standing. A spray
 * wall's path (`/b/<slug>` or `/spray/<layoutId>`) is a guess from its name or
 * a counted id, never its link, so it takes the no-link reading. The path is
 * never a grant: a board the viewer may not open is NOT_FOUND.
 *
 * One exception, for a path change inside an existing session (`inSessionId`):
 * a member of that live session keeps it on the home wall it is already on, so
 * a crew member's angle change does not fail on a private wall they joined
 * (#7013). Only that session, and only its current wall: a member can never
 * bind the wall to a new session, which would hand it to that session's crew.
 */
export async function resolveSessionBoardId(
  boardPath: string,
  viewerId: string | null | undefined,
  inSessionId?: string,
): Promise<number | null> {
  const named = parseNamedBoardPath(boardPath);
  const tuple = parseBoardPath(boardPath);
  const spray = tuple?.boardName === 'spray' ? tuple : null;
  if (!named && !spray) return null;
  if (spray && (!Number.isSafeInteger(spray.layoutId) || spray.layoutId <= 0))
    throw new GraphQLError('Board not found', { extensions: { code: 'NOT_FOUND' } });
  const [board] = await db
    .select({ id: userBoards.id, uuid: userBoards.uuid, boardType: userBoards.boardType })
    .from(userBoards)
    .where(
      and(
        named
          ? eq(userBoards.slug, named.slug)
          : and(eq(userBoards.boardType, 'spray'), eq(userBoards.layoutId, spray!.layoutId)),
        isNull(userBoards.deletedAt),
      ),
    )
    .limit(1);
  const pathIsLink = named !== null && board?.boardType !== 'spray';
  if (
    !board ||
    !(
      (await (pathIsLink ? canAccessResource : canAccessResourceWithoutLink)('board', board.uuid, viewerId)) ||
      (pathIsLink &&
        inSessionId !== undefined &&
        (await isLiveSessionMemberOnHomeWall(board.uuid, viewerId, inSessionId)))
    )
  ) {
    throw new GraphQLError('Board not found', { extensions: { code: 'NOT_FOUND' } });
  }
  return board.id;
}

/** Session-reference writers keep this active identity stable through their transaction. */
export async function resolveLockedSessionBoardId(
  transaction: DbTransaction,
  boardPath: string,
  viewerId: string | null | undefined,
  inSessionId?: string,
): Promise<number | null> {
  const boardId = await resolveSessionBoardId(boardPath, viewerId, inSessionId);
  if (boardId === null) return null;
  await lockSessionCreatorBeforeBoards(transaction, viewerId);
  try {
    const board = await lockActiveBoardForWrite(
      transaction,
      { id: boardId },
      { lockTimeoutMs: SESSION_BOARD_LOCK_TIMEOUT_MS },
    );
    // Access may have changed after the candidate read; re-read it while pinned.
    if (!board || (await resolveSessionBoardId(boardPath, viewerId, inSessionId)) !== boardId)
      throw new GraphQLError('Board not found', { extensions: { code: 'NOT_FOUND' } });
    return boardId;
  } catch (error) {
    if (getPostgresErrorCode(error) === '55P03' || getPostgresErrorCode(error) === '40P01')
      throw new GraphQLError('This board is changing. Retry the session action.', { extensions: { code: 'CONFLICT' } });
    throw error;
  }
}
