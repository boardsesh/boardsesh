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
import { assertKnownBoardConfig } from './board-catalog';

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

/** A board the caller had selected when they connected, plus what the serial claim needs. */
export type SelectedConnectBoard = ActivePresenceBoard & { uuid: string; ownerId: string };

/** Whether any synced gym listing already carries this serial. */
export async function hasSyncedGymBoardForSerial(serial: string): Promise<boolean> {
  const [board] = await db
    .select({ id: dbSchema.userBoards.id })
    .from(dbSchema.userBoards)
    .where(
      and(
        eq(dbSchema.userBoards.serialNumber, serial),
        isNull(dbSchema.userBoards.deletedAt),
        eq(dbSchema.userBoards.ownerId, SYSTEM_BOARD_OWNER_ID),
        isNotNull(dbSchema.userBoards.gymId),
      ),
    )
    .limit(1);
  return board !== undefined;
}

/**
 * The board the caller already had selected when the BLE connect landed (the
 * map finder / board picker choice), when it is reachable, active, and
 * genuinely describes the wall they just plugged into.
 *
 * The config equality check is what makes this safe to trust over serial
 * matching: a selection whose board type / layout / size / hold sets don't
 * match what the controller advertised is stale (they picked one wall and
 * walked to another), so the serial stays authoritative there. Set ids are
 * compared through `normalizeSetIds` because synced catalog boards store the
 * upstream string verbatim while our own writers store the canonical form.
 */
export async function findSelectedBoardForConnect(
  userId: string,
  boardUuid: string,
  config: { boardType: string; layoutId: number; sizeId: number; setIds: string },
): Promise<SelectedConnectBoard | undefined> {
  const [board] = await db
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
    })
    .from(dbSchema.userBoards)
    .where(
      and(
        eq(dbSchema.userBoards.uuid, boardUuid),
        isNull(dbSchema.userBoards.deletedAt),
        // Same reachability rule as findReachableActiveBoardByUuid: the caller
        // reaches public boards plus their own.
        or(eq(dbSchema.userBoards.ownerId, userId), eq(dbSchema.userBoards.isPublic, true)),
      ),
    )
    .limit(1);
  if (!board) return undefined;
  if (
    board.boardType !== config.boardType ||
    Number(board.layoutId) !== config.layoutId ||
    Number(board.sizeId) !== config.sizeId ||
    normalizeSetIds(board.setIds) !== normalizeSetIds(config.setIds)
  ) {
    return undefined;
  }
  return { ...board, id: Number(board.id), layoutId: Number(board.layoutId), sizeId: Number(board.sizeId) };
}

/**
 * Whether the caller's selected board should beat serial matching.
 *
 * A gym's own listing always wins when it already carries the serial: that
 * listing IS the wall, whereas a selection is only a hint about it (most
 * personal boards are the auto-named onboarding template, which travels with
 * the climber between gyms). The selection therefore only decides when no gym
 * listing claims the serial — which is exactly the wrong-board case this
 * function exists for, since most synced gym boards carry no serial at all
 * until a connect claims one for them.
 *
 * Deliberately makes no exception for a selection that already carries the
 * serial. Serials are reused across real gyms — 10 of them in production span
 * 4 km to 7,400 km — and there is no way to tell from a serial alone which of
 * those walls someone is standing at. Falling through hands those cases to
 * `findActiveBoardsBySerial`, which returns every match and lets the client
 * prompt; the pick is then remembered per user, so the prompt appears once.
 * Guessing silently is how the wrong-board bug looked to a climber.
 */
export async function selectionBeatsSerialMatch(_board: SelectedConnectBoard, serial: string): Promise<boolean> {
  return !(await hasSyncedGymBoardForSerial(serial));
}

/**
 * Whether a connect may stamp its controller serial onto this board. Limited to
 * the caller's own boards and the system-owned synced catalog: a gym listing we
 * mirror is exactly the row that should learn its serial, whereas letting
 * anyone brand a stranger's board would redirect that serial for every climber
 * who connects to it afterwards.
 */
