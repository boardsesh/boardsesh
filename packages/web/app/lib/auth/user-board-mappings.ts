import { getDb } from '@/app/lib/db/db';
import { userBoardMappings } from '@/app/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import type { BoardName } from '@/app/lib/types';

export type UserBoardMapping = {
  id: string;
  userId: string;
  boardType: BoardName;
  boardUserId: number | null;
  boardUserIdText: string | null;
  boardUsername: string | null;
  linkedAt: Date;
};

/**
 * Get the Aurora board user ID for a NextAuth user on a specific board
 */
export async function getBoardUserId(userId: string, boardType: BoardName): Promise<number | null> {
  const db = getDb();

  const result = await db
    .select({ boardUserId: userBoardMappings.boardUserId })
    .from(userBoardMappings)
    .where(and(eq(userBoardMappings.userId, userId), eq(userBoardMappings.boardType, boardType)))
    .limit(1);

  return result[0]?.boardUserId || null;
}

/**
 * Get all board mappings for a NextAuth user
 */
export async function getUserBoardMappings(userId: string): Promise<UserBoardMapping[]> {
  const db = getDb();

  const results = await db.select().from(userBoardMappings).where(eq(userBoardMappings.userId, userId));

  return results.map((row) => ({
    id: row.id.toString(),
    userId: row.userId,
    boardType: row.boardType as BoardName,
    boardUserId: row.boardUserId,
    boardUserIdText: row.boardUserIdText,
    boardUsername: row.boardUsername,
    linkedAt: row.linkedAt,
  }));
}

/**
 * Remove a board mapping for a user
 */
export async function removeUserBoardMapping(userId: string, boardType: BoardName): Promise<void> {
  const db = getDb();

  await db
    .delete(userBoardMappings)
    .where(and(eq(userBoardMappings.userId, userId), eq(userBoardMappings.boardType, boardType)));
}

/**
 * Check if a NextAuth user has a board mapping for a specific board
 */
export async function hasBoardMapping(userId: string, boardType: BoardName): Promise<boolean> {
  const boardUserId = await getBoardUserId(userId, boardType);
  return boardUserId !== null;
}
