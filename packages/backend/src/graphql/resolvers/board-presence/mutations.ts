import { v4 as uuidv4 } from 'uuid';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type {
  ConnectionContext,
  ClimbQueueItemInput,
  ResolvedBoard,
  BoardPresenceClimb,
} from '@boardsesh/shared-schema';
import { normaliseSetIds } from '@boardsesh/board-config';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import { BoardSerialSchema, UUIDSchema } from '../../../validation/schemas/primitives';
import {
  AdvertisedBoardTypeSchema,
  BoardPresenceAngleSchema,
  BoardPresenceConfigInputSchema,
  ReportBoardClimbInputSchema,
} from '../../../validation/schemas';
import { generateUniqueSlug } from '../social/boards';
import { assertBoardCapNotReached } from '../social/board-limits';
import { assertKnownBoardConfig } from './board-catalog';
import { lockBoardSerialWrite } from '../board-serial-write-lock';
import { logger } from '../../../utils/logger';
import { pubsub } from '../../../pubsub/index';
import { roomManager } from '../../../services/room-manager';
import { isApnsConfigured, sendLiveActivityUpdate } from '../../../services/apns';
import { buildContentStateFromQueueState } from '../../../services/apns/content-state';
import { publishBoardQueuePreviewForSession } from '../../../services/board-queue-preview';
import {
  assertValidBoardId,
  candidateToActiveBoard,
  defaultBoardName,
  findActiveBoardsBySerial,
  findChosenBoardForSerial,
  findOwnActiveBoardByConfig,
  findReachableActiveBoardByUuid,
  isDuplicateBoardSerialError,
  lastSentAtByBoardIds,
  rememberBoardForSerial,
  reserveBoardPresenceSeq,
  requireActiveBoardById,
  resolveSharedBoardForConfig,
  serialAlreadyBoundError,
  throwIfDuplicateBoardSerial,
  toResolvedBoard,
  type ActivePresenceBoard,
  type SerialCandidateBoard,
} from './shared';

type SerialResolution =
  | { kind: 'board'; board: ActivePresenceBoard }
  | { kind: 'candidates'; candidates: SerialCandidateBoard[] };

type SerialResolutionAttempt = SerialResolution | { kind: 'retry' };

const SERIAL_RESOLUTION_MAX_ATTEMPTS = 3;

/**
 * Validate the board type advertised by the connected controller. Returns
 * `undefined` when the caller omitted it (every client shipped before the
 * serial-per-board-type fix), which leaves serial resolution type-blind exactly
 * as it was.
 */
function validateAdvertisedBoardType(advertisedBoardType: string | null | undefined): string | undefined {
  if (advertisedBoardType == null) return undefined;
  return validateInput(AdvertisedBoardTypeSchema, advertisedBoardType, 'advertisedBoardType') ?? undefined;
}

type BoardCandidatePayload = {
  boardId: number;
  boardUuid: string;
  boardName: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  locationName: string | null;
  gymName: string | null;
  isOwnedByMe: boolean;
  isPublic: boolean;
  lastSentAt: string | null;
};

type DurableBoardClimbEventInput = {
  boardId: number;
  boardType: string;
  climbUuid: string;
  angle: number;
  userId: string;
  sessionId: null;
  frames: string | null;
  name: string | null;
  grade: string | null;
  setter: string | null;
  confirmedAt: string;
};

class DurableBoardClimbPersistenceError extends Error {
  constructor(readonly persistenceCause: unknown) {
    super('Failed to persist durable board climb event');
    this.name = 'DurableBoardClimbPersistenceError';
  }
}

/**
 * Reserve the authoritative sequence and insert its durable event before the
 * board-row lock is released. The dedupe locks that same row before moving
 * events and tombstoning losers, so either it sees/moves this event or this
 * reservation resumes after the merge and fails the active-row predicate.
 */
export async function reserveAndPersistBoardClimbEvent(
  input: DurableBoardClimbEventInput,
  candidate: number,
): Promise<number> {
  try {
    return await db.transaction(async (tx) => {
      const seq = await reserveBoardPresenceSeq(tx, input.boardId, candidate);
      await tx.insert(dbSchema.boardClimbEvents).values({ ...input, seq });
      return seq;
    });
  } catch (error) {
    // Preserve the authoritative tombstone signal so reportBoardClimb fails a
    // stale request instead of falling back and publishing on the loser.
    if (error instanceof GraphQLError && error.extensions.code === 'NOT_FOUND') throw error;
    throw new DurableBoardClimbPersistenceError(error);
  }
}

type BoardPresenceCommandDb = Pick<typeof db, 'select' | 'update' | 'insert'>;

