import { GraphQLError } from 'graphql';
import { parseBoardPath, parseNamedBoardPath } from '@boardsesh/board-config';
import { and, eq, isNull } from 'drizzle-orm';
import { userBoards } from '@boardsesh/db/schema';
import { db } from '../db/client';
import { canAccessResourceWithoutLink } from './privacy';

/** A session path carries an existing board identity, never a private-board grant. */
export async function resolveSessionBoardId(
  boardPath: string,
  viewerId: string | null | undefined,
): Promise<number | null> {
  const named = parseNamedBoardPath(boardPath);
  const tuple = parseBoardPath(boardPath);
  const spray = tuple?.boardName === 'spray' ? tuple : null;
  if (!named && !spray) return null;
  if (spray && (!Number.isSafeInteger(spray.layoutId) || spray.layoutId <= 0))
    throw new GraphQLError('Board not found', { extensions: { code: 'NOT_FOUND' } });
  const [board] = await db
    .select({ id: userBoards.id, uuid: userBoards.uuid })
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
  if (!board || !(await canAccessResourceWithoutLink('board', board.uuid, viewerId))) {
    throw new GraphQLError('Board not found', { extensions: { code: 'NOT_FOUND' } });
  }
  return board.id;
}
