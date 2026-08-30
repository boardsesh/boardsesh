import { GraphQLError } from 'graphql';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { SQLWrapper } from 'drizzle-orm';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type { BoardConnectionHolder, ResolvedBoard } from '@boardsesh/shared-schema';
import { normaliseSetIds } from '@boardsesh/board-config';
import { executeRows } from '@boardsesh/db/client';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { pubsub } from '../../../pubsub/index';
import { logger } from '../../../utils/logger';
import { isUniqueViolation } from '../../../utils/postgres-errors';
import { assertKnownBoardConfig } from './board-catalog';
import { lockBoardSerialWrite, type BoardSerialWriteCommandDb } from '../board-serial-write-lock';

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

type BoardPresenceReadDb = Pick<typeof db, 'select'>;
type BoardPresenceWriteDb = Pick<typeof db, 'insert'>;
type BoardPresenceSerialTransactionDb = BoardPresenceReadDb & BoardSerialWriteCommandDb;

type ChosenBoardLookup = {
  board: ActivePresenceBoard;
  stalePointer?: { loserUuid: string; canonicalUuid: string };
};

/**
 * All active boards carrying this serial. Serials are no longer globally
 * unique (the supplier reuses them), so this can return many rows — the user
 * disambiguates. Oldest-first so the legacy auto-pick is deterministic.
 *
 * `advertisedBoardType` is the type in the connected controller's BLE device
 * name (`Tension Board#12345@3`). Aurora runs a separate serial sequence per
 * board app, so a Kilter `#12345` and a Tension `#12345` are different physical
 * controllers; when the caller knows the type, boards of any other type are not
 * candidates at all. Omitted by clients that predate the fix, which keep the old
 * type-blind behaviour.
 */
export async function findActiveBoardsBySerial(
  serial: string,
  readDb: BoardPresenceReadDb = db,
  advertisedBoardType?: string | null,
): Promise<SerialCandidateBoard[]> {
  const rows = await readDb
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
    .where(
      and(
        eq(dbSchema.userBoards.serialNumber, serial),
        isNull(dbSchema.userBoards.deletedAt),
        advertisedBoardType ? eq(dbSchema.userBoards.boardType, advertisedBoardType) : undefined,
      ),
    )
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
 *
 * `advertisedBoardType` scopes the lookup to the connected controller's type.
 * The pointer is stored per (user, board name, serial), and a remembered choice
 * for the Kilter `#12345` says nothing about the Tension `#12345` in front of
 * the climber — returning it would pin them to the wrong board on every connect,
 * because this short-circuits candidate resolution entirely.
 */
export async function findChosenBoardForSerial(
  userId: string,
  serial: string,
  advertisedBoardType?: string | null,
): Promise<ActivePresenceBoard | undefined> {
  // Keep the serial-first lookup read-only. Updating board_uuid would make the
  // FK acquire an implicit user_boards KEY SHARE lock after the serial lock,
  // inverting every row-changing writer's row→serial order.
  const lookup = await db.transaction(async (tx) => {
    await lockBoardSerialWrite(tx, serial);
    return findChosenBoardForSerialLocked(tx, userId, serial, advertisedBoardType);
  });

  if (!lookup) return undefined;
  if (lookup.stalePointer) {
    await healChosenBoardForSerial(userId, serial, lookup.stalePointer);
  }
  return lookup.board;
}

async function findChosenBoardForSerialLocked(
  transactionDb: BoardPresenceSerialTransactionDb,
  userId: string,
  serial: string,
  advertisedBoardType?: string | null,
): Promise<ChosenBoardLookup | undefined> {
  // Join the remembered pointer to its board WITHOUT the deletedAt filter: a
  // pointer left dangling at a merged-away loser must still surface here so we
  // can follow the tombstone. (The old inner-join on `deletedAt IS NULL`
  // silently dropped it, forcing a needless re-prompt.)
  const [row] = await transactionDb
    .select({
      id: dbSchema.userBoards.id,
      uuid: dbSchema.userBoards.uuid,
      name: dbSchema.userBoards.name,
      boardType: dbSchema.userBoards.boardType,
      layoutId: dbSchema.userBoards.layoutId,
      sizeId: dbSchema.userBoards.sizeId,
      setIds: dbSchema.userBoards.setIds,
      serialNumber: dbSchema.userBoards.serialNumber,
      angle: dbSchema.userBoards.angle,
      deletedAt: dbSchema.userBoards.deletedAt,
      mergedIntoBoardUuid: dbSchema.userBoards.mergedIntoBoardUuid,
    })
    .from(dbSchema.userBoardSerials)
    .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.uuid, dbSchema.userBoardSerials.boardUuid))
    .where(
      and(
        eq(dbSchema.userBoardSerials.userId, userId),
        eq(dbSchema.userBoardSerials.serialNumber, serial),
        isNotNull(dbSchema.userBoardSerials.boardUuid),
        // Pick the recording for the controller actually connected. Since
        // `user_board_serials` is keyed on (user, board name, serial), a user
        // who has connected both a Kilter and a Tension `#12345` now has two
        // rows, and an unscoped `.limit(1)` would choose between them at random.
        advertisedBoardType ? eq(dbSchema.userBoardSerials.boardName, advertisedBoardType) : undefined,
      ),
    )
    .limit(1);

  if (!row) return undefined;

  // Defense in depth for legacy rows: `board_name` is what the client reported
  // at connect time and the pointer was written separately, so the two can
  // disagree on data written before the serial-per-board-type fix. The board's
  // own type is authoritative — never hand back a board of the wrong type.
  if (advertisedBoardType && row.boardType !== advertisedBoardType) return undefined;

  // Active pointer: use it directly (the common case).
  if (!row.deletedAt) return { board: toActivePresenceBoard(row) };

  // The pointer landed on a merged-away loser: follow its tombstone to the
  // surviving canonical board. A plain soft-delete (no tombstone) is treated as
  // gone — return undefined so the caller falls through to the candidate list.
  const canonical = await followBoardMergeChain(row.mergedIntoBoardUuid, transactionDb);
  if (!canonical) return undefined;
  // The survivor is normally the same type as the loser, but a merge is human
  // data — re-check rather than trust the chain.
  if (advertisedBoardType && canonical.boardType !== advertisedBoardType) return undefined;

  return {
    board: toActivePresenceBoard(canonical),
    stalePointer: { loserUuid: row.uuid, canonicalUuid: canonical.uuid },
  };
}