function toBoardCandidate(
  candidate: SerialCandidateBoard,
  userId: string,
  lastSentAt: string | null,
): BoardCandidatePayload {
  const isOwnedByMe = candidate.ownerId === userId;
  // Private boards are still findable by serial, but we don't leak their
  // location to people who neither own them nor would see them publicly.
  const showLocation = candidate.isPublic || isOwnedByMe;
  return {
    boardId: candidate.id,
    boardUuid: candidate.uuid,
    boardName: candidate.name,
    boardType: candidate.boardType,
    layoutId: candidate.layoutId,
    sizeId: candidate.sizeId,
    setIds: candidate.setIds,
    locationName: showLocation ? candidate.locationName : null,
    gymName: showLocation ? candidate.gymName : null,
    isOwnedByMe,
    isPublic: candidate.isPublic,
    lastSentAt,
  };
}

/**
 * No board carries this serial yet: bind it onto the caller's own board for
 * this config, or create a fresh owned board. (Branches (b)+(c) of the old
 * resolver.)
 *
 * The caller may own SEVERAL boards of this config since #4166 (the same wall at
 * home and at a gym), so `findOwnActiveBoardByConfig` gets the serial and returns
 * the board this one should bind to — already bound to it, else unbound, else one
 * bound elsewhere. Without that preference the pick was arbitrary, and this could
 * refuse to connect a perfectly bindable board or stamp the serial onto the wrong
 * one. The same-owner bind race stays fail-safe via `user_boards_unique_owner_serial`
 * (the per-owner *config* index this comment used to cite is gone).
 */
async function bindOrCreateOwnBoardForSerial(
  commandDb: BoardPresenceCommandDb,
  userId: string,
  serial: string,
  config: { boardType: string; layoutId: number; sizeId: number; setIds: string },
): Promise<ActivePresenceBoard> {
  const ownBoard = await findOwnActiveBoardByConfig(
    userId,
    config.boardType,
    config.layoutId,
    config.sizeId,
    config.setIds,
    serial,
    commandDb,
  );
  if (ownBoard) {
    if (ownBoard.serialNumber && ownBoard.serialNumber !== serial) {
      throw serialAlreadyBoundError();
    }
    try {
      const [updated] = await commandDb
        .update(dbSchema.userBoards)
        .set({ serialNumber: serial, updatedAt: new Date() })
        .where(and(eq(dbSchema.userBoards.id, ownBoard.id), isNull(dbSchema.userBoards.serialNumber)))
        .returning();
      if (updated) {
        return updated;
      }
    } catch (error) {
      if (isDuplicateBoardSerialError(error)) {
        logger.warn(`[board-presence] bind race on own board: ${String(error)}`);
        const winner = await findOwnActiveBoardByConfig(
          userId,
          config.boardType,
          config.layoutId,
          config.sizeId,
          config.setIds,
          serial,
          commandDb,
        );
        if (winner?.serialNumber === serial) {
          return winner;
        }
      }
      throw error;
    }
    const refreshed = await findOwnActiveBoardByConfig(
      userId,
      config.boardType,
      config.layoutId,
      config.sizeId,
      config.setIds,
      serial,
      commandDb,
    );
    if (refreshed?.serialNumber === serial) {
      return refreshed;
    }
    if (refreshed?.serialNumber) {
      throw serialAlreadyBoundError();
    }
  }

  // Only the create branch is capped. Binding a serial onto a board the caller
  // already owns adds no row, so an account at the cap must still be able to
  // connect to the walls it has.
  await assertBoardCapNotReached(userId);

  await assertKnownBoardConfig(config.boardType, config.layoutId, config.sizeId, config.setIds);
  const uuid = uuidv4();
  const name = defaultBoardName(config.boardType);
  const slug = await generateUniqueSlug(name);
  try {
    const [created] = await commandDb
      .insert(dbSchema.userBoards)
      .values({
        uuid,
        slug,
        ownerId: userId,
        boardType: config.boardType,
        layoutId: config.layoutId,
        sizeId: config.sizeId,
        setIds: normaliseSetIds(config.setIds),
        name,
        serialNumber: serial,
      })
      .returning();
    return created;
  } catch (error) {
    if (isDuplicateBoardSerialError(error)) {
      logger.warn(`[board-presence] create race on own board: ${String(error)}`);
      const winner = await findOwnActiveBoardByConfig(
        userId,
        config.boardType,
        config.layoutId,
        config.sizeId,
        config.setIds,
        serial,
        commandDb,
      );
      if (winner?.serialNumber === serial) {
        return winner;
      }
    }
    throwIfDuplicateBoardSerial(error);
    throw error;
  }
}

async function planActiveBoardsForSerial(
  serial: string,
  advertisedBoardType?: string | null,
): Promise<SerialCandidateBoard[]> {
  return findActiveBoardsBySerial(serial, db, advertisedBoardType);
}

function selectResolvedSerialCandidate(
  candidates: SerialCandidateBoard[],
  userId: string,
  autoPickMultiple: boolean,
): SerialCandidateBoard | undefined {
  if (candidates.length === 1) return candidates[0];
  if (!autoPickMultiple) return undefined;
  return candidates.find((candidate) => candidate.ownerId === userId) ?? candidates[0];
}

