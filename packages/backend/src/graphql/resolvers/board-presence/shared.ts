import { GraphQLError } from 'graphql';
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type { BoardConnectionHolder, ResolvedBoard } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { pubsub } from '../../../pubsub/index';
import { logger } from '../../../utils/logger';
import { isUniqueViolation } from '../../../utils/postgres-errors';

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
  'id' | 'name' | 'boardType' | 'layoutId' | 'sizeId' | 'setIds' | 'serialNumber' | 'angle'
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
      boardType: dbSchema.userBoards.boardType,
      layoutId: dbSchema.userBoards.layoutId,
      sizeId: dbSchema.userBoards.sizeId,
      setIds: dbSchema.userBoards.setIds,
      serialNumber: dbSchema.userBoards.serialNumber,
      angle: dbSchema.userBoards.angle,
    })
    .from(dbSchema.userBoards)
    .where(and(eq(dbSchema.userBoards.serialNumber, serial), isNull(dbSchema.userBoards.deletedAt)))
    .orderBy(asc(dbSchema.userBoards.id))
    .limit(1);
  return board;
}

/**
 * A board sharing a (now non-unique) serial, with the extra fields the
 * disambiguation picker needs. Location fields are redacted later for
 * non-public boards the caller doesn't own (see `toBoardCandidate`).
 */
export type SerialCandidateBoard = {
  id: number;
  uuid: string;
  ownerId: string;
  name: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  serialNumber: string | null;
  angle: number;
  isPublic: boolean;
  locationName: string | null;
  gymName: string | null;
};

export function candidateToActiveBoard(candidate: SerialCandidateBoard): ActivePresenceBoard {
  return {
    id: candidate.id,
    name: candidate.name,
    boardType: candidate.boardType,
    layoutId: candidate.layoutId,
    sizeId: candidate.sizeId,
    setIds: candidate.setIds,
    serialNumber: candidate.serialNumber,
    angle: candidate.angle,
  };
}

/**
 * All active boards carrying this serial. Serials are no longer globally
 * unique (the supplier reuses them), so this can return many rows — the user
 * disambiguates. Oldest-first so the legacy auto-pick is deterministic.
 */
export async function findActiveBoardsBySerial(serial: string): Promise<SerialCandidateBoard[]> {
  const rows = await db
    .select({
      id: dbSchema.userBoards.id,
      uuid: dbSchema.userBoards.uuid,
      ownerId: dbSchema.userBoards.ownerId,
      name: dbSchema.userBoards.name,
      boardType: dbSchema.userBoards.boardType,
      layoutId: dbSchema.userBoards.layoutId,
      sizeId: dbSchema.userBoards.sizeId,
      setIds: dbSchema.userBoards.setIds,
      serialNumber: dbSchema.userBoards.serialNumber,
      angle: dbSchema.userBoards.angle,
      isPublic: dbSchema.userBoards.isPublic,
      locationName: dbSchema.userBoards.locationName,
      hideLocation: dbSchema.userBoards.hideLocation,
      gymName: dbSchema.gyms.name,
    })
    .from(dbSchema.userBoards)
    .leftJoin(dbSchema.gyms, and(eq(dbSchema.gyms.id, dbSchema.userBoards.gymId), isNull(dbSchema.gyms.deletedAt)))
    .where(and(eq(dbSchema.userBoards.serialNumber, serial), isNull(dbSchema.userBoards.deletedAt)))
    .orderBy(asc(dbSchema.userBoards.id));

  return rows.map((row) => ({
    id: Number(row.id),
    uuid: row.uuid,
    ownerId: row.ownerId,
    name: row.name,
    boardType: row.boardType,
    layoutId: Number(row.layoutId),
    sizeId: Number(row.sizeId),
    setIds: row.setIds,
    serialNumber: row.serialNumber,
    angle: Number(row.angle),
    isPublic: row.isPublic,
    // A board that opts into hiding its location is treated as location-private
    // even when the board itself is public.
    locationName: row.hideLocation ? null : row.locationName,
    gymName: row.gymName ?? null,
  }));
}

/**
 * The board this user previously settled on for this serial (either by
 * explicitly picking it in the disambiguation prompt, or by connecting while
 * on a named board). Remembered in `userBoardSerials.boardUuid`; wins over a
 * fresh prompt so we don't ask every time.
 */