/**
 * Heal a merged-away serial pointer without taking a board FK lock after the
 * serial advisory lock. The canonical row is locked first, then the serial is
 * locked and both facts that justified the heal are revalidated: the survivor
 * is still active and this user's pointer still targets the original loser.
 */
async function healChosenBoardForSerial(
  userId: string,
  serial: string,
  { loserUuid, canonicalUuid }: { loserUuid: string; canonicalUuid: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT id
        FROM user_boards
       WHERE uuid = ${canonicalUuid}
       FOR UPDATE
    `);
    await lockBoardSerialWrite(tx, serial);

    const [canonical] = await tx
      .select({ deletedAt: dbSchema.userBoards.deletedAt })
      .from(dbSchema.userBoards)
      .where(eq(dbSchema.userBoards.uuid, canonicalUuid))
      .limit(1);
    if (!canonical || canonical.deletedAt) return;

    await tx
      .update(dbSchema.userBoardSerials)
      .set({ boardUuid: canonicalUuid, updatedAt: new Date() })
      .where(
        and(
          eq(dbSchema.userBoardSerials.userId, userId),
          eq(dbSchema.userBoardSerials.serialNumber, serial),
          eq(dbSchema.userBoardSerials.boardUuid, loserUuid),
        ),
      );
  });
}

function toActivePresenceBoard(row: ActivePresenceBoard): ActivePresenceBoard {
  return {
    id: Number(row.id),
    name: row.name,
    boardType: row.boardType,
    layoutId: Number(row.layoutId),
    sizeId: Number(row.sizeId),
    setIds: row.setIds,
    serialNumber: row.serialNumber,
    angle: Number(row.angle),
  };
}

/**
 * Follow a merge tombstone (≤3 hops, bounded so a cyclic/broken chain can't
 * spin) to the surviving canonical board. Returns undefined when the pointer is
 * null, the chain is broken, or it ends at an ordinary (non-merge) soft-delete.
 *
 * The single tombstone-walk implementation — the social board resolvers wrap
 * this too, so the hop bound and termination rules can't drift between lookup
 * paths.
 */
export async function followBoardMergeChain(
  startUuid: string | null,
  readDb: BoardPresenceReadDb = db,
): Promise<typeof dbSchema.userBoards.$inferSelect | undefined> {
  let nextUuid = startUuid;
  for (let hop = 0; hop < 3 && nextUuid; hop++) {
    const [candidate] = await readDb
      .select()
      .from(dbSchema.userBoards)
      .where(eq(dbSchema.userBoards.uuid, nextUuid))
      .limit(1);
    if (!candidate) {
      // The tombstone column has no FK, so a dangling pointer would otherwise
      // be indistinguishable from a plain soft-delete — surface it for oncall.
      logger.warn(`[board-merge] tombstone chain from ${startUuid} dangles at missing board ${nextUuid}`);
      return undefined;
    }
    if (!candidate.deletedAt) return candidate;
    nextUuid = candidate.mergedIntoBoardUuid;
  }
  if (nextUuid) {
    // Should be unreachable: the dedupe script flattens chains to depth 1 on
    // every merge. A chain this deep means a script bug — make it visible
    // rather than reading like a plain soft-delete.
    logger.warn(`[board-merge] tombstone chain from ${startUuid} exceeded the hop limit at ${nextUuid}`);
  }
  return undefined;
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
 * (user, board name, serial) triple — Aurora reuses a serial across board apps,
 * so the Kilter `#12345` and the Tension `#12345` each get their own pointer.
 * The config columns are NOT NULL, so we stamp the board's own config (which is
 * what the user connected to).
 */
export async function rememberBoardForSerial(
  userId: string,
  serial: string,
  board: Pick<SerialCandidateBoard, 'uuid' | 'boardType' | 'layoutId' | 'sizeId' | 'setIds'>,
  writeDb: BoardPresenceWriteDb = db,
): Promise<void> {
  await writeDb
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
      // Must match `user_board_serials_unique_user_serial` exactly, or Postgres
      // rejects the statement with 42P10 (no matching arbiter index).
      target: [
        dbSchema.userBoardSerials.userId,
        dbSchema.userBoardSerials.boardName,
        dbSchema.userBoardSerials.serialNumber,
      ],
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
  // Load the requested row even when it is soft-deleted: a merge tombstone is
  // a durable redirect for stale mobile selections. Ordinary soft-deletes still
  // resolve to nothing because they have no merge pointer.
  const [requested] = await db
    .select()
    .from(dbSchema.userBoards)
    .where(eq(dbSchema.userBoards.uuid, boardUuid))
    .limit(1);
  if (!requested) return undefined;

  const canonical = requested.deletedAt ? await followBoardMergeChain(requested.mergedIntoBoardUuid) : requested;
  if (!canonical) return undefined;

  // Reachability is deliberately evaluated on the canonical board, never the
  // stale loser. Owning a private loser must not grant access to another
  // owner's private survivor; anonymous callers can only reach public boards.
  if (!canonical.isPublic && canonical.ownerId !== userId) return undefined;

  return toActivePresenceBoard(canonical);
}

/**
 * The board configuration a tick names: the board type it was logged against
 * plus the layout/size/set triple from the route it was logged from. The three
 * config fields are optional on the wire (`SaveTickInputSchema`), so a caller
 * can omit them entirely.
 */
export interface TickBoardConfigTarget {
  boardType: string;
  layoutId?: number | null;
  sizeId?: number | null;
  setIds?: string | null;
}

/**
 * Does a board's stored configuration match the one a tick names?
 *
 * Every board-resolution rung in `saveTick` accepts a candidate board only when
 * its FULL config (type + layout + size + set) matches the tick's — otherwise a
 * stale id/uuid stamps the tick onto the wrong wall and corrupts that board's
 * stats and leaderboards. Set ids are compared normalized so order/format
 * differences don't reject a real match.
 *
 * A tick that carries no layout/size/set matches nothing: without a config
 * there is nothing to check, and accepting it would reopen the bypass this gate
 * exists to close.
 */
export function boardConfigMatchesTick(
  board: Pick<ActivePresenceBoard, 'boardType' | 'layoutId' | 'sizeId' | 'setIds'> | null | undefined,
  target: TickBoardConfigTarget,
): boolean {
  if (!board) return false;
  if (target.layoutId == null || target.sizeId == null || !target.setIds) return false;
  return (
    board.boardType === target.boardType &&
    board.layoutId === target.layoutId &&
    board.sizeId === target.sizeId &&
    normaliseSetIds(board.setIds) === normaliseSetIds(target.setIds)
  );
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

/**
 * The caller's own live board for this config — preferring the one this serial
 * should bind to.
 *
 * An owner can hold several boards of one configuration since #4166 dropped the
 * per-owner config unique index (the same MoonBoard 2024 at home and at a gym).
 * This was `.limit(1)` with no ordering, so with two such boards the pick was
 * arbitrary and the serial-bind caller would either refuse to connect — throwing
 * "already linked to another wall serial" because it happened to pick the board
 * bound to the OTHER controller — or stamp this wall's serial onto the wrong
 * board, silently misattributing every later presence event and tick.
 *
 * Ordering makes it deterministic and correct:
 *   1. already bound to `preferredSerial` — the board actually being connected;
 *   2. unbound — free to take this serial;
 *   3. bound to a different serial — reached only when nothing better exists,
 *      which is the genuine "already linked elsewhere" case.
 * `id` breaks remaining ties so repeat calls agree with each other.
 */
export async function findOwnActiveBoardByConfig(
  ownerId: string,
  boardType: string,
  layoutId: number,
  sizeId: number,
  setIds: string,
  preferredSerial?: string,
  readDb: BoardPresenceReadDb = db,
): Promise<ActivePresenceBoard | undefined> {
  const normalizedSetIds = normaliseSetIds(setIds);
  const [board] = await readDb
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
    .orderBy(
      sql`CASE
            WHEN ${preferredSerial ?? null}::text IS NOT NULL
             AND ${dbSchema.userBoards.serialNumber} = ${preferredSerial ?? null}::text THEN 0
            WHEN ${dbSchema.userBoards.serialNumber} IS NULL THEN 1
            ELSE 2
          END`,
      asc(dbSchema.userBoards.id),
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
  woods: 'Woods',
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
 * Reserve a board-presence sequence in PostgreSQL. `candidate` normally comes
 * from Redis INCR, but Redis is only an acceleration layer: this row update is
 * the authority and serializes against the board-row locks taken by the serial
 * dedupe. Existing durable history is included for rows created before the
 * counter migration was deployed.
 *
 * An allocation waiting behind a merge re-checks `deleted_at` after the row
 * lock is released. A merged-away loser therefore fails closed instead of
 * publishing another event under an obsolete board id.
 */
export type BoardPresenceSeqCommandDb = {
  execute(query: SQLWrapper | string): PromiseLike<unknown>;
};

export async function reserveBoardPresenceSeq(
  commandDb: BoardPresenceSeqCommandDb,
  boardId: number,
  candidate: number,
): Promise<number> {
  const [row] = await executeRows<{ seq: number | string }>(
    commandDb,
    sql`
      UPDATE user_boards
         SET presence_seq = GREATEST(
           presence_seq + 1,
           ${candidate},
           COALESCE((
             SELECT max(seq) + 1
               FROM board_climb_events
              WHERE board_id = ${boardId}
           ), 1)
         )
       WHERE id = ${boardId}
         AND deleted_at IS NULL
       RETURNING presence_seq AS seq
    `,
  );

  if (!row) {
    throw new GraphQLError('Board not found', { extensions: { code: 'NOT_FOUND' } });
  }
  return Number(row.seq);
}

export async function allocateBoardPresenceSeq(boardId: number, candidate: number): Promise<number> {
  return reserveBoardPresenceSeq(db, boardId, candidate);
}

/**
 * Legacy durable floor lookup retained for isolated pubsub tests and callers
 * that have not installed the authoritative allocator. The running server
 * wires `allocateBoardPresenceSeq` instead.
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
  const normalizedSetIds = normaliseSetIds(setIds);
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