function haveSameSerialCandidateIds(candidates: SerialCandidateBoard[], plannedBoardIds: number[]): boolean {
  return (
    candidates.length === plannedBoardIds.length &&
    candidates.every((candidate, candidateIndex) => candidate.id === plannedBoardIds[candidateIndex])
  );
}

async function resolveEmptySerialPlan(
  userId: string,
  serial: string,
  config: { boardType: string; layoutId: number; sizeId: number; setIds: string },
  autoPickMultiple: boolean,
  advertisedBoardType?: string | null,
): Promise<SerialResolutionAttempt> {
  return db.transaction(async (tx): Promise<SerialResolutionAttempt> => {
    // The zero-candidate path may bind this config-matching row, so lock it
    // before the serial. If a candidate appeared after planning, never lock it
    // after the serial: return a stable prompt or replan outside this tx.
    await tx.execute(sql`
      SELECT id
        FROM user_boards
       WHERE owner_id = ${userId}
         AND board_type = ${config.boardType}
         AND layout_id = ${config.layoutId}
         AND size_id = ${config.sizeId}
         AND set_ids = ${normaliseSetIds(config.setIds)}
         AND deleted_at IS NULL
       ORDER BY id
       LIMIT 1
       FOR UPDATE
    `);
    await lockBoardSerialWrite(tx, serial);

    const candidates = await findActiveBoardsBySerial(serial, tx, advertisedBoardType);
    if (candidates.length > 0) {
      if (!autoPickMultiple && candidates.length > 1) {
        return { kind: 'candidates', candidates };
      }
      return { kind: 'retry' };
    }

    // Nothing carries this serial. Binding or creating uses `config`, which is
    // the ROUTE the climber is on — fine when that is also what connected, but
    // not when the controller announced a different board type. That happens on
    // the picker's "Connect anyway" path: connecting a Tension box while on a
    // Kilter setup would otherwise stamp the Tension serial onto a Kilter board
    // and route every later tick and presence event there.
    //
    // We can't create the right board either: `config` carries the route's
    // layout/size/sets, which describe nothing on the connected wall. So bind
    // nothing and say so. The client treats an empty candidate list as "no
    // board" and simply skips presence for this connection — the wall still
    // lights up, it just isn't attributed to a board.
    if (advertisedBoardType && advertisedBoardType !== config.boardType) {
      return { kind: 'candidates', candidates: [] };
    }

    const board = await bindOrCreateOwnBoardForSerial(tx, userId, serial, config);
    return { kind: 'board', board };
  });
}

async function resolvePlannedSerialCandidate(
  userId: string,
  serial: string,
  plannedBoardId: number,
  plannedBoardIds: number[],
  autoPickMultiple: boolean,
  advertisedBoardType?: string | null,
): Promise<SerialResolutionAttempt> {
  return db.transaction(async (tx): Promise<SerialResolutionAttempt> => {
    // The pointer FK takes KEY SHARE on this parent row. Lock the exact planned
    // candidate before the serial so a concurrent row→serial writer can never
    // form an advisory-lock/FK cycle with this transaction.
    await tx.execute(sql`
      SELECT id
        FROM user_boards
       WHERE id = ${plannedBoardId}
       FOR UPDATE
    `);
    await lockBoardSerialWrite(tx, serial);

    const candidates = await findActiveBoardsBySerial(serial, tx, advertisedBoardType);
    if (!autoPickMultiple && candidates.length > 1) {
      return { kind: 'candidates', candidates };
    }
    if (!haveSameSerialCandidateIds(candidates, plannedBoardIds)) {
      return { kind: 'retry' };
    }

    const candidate = selectResolvedSerialCandidate(candidates, userId, autoPickMultiple);
    if (!candidate || candidate.id !== plannedBoardId) {
      return { kind: 'retry' };
    }

    await rememberBoardForSerial(userId, serial, candidate, tx);
    return { kind: 'board', board: candidateToActiveBoard(candidate) };
  });
}

/**
 * Decide which board a serial routes to for this user:
 *  - a previously-remembered choice wins (no prompt);
 *  - no board carries the serial yet → bind/create the caller's own board;
 *  - exactly one board carries it → route there (and remember);
 *  - several boards carry it → return the candidates for the user to pick.
 */