export async function findChosenBoardForSerial(
  userId: string,
  serial: string,
): Promise<ActivePresenceBoard | undefined> {
  const [board] = await db
    .select({
      id: dbSchema.userBoards.id,
      name: dbSchema.userBoards.name,
      boardType: dbSchema.userBoards.boardType,
      layoutId: dbSchema.userBoards.layoutId,
      sizeId: dbSchema.userBoards.sizeId,
      setIds: dbSchema.userBoards.setIds,
      serialNumber: dbSchema.userBoards.serialNumber,
      angle: dbSchema.userBoards.angle,
    })
    .from(dbSchema.userBoardSerials)
    .innerJoin(
      dbSchema.userBoards,
      and(eq(dbSchema.userBoards.uuid, dbSchema.userBoardSerials.boardUuid), isNull(dbSchema.userBoards.deletedAt)),
    )
    .where(
      and(
        eq(dbSchema.userBoardSerials.userId, userId),
        eq(dbSchema.userBoardSerials.serialNumber, serial),
        isNotNull(dbSchema.userBoardSerials.boardUuid),
      ),
    )
    .limit(1);
  return board;
}

/** Most-recent tick time per board, for the "which board did I last use" hint. */
export async function lastSentAtByBoardIds(boardIds: number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (boardIds.length === 0) return result;
  const rows = await db
    .select({
      boardId: dbSchema.boardseshTicks.boardId,
      lastSentAt: sql<Date | null>`max(${dbSchema.boardseshTicks.climbedAt})`,
    })
    .from(dbSchema.boardseshTicks)
    .where(inArray(dbSchema.boardseshTicks.boardId, boardIds))
    .groupBy(dbSchema.boardseshTicks.boardId);
  for (const row of rows) {
    if (row.boardId != null && row.lastSentAt) {
      result.set(Number(row.boardId), new Date(row.lastSentAt).toISOString());
    }
  }
  return result;
}

/**
 * Remember (per user) which board a serial routes to, so the disambiguation
 * prompt only appears once. Upserts `userBoardSerials.boardUuid` for the
 * (user, serial) pair. The config columns are NOT NULL, so we stamp the
 * board's own config (which is what the user connected to).
 */
export async function rememberBoardForSerial(
  userId: string,
  serial: string,
  board: Pick<SerialCandidateBoard, 'uuid' | 'boardType' | 'layoutId' | 'sizeId' | 'setIds'>,
): Promise<void> {
  await db
    .insert(dbSchema.userBoardSerials)
    .values({
      userId,
      serialNumber: serial,
      boardName: board.boardType,
      layoutId: board.layoutId,
      sizeId: board.sizeId,
      setIds: board.setIds,
      boardUuid: board.uuid,
    })
    .onConflictDoUpdate({
      target: [dbSchema.userBoardSerials.userId, dbSchema.userBoardSerials.serialNumber],
      set: { boardUuid: board.uuid, updatedAt: new Date() },
    });
}

export async function findActiveBoardById(boardId: number): Promise<ActivePresenceBoard | undefined> {
  const [board] = await db
    .select({
      id: dbSchema.userBoards.id,
      name: dbSchema.userBoards.name,
      boardType: dbSchema.userBoards.boardType,
      layoutId: dbSchema.userBoards.layoutId,
      sizeId: dbSchema.userBoards.sizeId,
      setIds: dbSchema.userBoards.setIds,
      serialNumber: dbSchema.userBoards.serialNumber,
      angle: dbSchema.userBoards.angle,
    })
    .from(dbSchema.userBoards)
    .where(and(eq(dbSchema.userBoards.id, boardId), isNull(dbSchema.userBoards.deletedAt)))
    .limit(1);
  return board;
}

