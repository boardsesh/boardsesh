import { v4 as uuidv4 } from 'uuid';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type {
  ConnectionContext,
  ClimbQueueItemInput,
  ResolvedBoard,
  BoardPresenceClimb,
} from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import { BoardSerialSchema, UUIDSchema } from '../../../validation/schemas/primitives';
import {
  BoardPresenceAngleSchema,
  BoardPresenceConfigInputSchema,
  ReportBoardClimbInputSchema,
} from '../../../validation/schemas';
import { generateUniqueSlug } from '../social/boards';
import { logger } from '../../../utils/logger';
import { pubsub } from '../../../pubsub/index';
import { roomManager } from '../../../services/room-manager';
import { isApnsConfigured, sendLiveActivityUpdate } from '../../../services/apns';
import { buildContentStateFromQueueState } from '../../../services/apns/content-state';
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
  normalizeSetIds,
  rememberBoardForSerial,
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
 * resolver; the per-owner unique index keeps a same-owner bind race fail-safe.)
 */
async function bindOrCreateOwnBoardForSerial(
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
  );
  if (ownBoard) {
    if (ownBoard.serialNumber && ownBoard.serialNumber !== serial) {
      throw serialAlreadyBoundError();
    }
    try {
      const [updated] = await db
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
    );
    if (refreshed?.serialNumber === serial) {
      return refreshed;
    }
    if (refreshed?.serialNumber) {
      throw serialAlreadyBoundError();
    }
  }

  const uuid = uuidv4();
  const name = defaultBoardName(config.boardType);
  const slug = await generateUniqueSlug(name);
  try {
    const [created] = await db
      .insert(dbSchema.userBoards)
      .values({
        uuid,
        slug,
        ownerId: userId,
        boardType: config.boardType,
        layoutId: config.layoutId,
        sizeId: config.sizeId,
        setIds: normalizeSetIds(config.setIds),
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
      );
      if (winner?.serialNumber === serial) {
        return winner;
      }
    }
    throwIfDuplicateBoardSerial(error);
    throw error;
  }
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
): Promise<SerialResolution> {
  const chosen = await findChosenBoardForSerial(userId, serial);
  if (chosen) {
    return { kind: 'board', board: chosen };
  }

  const candidates = await findActiveBoardsBySerial(serial);
  if (candidates.length === 0) {
    const board = await bindOrCreateOwnBoardForSerial(userId, serial, config);
    return { kind: 'board', board };
  }
  if (candidates.length === 1) {
    await rememberBoardForSerial(userId, serial, candidates[0]);
    return { kind: 'board', board: candidateToActiveBoard(candidates[0]) };
  }
  return { kind: 'candidates', candidates };
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
    }: { serial: string; boardType: string; layoutId: number; sizeId: number; setIds: string },
    ctx: ConnectionContext,
  ): Promise<ResolvedBoard> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 30, 'resolveBoardForSerial');

    const validSerial = validateInput(BoardSerialSchema, serial, 'serial');
    const config = validateInput(BoardPresenceConfigInputSchema, { boardType, layoutId, sizeId, setIds }, 'input');
    const userId = ctx.userId!;

    const resolution = await resolveSerialForUser(userId, validSerial, config);
    if (resolution.kind === 'board') {
      await pubsub.stampBoardMembership(String(resolution.board.id), userId);
      return toResolvedBoard(resolution.board);
    }
    // Old clients can't prompt — auto-pick (owned first, else oldest) and remember.
    const owned = resolution.candidates.find((candidate) => candidate.ownerId === userId);
    const pick = owned ?? resolution.candidates[0];
    await rememberBoardForSerial(userId, validSerial, pick);
    await pubsub.stampBoardMembership(String(pick.id), userId);
    return toResolvedBoard(candidateToActiveBoard(pick));
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
    }: { serial: string; boardType: string; layoutId: number; sizeId: number; setIds: string },
    ctx: ConnectionContext,
  ): Promise<{ board: ResolvedBoard | null; candidates: BoardCandidatePayload[] | null }> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 30, 'resolveBoardCandidatesForSerial');

    const validSerial = validateInput(BoardSerialSchema, serial, 'serial');
    const config = validateInput(BoardPresenceConfigInputSchema, { boardType, layoutId, sizeId, setIds }, 'input');
    const userId = ctx.userId!;

    const resolution = await resolveSerialForUser(userId, validSerial, config);
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

    const candidate = (await findActiveBoardsBySerial(validSerial)).find((board) => board.id === boardId);
    if (!candidate) {
      throw new GraphQLError('That board is not linked to this serial', { extensions: { code: 'NOT_FOUND' } });
    }

    await rememberBoardForSerial(userId, validSerial, candidate);
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
   */
  reportBoardClimb: async (
    _: unknown,
    { boardId, climb, angle }: { boardId: number; climb: ClimbQueueItemInput; angle?: number | null },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    await applyRateLimit(ctx, 60, 'reportBoardClimb');
    const board = await requireActiveBoardById(boardId);

    // Auth-optional: anyone connected to the board emits (logged-in or
    // anonymous). The emitter id is the userId, or `conn:{connectionId}` for an
    // anonymous client — both are stamped as board members on resolve/connect.
    const emitterId = ctx.userId ?? `conn:${ctx.connectionId}`;

    // Proof-of-presence: only an emitter that selected or connected to this board
    // (stamped in resolveBoardForUuid / resolveBoardForSerial /
    // resolveBoardForConfig) may post to its feed. Stops anyone injecting climbs
    // onto a board id they guess.
    const isConnected = await pubsub.hasBoardMembership(String(boardId), emitterId);
    if (!isConnected) {
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

    const seq = await pubsub.nextBoardSeq(String(boardId));
    const sentAt = new Date().toISOString();

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

    await pubsub.storeBoardClimb(String(boardId), presenceClimb);
    pubsub.publishBoardPresenceEvent(String(boardId), {
      __typename: 'BoardClimbSet',
      climb: presenceClimb,
    });

    // Record the hold on this connection (in-memory) so the WS-close backstop can
    // free the wall if the holder crashes without an explicit reportBoardDisconnect.
    // Outside the Redis try below since it can't fail and must not be swallowed.
    roomManager.noteBoardWriter(ctx.connectionId, boardId, emitterId);

    // Remember which board this connection's party session is on (when it's in
    // one), so the APNs Live Activity path can resolve the board's holder for a
    // session — QueueState/push-token rows carry sessionId but not boardId. Best-
    // effort: a solo (no-session) sender just doesn't establish a mapping.
    const reportingSessionId = roomManager.getClient(ctx.connectionId)?.sessionId ?? null;
    if (reportingSessionId) {
      try {
        await pubsub.setSessionBoard(reportingSessionId, String(boardId));
      } catch (error) {
        logger.warn(`[board-presence] setSessionBoard failed: ${String(error)}`);
      }
    }

    // This emitter is now the board's connection holder. The holder is Redis-only
    // (degrades to "no holder" without Redis), so only broadcast a hand-off when
    // Redis actually backs the writer — otherwise setBoardWriter returns null and
    // `null !== emitterId` would spuriously broadcast on every send. Non-fatal.
    let writerChanged = false;
    if (pubsub.isRedisConnected()) {
      try {
        const previousHolder = await pubsub.setBoardWriter(String(boardId), emitterId);
        if (previousHolder !== emitterId) {
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
      } catch (error) {
        logger.warn(`[board-presence] board writer update failed: ${String(error)}`);
      }
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

    // Durable history (logged-in + dwell-gated): persist this push to
    // board_climb_events only for an authenticated sender who has had sustained
    // presence on the board (>= 60s). Anonymous sends drive the live feed + holder
    // but never the durable, leaderboard-backing log — they're unattributable
    // (userId null) and otherwise let an anon spam null rows into a public board's
    // history. App-swiping noise is filtered by the dwell gate. The live feed
    // already showed everything; only the Postgres write is gated. Non-fatal — a
    // failed durable insert never fails the accepted report.
    const DURABLE_DWELL_MS = 60_000;
    try {
      // `sentAt` is the server-generated ISO timestamp from above, so
      // `Date.parse(sentAt)` is always valid; `firstSeen` is already guarded to
      // a plausible epoch-ms or null in getBoardMembershipFirstSeen. A null
      // firstSeen correctly skips the insert (presence not yet proven for 60s).
      const firstSeen = ctx.userId ? await pubsub.getBoardMembershipFirstSeen(String(boardId), emitterId) : null;
      if (ctx.userId && firstSeen !== null && Date.parse(sentAt) - firstSeen >= DURABLE_DWELL_MS) {
        await db
          .insert(dbSchema.boardClimbEvents)
          .values({
            boardId,
            boardType: board.boardType,
            climbUuid,
            angle: effectiveAngle,
            userId: ctx.userId,
            // Reserved for session recaps. reportBoardClimb has no sessionId arg
            // yet, so every durable row is solo-attributed until the
            // session-attribution follow-up threads the active session through.
            sessionId: null,
            seq,
            frames: catalogClimb.frames ?? null,
            name: catalogClimb.name ?? null,
            grade: catalogClimb.grade ?? null,
            setter: catalogClimb.setterUsername ?? null,
            confirmedAt: sentAt,
          })
          // (boardId, seq) is unique — makes a multi-instance double-flush a no-op.
          .onConflictDoNothing();
      }
    } catch (error) {
      logger.warn(`[board-presence] durable board_climb_events insert failed: ${String(error)}`);
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
    await applyRateLimit(ctx, 60, 'reportBoardDisconnect');
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