async function resolveSerialForUser(
  userId: string,
  serial: string,
  config: { boardType: string; layoutId: number; sizeId: number; setIds: string },
  options: { autoPickMultiple?: boolean; advertisedBoardType?: string | null } = {},
): Promise<SerialResolution> {
  // The type the controller advertises over BLE. Every read below is scoped to
  // it, because Aurora reuses a serial across board apps and a board of another
  // type is a different physical controller, not a candidate.
  const { advertisedBoardType } = options;
  const chosen = await findChosenBoardForSerial(userId, serial, advertisedBoardType);
  if (chosen) {
    return { kind: 'board', board: chosen };
  }

  const autoPickMultiple = options.autoPickMultiple ?? false;
  for (let attempt = 0; attempt < SERIAL_RESOLUTION_MAX_ATTEMPTS; attempt++) {
    const plannedCandidates = await planActiveBoardsForSerial(serial, advertisedBoardType);
    if (!autoPickMultiple && plannedCandidates.length > 1) {
      return { kind: 'candidates', candidates: plannedCandidates };
    }

    const plannedCandidate = selectResolvedSerialCandidate(plannedCandidates, userId, autoPickMultiple);
    const resolution = plannedCandidate
      ? await resolvePlannedSerialCandidate(
          userId,
          serial,
          plannedCandidate.id,
          plannedCandidates.map((candidate) => candidate.id),
          autoPickMultiple,
          advertisedBoardType,
        )
      : await resolveEmptySerialPlan(userId, serial, config, autoPickMultiple, advertisedBoardType);
    if (resolution.kind !== 'retry') return resolution;
  }

  throw new GraphQLError('Board choices changed while connecting. Try again.', {
    extensions: { code: 'CONFLICT' },
  });
}

/**
 * Lock the requested board before the per-serial lock, then re-read the active
 * candidates and persist only when that exact board still carries the serial.
 * The pointer upsert's FK takes an implicit KEY SHARE lock on user_boards, so
 * the explicit row lock is also what keeps that FK edge in the global
 * row→serial order used by updateBoard, first-connect binding, and dedupe.
 */
