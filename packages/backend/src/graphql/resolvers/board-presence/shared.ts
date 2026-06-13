import { GraphQLError } from 'graphql';
import { and, eq, isNull, or } from 'drizzle-orm';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type { ResolvedBoard } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { logger } from '../../../utils/logger';
import { isUniqueViolation } from '../../../utils/postgres-errors';

/**
 * Board presence is gated behind an env flag while the epic is in flight.
 * Every mutation, query, and subscribe entry point calls this first so the
 * feature is fully dark (not just hidden in the UI) until we flip it on.
 */
export function isBoardPresenceEnabled(): boolean {
  return process.env.BOARD_PRESENCE_ENABLED === 'true';
}

export function requireBoardPresenceEnabled(): void {
  if (!isBoardPresenceEnabled()) {
    throw new GraphQLError('Board presence is not enabled');
  }
}

/**
 * Validate the `boardId` argument is a positive integer. The SDL types it as
 * `Int!`, but GraphQL won't reject 0/negative/float-coerced values, and a
 * bogus id would key a presence channel nobody else is on.
 */
export function assertValidBoardId(boardId: number): number {
  if (!Number.isInteger(boardId) || boardId <= 0) {
    throw new GraphQLError('boardId must be a positive integer');
  }
  return boardId;
}

export const SYSTEM_BOARD_OWNER_ID = '00000000-0000-0000-0000-000000000000';
const SYSTEM_BOARD_OWNER_EMAIL = 'system@boardsesh.com';

export type ActivePresenceBoard = Pick<
  typeof dbSchema.userBoards.$inferSelect,
  'id' | 'name' | 'ownerId' | 'boardType' | 'layoutId' | 'sizeId' | 'setIds' | 'serialNumber' | 'angle' | 'isPublic'
>;

export function toResolvedBoard(board: ActivePresenceBoard): ResolvedBoard {
  return {
    boardId: Number(board.id),
    boardName: board.name,
    boardType: board.boardType,
    layoutId: Number(board.layoutId),
    sizeId: Number(board.sizeId),
    setIds: board.setIds,
  };
}

export async function findActiveBoardBySerial(serial: string): Promise<ActivePresenceBoard | undefined> {
  const [board] = await db
    .select({
      id: dbSchema.userBoards.id,
      name: dbSchema.userBoards.name,
      ownerId: dbSchema.userBoards.ownerId,
      boardType: dbSchema.userBoards.boardType,
      layoutId: dbSchema.userBoards.layoutId,
      sizeId: dbSchema.userBoards.sizeId,
      setIds: dbSchema.userBoards.setIds,
      serialNumber: dbSchema.userBoards.serialNumber,
      angle: dbSchema.userBoards.angle,
      isPublic: dbSchema.userBoards.isPublic,
    })
    .from(dbSchema.userBoards)
    .where(and(eq(dbSchema.userBoards.serialNumber, serial), isNull(dbSchema.userBoards.deletedAt)))
    .limit(1);
  return board;
}

export async function findActiveBoardById(boardId: number): Promise<ActivePresenceBoard | undefined> {
  const [board] = await db
    .select({
      id: dbSchema.userBoards.id,
      name: dbSchema.userBoards.name,
      ownerId: dbSchema.userBoards.ownerId,
      boardType: dbSchema.userBoards.boardType,
      layoutId: dbSchema.userBoards.layoutId,
      sizeId: dbSchema.userBoards.sizeId,
      setIds: dbSchema.userBoards.setIds,
      serialNumber: dbSchema.userBoards.serialNumber,
      angle: dbSchema.userBoards.angle,
      isPublic: dbSchema.userBoards.isPublic,
    })
    .from(dbSchema.userBoards)
    .where(and(eq(dbSchema.userBoards.id, boardId), isNull(dbSchema.userBoards.deletedAt)))
    .limit(1);
  return board;
}

export async function findReachableActiveBoardByUuid(
  userId: string,
  boardUuid: string,
): Promise<ActivePresenceBoard | undefined> {
  const [board] = await db
    .select({
      id: dbSchema.userBoards.id,
      name: dbSchema.userBoards.name,
      ownerId: dbSchema.userBoards.ownerId,
      boardType: dbSchema.userBoards.boardType,
      layoutId: dbSchema.userBoards.layoutId,
      sizeId: dbSchema.userBoards.sizeId,
      setIds: dbSchema.userBoards.setIds,
      serialNumber: dbSchema.userBoards.serialNumber,
      angle: dbSchema.userBoards.angle,
      isPublic: dbSchema.userBoards.isPublic,
    })
    .from(dbSchema.userBoards)
    .where(
      and(
        eq(dbSchema.userBoards.uuid, boardUuid),
        isNull(dbSchema.userBoards.deletedAt),
        or(eq(dbSchema.userBoards.ownerId, userId), eq(dbSchema.userBoards.isPublic, true)),
      ),
    )
    .limit(1);
  return board;
}

/**
 * Canonical set-id string for equality checks: numeric tokens only, deduped,
 * numerically sorted. Lets us compare a tick's target set against a board's
 * stored set without caring about order or formatting.
 */
export function normalizeSetIds(setIds: string | null | undefined): string {
  if (!setIds) return '';
  return [
    ...new Set(
      setIds
        .split(',')
        .map((token) => token.trim())
        .filter((token) => /^\d+$/.test(token)),
    ),
  ]
    .sort((first, second) => Number(first) - Number(second))
    .join(',');
}