export async function findReachableActiveBoardByUuid(
  userId: string | null,
  boardUuid: string,
): Promise<ActivePresenceBoard | undefined> {
  // Anonymous callers (board presence is auth-optional) can only reach public
  // boards; a logged-in caller additionally reaches the boards they own.
  const reachability = userId
    ? or(eq(dbSchema.userBoards.ownerId, userId), eq(dbSchema.userBoards.isPublic, true))
    : eq(dbSchema.userBoards.isPublic, true);
  const [board] = await db
    .select({
      id: dbSchema.userBoards.id,
      name: dbSchema.userBoards.name,
      boardType: dbSchema.userBoards.boardType,
      layoutId: dbSchema.userBoards.layoutId,
      sizeId: dbSchema.userBoards.sizeId,
      setIds: dbSchema.userBoards.setIds,
      serialNumber: dbSchema.userBoards.serialNumber,
      angle: dbSchema.userBoards.angle,
    })
    .from(dbSchema.userBoards)
    .where(and(eq(dbSchema.userBoards.uuid, boardUuid), isNull(dbSchema.userBoards.deletedAt), reachability))
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

/**
 * Bound anonymous reads of the live "now on the wall" feed (boardNowPlaying /
 * boardRecentClimbs / boardConnection) to boards an anonymous viewer is allowed
 * to see. Logged-in callers keep the pre-existing membership-free access to any
 * active board (a board's send feed is shared, leaderboard-style data among
 * authenticated users). Anonymous callers — who could otherwise enumerate the
 * sequential board ids — are restricted to **public** boards and the
 * system-owned shared per-config boards (the serial-less MoonBoard-style feeds
 * anon is first-class for). Throws the same `Board not found` as a missing board
 * so a private board's existence isn't revealed to anon. No-op for logged-in.
 */
export async function requireAnonReadableBoard(
  boardId: number,
  viewerUserId: string | null | undefined,
): Promise<void> {
  assertValidBoardId(boardId);
  if (viewerUserId) return;
  const [board] = await db
    .select({ isPublic: dbSchema.userBoards.isPublic, ownerId: dbSchema.userBoards.ownerId })
    .from(dbSchema.userBoards)
    .where(and(eq(dbSchema.userBoards.id, boardId), isNull(dbSchema.userBoards.deletedAt)))
    .limit(1);
  if (!board || (!board.isPublic && board.ownerId !== SYSTEM_BOARD_OWNER_ID)) {
    throw new GraphQLError('Board not found', { extensions: { code: 'NOT_FOUND' } });
  }
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
      boardType: dbSchema.userBoards.boardType,
      layoutId: dbSchema.userBoards.layoutId,
      sizeId: dbSchema.userBoards.sizeId,
      setIds: dbSchema.userBoards.setIds,
      serialNumber: dbSchema.userBoards.serialNumber,
      angle: dbSchema.userBoards.angle,
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
  return isUniqueViolation(error, 'user_boards_unique_owner_serial');
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

/**
 * The board's current connection holder, or null when the board is free. Single
 * source of truth for "who's connected + writing now": the live `boardConnection`
 * query and the APNs Live Activity push path both read it through here so the
 * holder + display-identity rules can never drift between the two surfaces.
 *
 * The holder is the emitter id of the most recent confirmed send
 * (`pubsub.getBoardWriter`): a `userId`, or `conn:{connectionId}` for an
 * anonymous client (reported with a null userId). Display identity is adopted
 * from the newest climb ONLY when that climb was sent by THIS holder — the
 * newest climb can belong to a previous sender (the current holder took the wall
 * but their send hasn't landed yet), and pairing their name with the holder's
 * userId would mislabel the avatar. When they don't match we still report the
 * holder's userId; clients render a "?".
 */
export async function resolveBoardHolder(boardId: number): Promise<BoardConnectionHolder | null> {
  const emitterId = await pubsub.getBoardWriter(String(boardId));
  if (emitterId === null) return null;
  const userId = emitterId.startsWith('conn:') ? null : emitterId;
  const recent = await pubsub.getRecentBoardClimbs(String(boardId));
  const last = recent[0];
  const lastBySameHolder = userId !== null && last?.sentByUserId === userId;
  return {
    userId,
    displayName: lastBySameHolder ? (last.sentByDisplayName ?? null) : null,
    avatarUrl: lastBySameHolder ? (last.sentByAvatarUrl ?? null) : null,
    lastSentAt: lastBySameHolder ? (last.sentAt ?? null) : null,
  };
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
  // Anonymous callers may only BIND an existing shared feed, never create one:
  // create-on-miss is the abuse vector (an unauthenticated client could vary
  // layoutId/sizeId/setIds to mint arbitrary system boards). A logged-in caller
  // creates the feed the first time a config is seen; anon then joins it.
  allowCreate = true,
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

  if (!allowCreate) {
    throw new GraphQLError('Board not found', { extensions: { code: 'NOT_FOUND' } });
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