async function chooseAndRememberActiveBoardForSerial(
  userId: string,
  serial: string,
  boardId: number,
): Promise<SerialCandidateBoard | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT id
        FROM user_boards
       WHERE id = ${boardId}
       FOR UPDATE
    `);
    await lockBoardSerialWrite(tx, serial);
    const candidates = await findActiveBoardsBySerial(serial, tx);
    const candidate = candidates.find((board) => board.id === boardId);
    if (!candidate) return undefined;

    await rememberBoardForSerial(userId, serial, candidate, tx);
    return candidate;
  });
}

export const boardPresenceMutations = {
  /**
   * Legacy serial resolver, kept for backward-compat with already-shipped
   * (OTA) mobile clients that can't render a disambiguation prompt: it always
   * returns a single board. When several boards share a serial it auto-picks
   * (the caller's own board if present, else the oldest) and remembers the
   * choice. New clients should call `resolveBoardCandidatesForSerial`.
   */
  resolveBoardForSerial: async (
    _: unknown,
    {
      serial,
      boardType,
      layoutId,
      sizeId,
      setIds,
      advertisedBoardType,
    }: {
      serial: string;
      boardType: string;
      layoutId: number;
      sizeId: number;
      setIds: string;
      advertisedBoardType?: string | null;
    },
    ctx: ConnectionContext,
  ): Promise<ResolvedBoard> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 30, 'resolveBoardForSerial');

    const validSerial = validateInput(BoardSerialSchema, serial, 'serial');
    const config = validateInput(BoardPresenceConfigInputSchema, { boardType, layoutId, sizeId, setIds }, 'input');
    const validAdvertisedBoardType = validateAdvertisedBoardType(advertisedBoardType);
    const userId = ctx.userId!;

    // Old clients can't prompt. The auto-pick's final candidate read and
    // pointer write happen inside resolveSerialForUser's row→serial transaction.
    const resolution = await resolveSerialForUser(userId, validSerial, config, {
      autoPickMultiple: true,
      advertisedBoardType: validAdvertisedBoardType,
    });
    // Auto-pick never returns candidates for a populated list, so the only way
    // here is the cross-type refusal above: the controller is not the board type
    // this route describes, and there is no board to bind. This mutation's
    // return type is non-null, so say so rather than inventing a board. Old
    // clients never send an advertised type and so can never reach this.
    if (resolution.kind !== 'board') {
      throw new GraphQLError('That controller is a different board type than the setup you are on.', {
        extensions: { code: 'BOARD_TYPE_MISMATCH' },
      });
    }
    await pubsub.stampBoardMembership(String(resolution.board.id), userId);
    return toResolvedBoard(resolution.board);
  },

  /**
   * Serial resolver for clients that can disambiguate. Returns either a single
   * resolved `board` (remembered choice / only-one-match / freshly created) or,
   * when several boards share this serial, the `candidates` for the user to
   * pick from. The pick is confirmed via `chooseBoardForSerial`.
   */
  resolveBoardCandidatesForSerial: async (
    _: unknown,
    {
      serial,
      boardType,
      layoutId,
      sizeId,
      setIds,
      advertisedBoardType,
    }: {
      serial: string;
      boardType: string;
      layoutId: number;
      sizeId: number;
      setIds: string;
      advertisedBoardType?: string | null;
    },
    ctx: ConnectionContext,
  ): Promise<{ board: ResolvedBoard | null; candidates: BoardCandidatePayload[] | null }> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 30, 'resolveBoardCandidatesForSerial');

    const validSerial = validateInput(BoardSerialSchema, serial, 'serial');
    const config = validateInput(BoardPresenceConfigInputSchema, { boardType, layoutId, sizeId, setIds }, 'input');
    const validAdvertisedBoardType = validateAdvertisedBoardType(advertisedBoardType);
    const userId = ctx.userId!;

    const resolution = await resolveSerialForUser(userId, validSerial, config, {
      advertisedBoardType: validAdvertisedBoardType,
    });
    if (resolution.kind === 'board') {
      await pubsub.stampBoardMembership(String(resolution.board.id), userId);
      return { board: toResolvedBoard(resolution.board), candidates: null };
    }

    const lastSent = await lastSentAtByBoardIds(resolution.candidates.map((candidate) => candidate.id));
    return {
      board: null,
      candidates: resolution.candidates.map((candidate) =>
        toBoardCandidate(candidate, userId, lastSent.get(candidate.id) ?? null),
      ),
    };
  },

  /**
   * Confirm the board the user picked from a disambiguation prompt. Remembers
   * the choice (so we don't ask again), stamps proof-of-presence, and returns
   * the bound board. The chosen board must be active and actually carry the
   * serial — a serial can't be redirected onto an unrelated board.
   */
  chooseBoardForSerial: async (
    _: unknown,
    { boardId, serial }: { boardId: number; serial: string },
    ctx: ConnectionContext,
  ): Promise<ResolvedBoard> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 30, 'chooseBoardForSerial');

    assertValidBoardId(boardId);
    const validSerial = validateInput(BoardSerialSchema, serial, 'serial');
    const userId = ctx.userId!;

    const candidate = await chooseAndRememberActiveBoardForSerial(userId, validSerial, boardId);
    if (!candidate) {
      throw new GraphQLError('That board is not linked to this serial', { extensions: { code: 'NOT_FOUND' } });
    }

    await pubsub.stampBoardMembership(String(candidate.id), userId);
    return toResolvedBoard(candidateToActiveBoard(candidate));
  },

  /**
   * Resolve the board-presence feed for a selected named board. Unlike the
   * per-config fallback, this binds to the actual UserBoard row so durable board
   * stats and live presence share the same board_id before any BLE connection.
   *
   * Auth-optional: board presence is universal, so an anonymous viewer can bind
   * a public board and become a member (keyed by `conn:{connectionId}`). Owned
   * boards stay reachable only to their logged-in owner (see
   * findReachableActiveBoardByUuid).
   */
  resolveBoardForUuid: async (
    _: unknown,
    { boardUuid }: { boardUuid: string },
    ctx: ConnectionContext,
  ): Promise<ResolvedBoard> => {
    await applyRateLimit(ctx, 30, 'resolveBoardForUuid');

    const emitterId = ctx.userId ?? `conn:${ctx.connectionId}`;
    const validBoardUuid = validateInput(UUIDSchema, boardUuid, 'boardUuid');
    const board = await findReachableActiveBoardByUuid(ctx.userId ?? null, validBoardUuid);
    if (!board) {
      throw new GraphQLError('Board not found', { extensions: { code: 'NOT_FOUND' } });
    }
    const resolved = toResolvedBoard(board);
    await pubsub.stampBoardMembership(String(resolved.boardId), emitterId);
    return resolved;
  },

  /**
   * Resolve the shared board feed for boards that do not expose a BLE serial
   * (MoonBoard and any future serial-less hardware). This is per-config in v1:
   * every caller with the same board config converges on the same hidden,
   * system-owned board_id. Aurora callers should continue using the serial
   * resolver above.
   *
   * Auth-optional: the per-config board is a shared, system-owned channel, so an
   * anonymous caller can converge on it and be stamped as a member (keyed by
   * `conn:{connectionId}`). It only ever reads/binds an existing shared board —
   * never creates or owns a user board.
   */
  resolveBoardForConfig: async (
    _: unknown,
    { boardType, layoutId, sizeId, setIds }: { boardType: string; layoutId: number; sizeId: number; setIds: string },
    ctx: ConnectionContext,
  ): Promise<ResolvedBoard> => {
    await applyRateLimit(ctx, 30, 'resolveBoardForConfig');

    const emitterId = ctx.userId ?? `conn:${ctx.connectionId}`;
    const config = validateInput(BoardPresenceConfigInputSchema, { boardType, layoutId, sizeId, setIds }, 'input');
    // Anonymous callers bind an existing shared feed only; a logged-in caller
    // creates it on first sighting (anon can't mint system boards).
    const resolved = await resolveSharedBoardForConfig(
      config.boardType,
      config.layoutId,
      config.sizeId,
      config.setIds,
      ctx.userId != null,
    );
    await pubsub.stampBoardMembership(String(resolved.boardId), emitterId);
    return resolved;
  },

  /**
   * Report the climb a connected phone just lit on the wall to the board's
   * live "now on the wall" feed. Fire-and-forget after the BLE write — no
   * confirm/timeout handshake.
   *
   * Identity (`sentByDisplayName` / `sentByAvatarUrl`) is derived server-side
   * from `ctx.userId` and never read from the input, so a client can't forge
   * who lit the climb. The reported `climbUuid` must be a real catalog climb.
   *
   * Latency-critical path (fires on every wall send), so the Redis/Postgres
   * work below is deliberately staged to overlap what can be overlapped:
   *  - Stage A: board lookup + the combined report gate (proof-of-presence,
   *    first-seen, and the write-side dedup marker) run in parallel — one
   *    Redis pipeline instead of the old separate hasBoardMembership call.
   *  - Stage B: the catalog climb and sender identity lookups run in parallel.
   *    Sequence allocation follows validation; for dwell-qualified sends its
   *    PostgreSQL reservation and durable event insert share one transaction.
   *  - The Redis writes (history append, writer handoff, dedup marker,
   *    session→board mapping) are one pipeline via `commitBoardClimb`.
   */
  reportBoardClimb: async (
    _: unknown,
    { boardId, climb, angle }: { boardId: number; climb: ClimbQueueItemInput; angle?: number | null },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    // Anonymous callers are now bucketed per client IP rather than per
    // connection (issue #2863), so a whole gym behind one NAT shares this
    // budget — and this fires on every wall send. Give anon the headroom for
    // several phones lighting climbs at once; logged-in senders keep 60/min
    // because their bucket is genuinely per-user. ESP32 controllers authenticate
    // by API key without setting isAuthenticated, so they land in the anon
    // bucket too.
    await applyRateLimit(ctx, ctx.isAuthenticated ? 60 : 240, 'reportBoardClimb');

    // Auth-optional: anyone connected to the board emits (logged-in or
    // anonymous). The emitter id is the userId, or `conn:{connectionId}` for an
    // anonymous client — both are stamped as board members on resolve/connect.
    const emitterId = ctx.userId ?? `conn:${ctx.connectionId}`;

    // Stage A: board existence + the combined report gate (proof-of-presence,
    // first-seen for the durable dwell gate, and the A2 dedup marker) — one
    // Redis pipeline instead of the old separate hasBoardMembership call.
    const [board, gate] = await Promise.all([
      requireActiveBoardById(boardId),
      pubsub.getBoardReportGate(String(boardId), emitterId),
    ]);

    // Proof-of-presence: only an emitter that selected or connected to this board
    // (stamped in resolveBoardForUuid / resolveBoardForSerial /
    // resolveBoardForConfig) may post to its feed. Stops anyone injecting climbs
    // onto a board id they guess.
    if (!gate.isMember) {
      throw new GraphQLError('Not connected to this board');
    }

    const validatedClimb = validateInput(ReportBoardClimbInputSchema, climb, 'climb');
    const validatedAngle = validateInput(BoardPresenceAngleSchema, angle, 'angle');
    // The explicit `angle` arg is int-validated, but the `climb.angle` / board
    // fallbacks aren't — round so a fractional angle can't break the `Int` event
    // serialization, the durable insert, or the grade join (defensive; real
    // clients always send integer wall angles).
    const effectiveAngle = Math.round(validatedAngle ?? validatedClimb.climb.angle ?? Number(board.angle));
    const climbUuid = validatedClimb.climb.uuid;

    // Write-side idempotency (A2): a retry of the exact same (emitter, climb,
    // angle) within REPORT_DEDUP_WINDOW_MS is a no-op — no new seq, no event,
    // no durable insert. Still note the WS-close backstop so a deduped retry
    // doesn't let a stale backstop entry lapse. A different climb / angle /
    // user is never suppressed (a user change still needs to broadcast the
    // hand-off).
    //
    // The short-circuit additionally requires this emitter to STILL hold the
    // wall (`currentWriter === emitterId`). The canonical retry is a socket
    // drop right after the original send — and that same drop fires the
    // WS-close backstop, which deletes the writer key and broadcasts
    // holder:null while lastReport survives. Short-circuiting on lastReport
    // alone would then leave the wall looking free while this emitter holds
    // it (writer never re-taken, hand-off never re-broadcast); falling
    // through re-takes the writer and re-broadcasts. The cost is one
    // duplicate history/durable row in exactly that edge — holder correctness
    // wins over row dedup.
    if (gate.lastReport === `${emitterId}|${climbUuid}|${effectiveAngle}` && gate.currentWriter === emitterId) {
      roomManager.noteBoardWriter(ctx.connectionId, boardId, emitterId);
      return true;
    }

    const [catalogClimbRows, sender] = await Promise.all([
      db
        .select({
          uuid: dbSchema.boardClimbs.uuid,
          name: dbSchema.boardClimbs.name,
          frames: dbSchema.boardClimbs.frames,
          setterUsername: dbSchema.boardClimbs.setterUsername,
          grade: dbSchema.boardDifficultyGrades.boulderName,
        })
        .from(dbSchema.boardClimbs)
        .leftJoin(
          dbSchema.boardClimbStats,
          and(
            eq(dbSchema.boardClimbStats.boardType, dbSchema.boardClimbs.boardType),
            eq(dbSchema.boardClimbStats.climbUuid, dbSchema.boardClimbs.uuid),
            eq(dbSchema.boardClimbStats.angle, effectiveAngle),
          ),
        )
        .leftJoin(
          dbSchema.boardDifficultyGrades,
          and(
            eq(dbSchema.boardDifficultyGrades.boardType, dbSchema.boardClimbStats.boardType),
            eq(dbSchema.boardDifficultyGrades.difficulty, sql`ROUND(${dbSchema.boardClimbStats.displayDifficulty})`),
          ),
        )
        .where(
          and(
            eq(dbSchema.boardClimbs.uuid, climbUuid),
            eq(dbSchema.boardClimbs.boardType, board.boardType),
            eq(dbSchema.boardClimbs.layoutId, Number(board.layoutId)),
          ),
        )
        .limit(1),
      // Anonymous emitters have no profile — leave the attribution null.
      ctx.userId
        ? db
            .select({
              name: dbSchema.users.name,
              image: dbSchema.users.image,
              displayName: dbSchema.userProfiles.displayName,
              avatarUrl: dbSchema.userProfiles.avatarUrl,
            })
            .from(dbSchema.users)
            .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
            .where(eq(dbSchema.users.id, ctx.userId))
            .limit(1)
            .then((rows) => rows[0])
        : Promise.resolve(undefined),
    ]);

    const catalogClimb = catalogClimbRows[0];
    if (!catalogClimb) {
      throw new GraphQLError('Unknown climb for this board');
    }

    const sentAt = new Date().toISOString();

    // Logged-in senders with sustained presence get durable history. Reserve
    // the seq through an allocator override that keeps the board-row lock until
    // the matching board_climb_events insert commits. A concurrent dedupe can
    // no longer tombstone the loser in the gap between those two operations.
    const DURABLE_DWELL_MS = 60_000;
    const durableUserId = typeof ctx.userId === 'string' ? ctx.userId : null;
    const hasDurableDwell = gate.firstSeenMs !== null && Date.parse(sentAt) - gate.firstSeenMs >= DURABLE_DWELL_MS;

    let seq: number;
    if (durableUserId !== null && hasDurableDwell) {
      try {
        seq = await pubsub.nextBoardSeq(String(boardId), (resolvedBoardId, candidate) =>
          reserveAndPersistBoardClimbEvent(
            {
              boardId: resolvedBoardId,
              boardType: board.boardType,
              climbUuid,
              angle: effectiveAngle,
              userId: durableUserId,
              sessionId: null,
              frames: catalogClimb.frames ?? null,
              name: catalogClimb.name ?? null,
              grade: catalogClimb.grade ?? null,
              setter: catalogClimb.setterUsername ?? null,
              confirmedAt: sentAt,
            },
            candidate,
          ),
        );
      } catch (error) {
        // A merge/delete is authoritative: never publish a fresh event under a
        // tombstoned board id. Other persistence failures retain the existing
        // best-effort history contract and fall back to a normal reservation.
        if (error instanceof DurableBoardClimbPersistenceError) {
          logger.warn('[board-presence] durable board_climb_events insert failed', {
            boardId,
            climbUuid,
            cause: error.persistenceCause instanceof Error ? error.persistenceCause.message : 'Unknown error',
          });
          seq = await pubsub.nextBoardSeq(String(boardId));
        } else {
          throw error;
        }
      }
    } else {
      seq = await pubsub.nextBoardSeq(String(boardId));
    }

    const presenceClimb: BoardPresenceClimb = {
      climbUuid,
      queueItemUuid: validatedClimb.uuid,
      name: catalogClimb.name ?? null,
      grade: catalogClimb.grade ?? null,
      // Grade palettes are still client/theme-specific, so the server leaves
      // this nullable until a shared color contract exists.
      gradeColor: null,
      frames: catalogClimb.frames ?? null,
      angle: effectiveAngle,
      setter: catalogClimb.setterUsername ?? null,
      sentByDisplayName: sender?.displayName ?? sender?.name ?? null,
      sentByAvatarUrl: sender?.avatarUrl ?? sender?.image ?? null,
      sentByUserId: ctx.userId ?? null,
      sentAt,
      seq,
    };

    // Record the hold on this connection (in-memory) so the WS-close backstop can
    // free the wall if the holder crashes without an explicit reportBoardDisconnect.
    // Before the Redis commit below: it can't fail and must not be skipped by an
    // early return or a later throw.
    roomManager.noteBoardWriter(ctx.connectionId, boardId, emitterId);

    // Remember which board this connection's party session is on (when it's in
    // one), so the APNs Live Activity path can resolve the board's holder for a
    // session — QueueState/push-token rows carry sessionId but not boardId. Best-
    // effort: a solo (no-session) sender just doesn't establish a mapping.
    const reportingSessionId = roomManager.getClient(ctx.connectionId)?.sessionId ?? null;

    // One Redis pipeline: durable FIFO history append, connection-holder
    // handoff (atomic SET..GET), the A2 dedup marker, and the session→board
    // mapping. Non-fatal on failure (see commitBoardClimb's contract).
    const { previousWriter, writerSlotOk, sessionBindingChanged } = await pubsub.commitBoardClimb({
      boardId: String(boardId),
      emitterId,
      climb: presenceClimb,
      climbUuid,
      effectiveAngle,
      sessionId: reportingSessionId,
    });

    // This send just bound a NEW session to the wall (first report, or a
    // hand-off from another session). Seed public kiosk subscribers with the
    // session's current queue right away: the board-queue-preview producer
    // only fires on queue events, so without this seed a kiosk subscribed
    // before anyone took the wall would stay blank until the next queue
    // mutation. publishBoardQueuePreviewForSession re-applies both privacy
    // gates and the superseded-binding re-check, and is publisher-instance-
    // only like every producer publish. Fire-and-forget — a failed preview
    // seed must never fail the accepted report.
    if (sessionBindingChanged && reportingSessionId) {
      publishBoardQueuePreviewForSession(reportingSessionId).catch((error: unknown) => {
        logger.warn(
          `[board-presence] board-queue-preview seed on session bind failed for ${reportingSessionId}: ${String(error)}`,
        );
      });
    }

    // Store before publish: commitBoardClimb above already awaited the history
    // append, so a late joiner reading the FIFO right after this publish will
    // already see the new entry.
    pubsub.publishBoardPresenceEvent(String(boardId), {
      __typename: 'BoardClimbSet',
      climb: presenceClimb,
    });

    // This emitter is now the board's connection holder. Only broadcast a
    // hand-off when the writer slot verifiably executed (`writerSlotOk`) —
    // that covers both Redis-off (holder degrades to "none", no broadcast)
    // and a failing pipeline, where previousWriter: null is a fabrication and
    // `null !== emitterId` would otherwise spuriously broadcast a hand-off
    // (+ Live Activity push) on every send until Redis recovers.
    let writerChanged = false;
    if (writerSlotOk && previousWriter !== emitterId) {
      writerChanged = true;
      pubsub.publishBoardPresenceEvent(String(boardId), {
        __typename: 'BoardConnectionChanged',
        holder: {
          userId: ctx.userId ?? null,
          displayName: presenceClimb.sentByDisplayName,
          avatarUrl: presenceClimb.sentByAvatarUrl,
          lastSentAt: sentAt,
        },
        seq,
      });
    }

    // A board hand-off (a peer took over) changes every device's
    // boardConnection, but it isn't a queue event — the queue-event hook that
    // normally drives Live Activity pushes never fires here. So when the holder
    // changes, kick a debounced push for the affected session so backgrounded
    // iPhones flip to heldByPeer/connectedByMe right away rather than waiting up
    // to 90s for the heartbeat backstop. Fire-and-forget; the heartbeat catches
    // any miss. Skipped entirely when APNs is unconfigured.
    if (writerChanged && reportingSessionId && isApnsConfigured()) {
      void (async () => {
        try {
          const queueState = await roomManager.getQueueState(reportingSessionId);
          const contentState = buildContentStateFromQueueState(queueState);
          if (contentState) sendLiveActivityUpdate(reportingSessionId, contentState);
        } catch (error) {
          logger.warn(`[board-presence] Live Activity dispatch on writer change failed: ${String(error)}`);
        }
      })();
    }

    return true;
  },

  /**
   * Clear this emitter's board-connection hold (explicit lightbulb-off or a
   * detected BLE drop), so the "who's connected" indicator goes free. No-op when
   * someone else now holds it (always-take means a later emitter already took
   * over). Auth-optional, keyed by the same emitter id as reportBoardClimb.
   */
  reportBoardDisconnect: async (
    _: unknown,
    { boardId }: { boardId: number },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    // Same anon-per-IP headroom as reportBoardClimb: this pairs with every
    // lightbulb-off / BLE drop, so a shared-NAT gym would otherwise burn one
    // 60/min bucket between all its phones. See issue #2863.
    await applyRateLimit(ctx, ctx.isAuthenticated ? 60 : 240, 'reportBoardDisconnect');
    assertValidBoardId(boardId);
    const emitterId = ctx.userId ?? `conn:${ctx.connectionId}`;
    const cleared = await pubsub.clearBoardWriterIf(String(boardId), emitterId);
    if (cleared) {
      const seq = await pubsub.nextBoardSeq(String(boardId));
      pubsub.publishBoardPresenceEvent(String(boardId), {
        __typename: 'BoardConnectionChanged',
        holder: null,
        seq,
      });
    }
    return cleared;
  },
};