export async function requireActiveBoardById(boardId: number): Promise<ActivePresenceBoard> {
  assertValidBoardId(boardId);
  const board = await findActiveBoardById(boardId);
  if (!board) {
    throw new GraphQLError('Board not found');
  }
  return board;
}

export async function findOwnActiveBoardByConfig(
  ownerId: string,
  boardType: string,
  layoutId: number,
  sizeId: number,
  setIds: string,
): Promise<ActivePresenceBoard | undefined> {
  const normalizedSetIds = normalizeSetIds(setIds);
  const [board] = await db
    .select({
      id: dbSchema.userBoards.id,
      name: dbSchema.userBoards.name,
      ownerId: dbSchema.userBoards.ownerId,
      boardType: dbSchema.userBoards.boardType,
      layoutId: dbSchema.userBoards.layoutId,
      sizeId: dbSchema.userBoards.sizeId,
      setIds: dbSchema.userBoards.setIds,
      serialNumber: dbSchema.userBoards.serialNumber,
      angle: dbSchema.userBoards.angle,
      isPublic: dbSchema.userBoards.isPublic,
    })
    .from(dbSchema.userBoards)
    .where(
      and(
        eq(dbSchema.userBoards.ownerId, ownerId),
        eq(dbSchema.userBoards.boardType, boardType),
        eq(dbSchema.userBoards.layoutId, layoutId),
        eq(dbSchema.userBoards.sizeId, sizeId),
        eq(dbSchema.userBoards.setIds, normalizedSetIds),
        isNull(dbSchema.userBoards.deletedAt),
      ),
    )
    .limit(1);
  return board;
}

export function serialAlreadyBoundError(): GraphQLError {
  return new GraphQLError('This board configuration is already linked to another wall serial', {
    extensions: { code: 'BOARD_SERIAL_ALREADY_BOUND' },
  });
}

export function duplicateBoardSerialError(): GraphQLError {
  return new GraphQLError('That serial is already linked to another board', {
    extensions: { code: 'BOARD_SERIAL_ALREADY_LINKED' },
  });
}

export function isDuplicateBoardSerialError(error: unknown): boolean {
  return isUniqueViolation(error, 'user_boards_unique_serial');
}

export function throwIfDuplicateBoardSerial(error: unknown): void {
  if (isDuplicateBoardSerialError(error)) {
    throw duplicateBoardSerialError();
  }
}

const BOARD_TYPE_LABELS: Record<string, string> = {
  kilter: 'Kilter',
  tension: 'Tension',
  moonboard: 'MoonBoard',
  decoy: 'Decoy',
  touchstone: 'Touchstone',
  grasshopper: 'Grasshopper',
  soill: 'So iLL',
};

export function defaultBoardName(boardType: string): string {
  return `${BOARD_TYPE_LABELS[boardType] ?? boardType} Board`;
}

function boardConfigPresenceSlug(boardType: string, layoutId: number, sizeId: number, setIds: string): string {
  const digest = createHash('sha256').update(`${boardType}:${layoutId}:${sizeId}:${setIds}`).digest('hex').slice(0, 20);
  return `presence-${boardType}-${layoutId}-${sizeId}-${digest}`;
}

async function ensureSystemBoardOwner(): Promise<void> {
  await db
    .insert(dbSchema.users)
    .values({
      id: SYSTEM_BOARD_OWNER_ID,
      email: SYSTEM_BOARD_OWNER_EMAIL,
      name: 'Boardsesh',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
}

export async function resolveSharedBoardForConfig(
  boardType: string,
  layoutId: number,
  sizeId: number,
  setIds: string,
): Promise<ResolvedBoard> {
  const normalizedSetIds = normalizeSetIds(setIds);
  const slug = boardConfigPresenceSlug(boardType, layoutId, sizeId, normalizedSetIds);

  const [existing] = await db
    .select()
    .from(dbSchema.userBoards)
    .where(and(eq(dbSchema.userBoards.slug, slug), isNull(dbSchema.userBoards.deletedAt)))
    .limit(1);
  if (existing) {
    return toResolvedBoard(existing);
  }

  await ensureSystemBoardOwner();

  try {
    const [created] = await db
      .insert(dbSchema.userBoards)
      .values({
        uuid: uuidv4(),
        slug,
        ownerId: SYSTEM_BOARD_OWNER_ID,
        boardType,
        layoutId,
        sizeId,
        setIds: normalizedSetIds,
        name: `${defaultBoardName(boardType)} Shared Feed`,
        serialNumber: null,
        isPublic: false,
        isUnlisted: true,
        hideLocation: true,
        isOwned: false,
      })
      .returning();
    return toResolvedBoard(created);
  } catch (error) {
    if (!isUniqueViolation(error, 'user_boards_unique_slug')) {
      throw error;
    }
    logger.warn(`[board-presence] resolveSharedBoardForConfig create race: ${String(error)}`);
    const [winner] = await db
      .select()
      .from(dbSchema.userBoards)
      .where(and(eq(dbSchema.userBoards.slug, slug), isNull(dbSchema.userBoards.deletedAt)))
      .limit(1);
    if (winner) {
      return toResolvedBoard(winner);
    }
    throw error;
  }
}