export function canClaimSerialForBoard(board: Pick<SelectedConnectBoard, 'ownerId'>, userId: string): boolean {
  return board.ownerId === userId || board.ownerId === SYSTEM_BOARD_OWNER_ID;
}

/**
 * Stamp a controller serial onto a board that carries none, so the next
 * climber's connect resolves straight to it instead of minting a private
 * duplicate. `WHERE serial_number IS NULL` makes a concurrent claim fail-safe —
 * the loser re-reads and binds the same board either way.
 *
 * Returns the refreshed board. Never throws on the per-owner duplicate-serial
 * index: if the caller already has this serial on another of their boards the
 * claim is simply skipped and the board is returned unchanged, because binding
 * to the selected board still has to succeed.
 */
export async function claimSerialForBoard(board: SelectedConnectBoard, serial: string): Promise<SelectedConnectBoard> {
  try {
    const [updated] = await db
      .update(dbSchema.userBoards)
      .set({ serialNumber: serial, updatedAt: new Date() })
      .where(
        and(
          eq(dbSchema.userBoards.id, board.id),
          isNull(dbSchema.userBoards.serialNumber),
          isNull(dbSchema.userBoards.deletedAt),
        ),
      )
      .returning({ serialNumber: dbSchema.userBoards.serialNumber });
    if (updated) {
      return { ...board, serialNumber: updated.serialNumber };
    }
  } catch (error) {
    if (!isDuplicateBoardSerialError(error)) {
      throw error;
    }
    logger.warn(`[board-presence] serial claim skipped, already bound elsewhere: ${String(error)}`);
    return board;
  }
  // Lost the `serial_number IS NULL` race — re-read what the winner wrote so
  // the caller reports the board's real serial.
  const [current] = await db
    .select({ serialNumber: dbSchema.userBoards.serialNumber })
    .from(dbSchema.userBoards)
    .where(eq(dbSchema.userBoards.id, board.id))
    .limit(1);
  return { ...board, serialNumber: current?.serialNumber ?? board.serialNumber };
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
    // NOT_FOUND matches requireAnonReadableBoard's mask below, so a missing
    // board and a private board masked from an anonymous viewer produce the
    // identical error shape (message + extensions.code) on the wire.
    throw new GraphQLError('Board not found', { extensions: { code: 'NOT_FOUND' } });
  }
  return board;
}

export type BoardVisibility = Pick<typeof dbSchema.userBoards.$inferSelect, 'isPublic' | 'ownerId'>;

/**
 * THE anonymous board-visibility rule, applied to a board row already in hand:
 * a **public** board, or a system-owned shared per-config board (the serial-less
 * MoonBoard-style feeds anon is first-class for). Viewer-independent.
 *
 * Every board read reachable without a session MUST route its anonymous gate
 * through this one predicate — `isBoardAnonReadable` (by id),
 * `assertAnonReadableBoard` (throwing), and the `board(boardUuid)` entity read
 * all call it, so a private board can never be visible on one anonymous surface
 * and hidden on another.
 *
 * `isUnlisted` is deliberately NOT part of the rule: unlisted means "reachable
 * by direct link, never enumerated", so an unlisted-but-public board stays
 * readable by uuid. Enumerating reads (searchBoards, gymBoards) filter unlisted
 * separately.
 */
export function isRowAnonReadable(board: BoardVisibility): boolean {
  return board.isPublic || board.ownerId === SYSTEM_BOARD_OWNER_ID;
}

/**
 * `isRowAnonReadable` for a board identified by id — for callers that don't
 * already hold the row. Also the publish gate for the board-queue-preview
 * producer, which has no viewer at all. False for missing/deleted boards.
 */
export async function isBoardAnonReadable(boardId: number): Promise<boolean> {
  assertValidBoardId(boardId);
  const [board] = await db
    .select({ isPublic: dbSchema.userBoards.isPublic, ownerId: dbSchema.userBoards.ownerId })
    .from(dbSchema.userBoards)
    .where(and(eq(dbSchema.userBoards.id, boardId), isNull(dbSchema.userBoards.deletedAt)))
    .limit(1);
  return Boolean(board && isRowAnonReadable(board));
}

/**
 * Bound anonymous reads of the live "now on the wall" feed (boardNowPlaying /
 * boardRecentClimbs / boardConnection) to boards an anonymous viewer is allowed
 * to see. Logged-in callers keep the pre-existing membership-free access to any
 * active board (a board's send feed is shared, leaderboard-style data among
 * authenticated users). Anonymous callers — who could otherwise enumerate the
 * sequential board ids — are restricted to the `isBoardAnonReadable` set.
 * Throws the same `Board not found` as a missing board so a private board's
 * existence isn't revealed to anon. No-op for logged-in.
 *
 * Returns whether anon-readability was actually VERIFIED — true only on the
 * anonymous path (where not throwing means `isBoardAnonReadable` held), false
 * for logged-in viewers (nothing was checked). Callers that re-apply the same
 * viewer-independent gate downstream (boardQueuePreview) use it to skip a
 * duplicate `isBoardAnonReadable` query — never treat `false` as "not
 * readable", only as "not verified here".
 */
export async function requireAnonReadableBoard(
  boardId: number,
  viewerUserId: string | null | undefined,
): Promise<boolean> {
  assertValidBoardId(boardId);
  if (viewerUserId) return false;
  if (!(await isBoardAnonReadable(boardId))) {
    throw new GraphQLError('Board not found', { extensions: { code: 'NOT_FOUND' } });
  }
  return true;
}

/**
 * Same shape as `requireActiveBoardById`, plus the `isPublic`/`ownerId`
 * columns `requireAnonReadableBoard` needs. Callers that need both checks
 * (`boardHistory`, `boardPresenceStats`, `boardRecentClimbs`) can do a single
 * indexed by-id lookup and pass the row to `assertAnonReadableBoard` instead
 * of `requireActiveBoardById` + `requireAnonReadableBoard` issuing two
 * separate round-trips for the same row on every anonymous request.
 */
export async function requireActiveBoardWithVisibilityById(
  boardId: number,
): Promise<ActivePresenceBoard & BoardVisibility> {
  assertValidBoardId(boardId);
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
      isPublic: dbSchema.userBoards.isPublic,
      ownerId: dbSchema.userBoards.ownerId,
    })
    .from(dbSchema.userBoards)
    .where(and(eq(dbSchema.userBoards.id, boardId), isNull(dbSchema.userBoards.deletedAt)))
    .limit(1);
  if (!board) {
    // Same NOT_FOUND shape as requireActiveBoardById — see that function's
    // comment for why the extensions.code matters here.
    throw new GraphQLError('Board not found', { extensions: { code: 'NOT_FOUND' } });
  }
  return board;
}

/**
 * `requireAnonReadableBoard`'s gate, applied to a board row already loaded via
 * `requireActiveBoardWithVisibilityById` instead of re-querying by id. Same
 * masking behaviour: no-op for logged-in callers, NOT_FOUND for anonymous
 * callers on a non-public board that isn't system-owned.
 */
export function assertAnonReadableBoard(board: BoardVisibility, viewerUserId: string | null | undefined): void {
  if (viewerUserId) return;
  if (!isRowAnonReadable(board)) {
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

/**
 * Durable seq floor for a board: the highest `seq` ever persisted to
 * `board_climb_events`. Backs the Redis `board:{id}:seq` counter's dormancy
 * reseed (see `PubSub.nextBoardSeq` / A3) — after the 1-week Redis TTL
 * expires, INCR would otherwise restart at 1 and collide with / precede rows
 * that still exist in Postgres. Injected via `pubsub.setBoardSeqFloorProvider`
 * at backend bootstrap so the pubsub module itself stays DB-free (and easy to
 * unit test without Postgres).
 */
export async function getBoardSeqFloor(boardId: number): Promise<number> {
  const [row] = await db
    .select({ maxSeq: sql<number | null>`max(${dbSchema.boardClimbEvents.seq})` })
    .from(dbSchema.boardClimbEvents)
    .where(eq(dbSchema.boardClimbEvents.boardId, boardId));
  return Number(row?.maxSeq ?? 0);
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

  await assertKnownBoardConfig(boardType, layoutId, sizeId, setIds);
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
