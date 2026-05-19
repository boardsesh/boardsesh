import { v4 as uuidv4 } from 'uuid';
import type { ConnectionContext, SessionEvent, ClimbQueueItem } from '@boardsesh/shared-schema';
import { roomManager } from '../../../services/room-manager';
import { pubsub } from '../../../pubsub/index';
import { updateContext } from '../../context';
import {
  requireAuthenticated,
  requireSession,
  requireSessionMember,
  applyRateLimit,
  validateInput,
} from '../shared/helpers';
import {
  SessionIdSchema,
  ParticipantIdSchema,
  BoardPathSchema,
  UsernameSchema,
  AvatarUrlSchema,
  SessionNameSchema,
  CreateSessionInputSchema,
  ClimbQueueItemSchema,
  ClimbUuidSchema,
  BoardSerialSchema,
  QueueArraySchema,
} from '../../../validation/schemas';
import { logger } from '../../../utils/logger';
import type { CreateSessionInput } from '../shared/types';
import { db } from '../../../db/client';
import { esp32Controllers, userBoards } from '@boardsesh/db/schema/app';
import { sessionBoards } from '../../../db/schema';
import { eq, inArray } from 'drizzle-orm';
import { generateSessionSummary } from './session-summary';
import { adoptRecentTicksForSession, extractBoardType } from '../../../jobs/inferred-session-builder';
import { endLiveActivity } from '../../../services/apns';
import { setCurrentClimbAndPublish } from '../../../services/queue-navigation';

/**
 * Auto-authorize all controllers owned by a user for a session.
 * Called when user joins a session to allow their ESP32 devices to connect.
 */
async function authorizeUserControllersForSession(userId: string, sessionId: string): Promise<void> {
  try {
    // Update all controllers owned by this user to be authorized for this session
    await db
      .update(esp32Controllers)
      .set({ authorizedSessionId: sessionId })
      .where(eq(esp32Controllers.userId, userId));

    logger.info(`[Session] Auto-authorized user ${userId}'s controllers for session ${sessionId}`);
  } catch (error) {
    // Log but don't fail the join - controller auth is a bonus feature
    logger.error('[Session] Failed to auto-authorize controllers:', error);
  }
}

// Debug logging flag - only log in development
const DEBUG = process.env.NODE_ENV === 'development';

export const sessionMutations = {
  /**
   * Join an existing session or create a new one
   * Creates or joins a session and updates connection context.
   * When creating a new session, initialQueue and initialCurrentClimb can be provided
   * to seed the session with existing queue items (e.g., when starting party mode with an existing local queue).
   * sessionName is only used when creating a new session - ignored when joining an existing one.
   */
  joinSession: async (
    _: unknown,
    {
      sessionId,
      boardPath,
      username,
      avatarUrl,
      participantId,
      initialQueue,
      initialCurrentClimb,
      sessionName,
    }: {
      sessionId: string;
      boardPath: string;
      username?: string;
      avatarUrl?: string;
      participantId?: string;
      initialQueue?: ClimbQueueItem[];
      initialCurrentClimb?: ClimbQueueItem;
      sessionName?: string;
    },
    ctx: ConnectionContext,
  ) => {
    if (DEBUG)
      logger.info(
        `[joinSession] START - connectionId: ${ctx.connectionId}, sessionId: ${sessionId}, username: ${username}, sessionName: ${sessionName}, initialQueueLength: ${initialQueue?.length || 0}`,
      );

    await applyRateLimit(ctx, 10); // Limit session joins to prevent abuse

    // Validate inputs
    validateInput(SessionIdSchema, sessionId, 'sessionId');
    validateInput(BoardPathSchema, boardPath, 'boardPath');
    if (username) validateInput(UsernameSchema, username, 'username');
    if (avatarUrl) validateInput(AvatarUrlSchema, avatarUrl, 'avatarUrl');
    if (participantId) validateInput(ParticipantIdSchema, participantId, 'participantId');
    if (sessionName) validateInput(SessionNameSchema, sessionName, 'sessionName');
    if (initialQueue) validateInput(QueueArraySchema, initialQueue, 'initialQueue');
    if (initialCurrentClimb) validateInput(ClimbQueueItemSchema, initialCurrentClimb, 'initialCurrentClimb');

    const result = await roomManager.joinSession(
      ctx.connectionId,
      sessionId,
      boardPath,
      username || undefined,
      avatarUrl || undefined,
      initialQueue,
      initialCurrentClimb || null,
      sessionName || undefined,
      participantId || undefined,
    );
    if (DEBUG)
      logger.info(
        `[joinSession] roomManager.joinSession completed - clientId: ${result.clientId}, isLeader: ${result.isLeader}`,
      );

    // Update context with session info. Do NOT touch userId here — auth
    // middleware set it to the real authenticated user UUID when the WS
    // connected. `result.clientId` is the connection ID (see
    // services/room-manager/client-lifecycle.ts:199 which returns
    // `clientId: connectionId`), and writing it to `ctx.userId` would
    // clobber the real UUID for every downstream resolver on this connection
    // (ESP32 auto-authorize, tick inserts, climb ownership, etc.).
    if (DEBUG) logger.info(`[joinSession] Before updateContext - ctx.sessionId: ${ctx.sessionId}`);
    updateContext(ctx.connectionId, { sessionId, participantId: result.participantId });
    if (DEBUG) logger.info(`[joinSession] After updateContext - ctx.sessionId: ${ctx.sessionId}`);

    // Auto-authorize user's ESP32 controllers for this session (if authenticated)
    if (ctx.isAuthenticated && ctx.userId) {
      void authorizeUserControllersForSession(ctx.userId, sessionId);
      // Adopt recent solo ticks into this session. The session row exists at
      // this point (ensureSessionRecordExists ran inside roomManager.joinSession).
      const boardTypeFromPath = extractBoardType(boardPath);
      adoptRecentTicksForSession(ctx.userId, sessionId, boardTypeFromPath).catch((err) => {
        logger.error(`[joinSession] Failed to adopt recent ticks for session ${sessionId}:`, err);
      });
    }

    // Notify session about new or reconnected participant
    const sessionUser = result.users.find((user) => user.id === result.participantId) ?? {
      id: result.participantId,
      username: username || `User-${result.participantId.substring(0, 6)}`,
      isLeader: result.isLeader,
      avatarUrl: avatarUrl,
      userId: ctx.isAuthenticated ? ctx.userId : null,
      connectionState: 'CONNECTED' as const,
    };
    const sessionEvent: SessionEvent = result.participantWasReconnecting
      ? { __typename: 'UserPresenceChanged', user: sessionUser }
      : { __typename: 'UserJoined', user: sessionUser };
    pubsub.publishSessionEvent(sessionId, sessionEvent);

    // Fetch session data for new fields
    const sessionData = await roomManager.getSessionById(sessionId);
    const driverParticipantId = await roomManager.getSessionDriverParticipantId(sessionId);
    const lastConnectedBoardSerial = await roomManager.getSessionBoardSerial(sessionId);

    return {
      id: sessionId,
      name: result.sessionName || null,
      boardPath,
      users: result.users,
      queueState: {
        sequence: result.sequence,
        stateHash: result.stateHash,
        queue: result.queue,
        currentClimbQueueItem: result.currentClimbQueueItem,
      },
      isLeader: result.isLeader,
      driverParticipantId,
      lastConnectedBoardSerial,
      clientId: result.clientId,
      participantId: result.participantId,
      goal: sessionData?.goal || null,
      isPublic: sessionData?.isPublic ?? true,
      startedAt: sessionData?.startedAt?.toISOString() || null,
      endedAt: sessionData?.endedAt?.toISOString() || null,
      isPermanent: sessionData?.isPermanent ?? false,
      color: sessionData?.color || null,
      // Default true on legacy rows where the column existed but
      // ensureSessionRecordExists couldn't fetch the value (shouldn't happen
      // post-migration, but guards against an unexpected null read).
      sharedPlaylistEnabled: sessionData?.sharedPlaylistEnabled ?? true,
    };
  },

  /**
   * Create a new session
   * Only authenticated users can create sessions
   * Optionally creates a discoverable session with GPS coordinates
   */
  createSession: async (_: unknown, { input }: { input: CreateSessionInput }, ctx: ConnectionContext) => {
    if (DEBUG) logger.info(`[createSession] START - connectionId: ${ctx.connectionId}, boardPath: ${input.boardPath}`);

    await applyRateLimit(ctx, 5); // Limit session creation to prevent abuse

    // Validate input
    validateInput(CreateSessionInputSchema, input, 'createSession input');

    // Generate a unique session ID
    const sessionId = uuidv4();
    if (DEBUG) logger.info(`[createSession] Generated sessionId: ${sessionId}`);

    if (input.discoverable) {
      // Discoverable sessions require authentication (they write to DB with userId)
      requireAuthenticated(ctx);
      // Use authenticated userId from context
      const userId = ctx.userId || ctx.connectionId;
      await roomManager.createDiscoverableSession(
        sessionId,
        input.boardPath,
        userId,
        input.latitude,
        input.longitude,
        input.name,
        input.goal,
        input.isPermanent,
        input.color,
      );

      // If boardIds provided, create sessionBoards junction rows
      if (input.boardIds && input.boardIds.length > 0) {
        // Verify boards exist
        const boards = await db
          .select({ id: userBoards.id, gymId: userBoards.gymId })
          .from(userBoards)
          .where(inArray(userBoards.id, input.boardIds));

        if (boards.length !== input.boardIds.length) {
          throw new Error('One or more board IDs do not exist');
        }

        // Validate all boards share the same gym (multi-board requires same gym)
        const gymIds = new Set(boards.map((b) => b.gymId).filter(Boolean));
        if (gymIds.size > 1) {
          throw new Error('All boards must belong to the same gym for multi-board sessions');
        }

        // Insert junction rows
        await db.insert(sessionBoards).values(
          input.boardIds.map((boardId) => ({
            sessionId,
            boardId,
          })),
        );
      }
    }

    // For HTTP requests (stateless), skip joining the session in-memory.
    // The creator will join via WebSocket when they navigate to the board page.
    const isHttpRequest = ctx.transport === 'http';

    if (!isHttpRequest) {
      // WebSocket path: join the session as the creator.
      // For non-discoverable sessions, this also creates the board_sessions row
      // via ensureSessionRecordExists inside roomManager.joinSession.
      const result = await roomManager.joinSession(
        ctx.connectionId,
        sessionId,
        input.boardPath,
        undefined, // username will be set later
        undefined, // avatarUrl will be set later
        undefined, // initialQueue
        null, // initialCurrentClimb
        input.discoverable ? undefined : input.name,
      );
      if (DEBUG)
        logger.info(`[createSession] Joined session - clientId: ${result.clientId}, isLeader: ${result.isLeader}`);

      updateContext(ctx.connectionId, { sessionId, participantId: result.participantId });

      // Adopt recent solo ticks now that the session row exists in board_sessions
      // (boardsesh_ticks.session_id is a FK to board_sessions.id)
      if (ctx.isAuthenticated && ctx.userId) {
        const boardTypeFromPath = extractBoardType(input.boardPath);
        adoptRecentTicksForSession(ctx.userId, sessionId, boardTypeFromPath).catch((err) => {
          logger.error(`[createSession] Failed to adopt recent ticks for session ${sessionId}:`, err);
        });
      }

      return {
        id: sessionId,
        name: input.name || null,
        boardPath: input.boardPath,
        users: result.users,
        queueState: {
          sequence: result.sequence,
          stateHash: result.stateHash,
          queue: result.queue,
          currentClimbQueueItem: result.currentClimbQueueItem,
        },
        isLeader: result.isLeader,
        // Newly created sessions start with no driver — the creator must press
        // the lightbulb to claim the wall. Null here lets the bar render the
        // empty/outlined state in PR 2 onward.
        driverParticipantId: null,
        // No board has been paired yet; gets set the first time anyone in the
        // session calls setSessionBoardSerial.
        lastConnectedBoardSerial: null,
        clientId: result.clientId,
        participantId: result.participantId,
        goal: input.goal || null,
        isPublic: true,
        startedAt: new Date().toISOString(),
        endedAt: null,
        isPermanent: input.isPermanent || false,
        color: input.color || null,
        // Explicit createSession defaults to false (the new shared playlist
        // gate). Joining peers will inherit this; the creator can flip the
        // toggle later via setSharedPlaylistEnabled.
        sharedPlaylistEnabled: false,
      };
    }

    // HTTP path: adoption is handled by joinSession when the client connects
    // via WebSocket (avoids double invocation for HTTP + discoverable sessions).

    // HTTP path: return session metadata only; client joins via WebSocket later
    if (DEBUG) logger.info(`[createSession] HTTP request - returning session metadata without joining`);

    return {
      id: sessionId,
      name: input.name || null,
      boardPath: input.boardPath,
      users: [],
      queueState: null,
      isLeader: false,
      driverParticipantId: null,
      lastConnectedBoardSerial: null,
      clientId: null,
      participantId: ctx.participantId || ctx.connectionId || '',
      goal: input.goal || null,
      isPublic: true,
      startedAt: new Date().toISOString(),
      endedAt: null,
      isPermanent: input.isPermanent || false,
      color: input.color || null,
      // HTTP path mirrors the WS path's default; the actual row is created
      // when the client connects via WebSocket.
      sharedPlaylistEnabled: false,
    };
  },

  /**
   * Leave the current session
   * Cleans up connection context and notifies other session members
   */
  leaveSession: async (_: unknown, __: unknown, ctx: ConnectionContext) => {
    if (!ctx.sessionId) return false;

    const sessionId = ctx.sessionId;
    const participantId = ctx.participantId;
    const result = await roomManager.leaveSession(ctx.connectionId);

    if (result) {
      // Notify session about the stable participant leaving. The schema field
      // is named `userId` for historical reasons, but current clients compare
      // it with `SessionUser.id`, which is the stable participant ID.
      //
      // Only fire UserLeft when the participant's last connection just left.
      // If the user has another tab open in the same session (authenticated
      // users share one participantId across tabs), suppress the broadcast —
      // peers should keep seeing the participant.
      if (result.participantFullyLeft) {
        pubsub.publishSessionEvent(sessionId, {
          __typename: 'UserLeft',
          userId: result.participantId || participantId || ctx.connectionId,
        });
      }

      // Notify about new leader if changed
      if (result.newLeaderId) {
        pubsub.publishSessionEvent(sessionId, {
          __typename: 'LeaderChanged',
          leaderId: result.newLeaderParticipantId || result.newLeaderId,
          leaderConnectionId: result.newLeaderId,
        });
      }

      // Only clear session/participant state. Auth set userId to the real
      // UUID at connection time and downstream resolvers on this same
      // WebSocket still need it.
      updateContext(ctx.connectionId, { sessionId: undefined, participantId: undefined });
    }

    return true;
  },

  /**
   * Claim wall-control authority and optionally broadcast a climb to the wall.
   *
   * Mediates the queue-control-bar pivot's lightbulb gesture. Any session
   * participant may call — yank-on-press by design (the previous driver's
   * lightbulb releases automatically when the new driver claims). When `climb`
   * is provided, the climb is also appended to the queue (if not already
   * present) and broadcast as the current climb, matching `setCurrentClimb`'s
   * side effects. Publishes `DriverChanged` regardless of whether a climb was
   * provided.
   */
  takeControl: async (_: unknown, { climb }: { climb?: ClimbQueueItem | null }, ctx: ConnectionContext) => {
    await applyRateLimit(ctx);
    const sessionId = requireSession(ctx);
    await requireSessionMember(ctx, sessionId);
    if (climb !== null && climb !== undefined) {
      validateInput(ClimbQueueItemSchema, climb, 'climb');
    }

    // Hard-error when ctx.participantId is missing rather than silently
    // falling back to connectionId. The connectionId rotates on every
    // reconnect, so any subsequent clearSessionDriverIf/releaseDriverIfMatches
    // call (e.g. driver bounces wifi, reconnects with a fresh connectionId)
    // would fail to match the prior key and leak the driver assignment.
    // Surfacing the failure forces auth to publish a real participantId.
    if (!ctx.participantId) {
      throw new Error('takeControl requires ctx.participantId; refusing to fall back to connectionId.');
    }
    const participantId = ctx.participantId;

    // Broadcast the climb to the wall BEFORE swapping the driver. If
    // setCurrentClimbAndPublish throws (e.g. Redis VersionConflict over
    // MAX_RETRIES, or any other failure inside the queue-update path), the
    // driver hasn't moved yet — subscribers don't end up in the wedged
    // "B is driving, but the wall still shows A's previous climb" state
    // that the old "driver first, then climb" ordering produced. The atomic
    // swap below is the moment the driver actually flips for everyone.
    if (climb) {
      await setCurrentClimbAndPublish(
        sessionId,
        climb,
        true, // takeControl always treats the climb as a queue-add candidate (matches the old setCurrentClimb+shouldAddToQueue:true path)
        roomManager,
        pubsub,
        ctx.connectionId || null,
        null,
      );
    }

    // Atomic swap so the previous-vs-new comparison can't race a concurrent
    // takeControl from another participant. The room manager returns the
    // previous driver from a single Redis GETSET in multi-instance mode (and
    // the in-memory shadow in single-instance), which we use to decide
    // whether to publish DriverChanged.
    const previousDriverParticipantId = await roomManager.setSessionDriverAndReturnPrevious(sessionId, participantId);

    // Broadcast DriverChanged only on transitions. Self-claim while already
    // driving is a no-op for the wire (avoids redundant subscriber work and
    // keeps the time series clean for the Phase 5 instrumentation). The
    // event carries the previous driver so subscribers can render
    // "X took the wall from Y" toasts without local bookkeeping (Phase 5
    // `previousDriver` analytics property).
    if (previousDriverParticipantId !== participantId) {
      pubsub.publishSessionEvent(sessionId, {
        __typename: 'DriverChanged',
        driverParticipantId: participantId,
        previousDriverParticipantId,
      });
    }

    // Build the Session payload. The fields mirror joinSession's return so
    // clients can apply the response without a refetch. Fan the
    // independent reads out in parallel — sequential awaits over four
    // unrelated lookups only burns latency.
    const [users, sessionData, queueState, lastConnectedBoardSerial, leaderConnectionId] = await Promise.all([
      roomManager.getSessionUsers(sessionId),
      roomManager.getSessionById(sessionId),
      roomManager.getQueueState(sessionId),
      roomManager.getSessionBoardSerial(sessionId),
      roomManager.getSessionLeaderConnectionId(sessionId),
    ]);

    return {
      id: sessionId,
      name: sessionData?.name || null,
      boardPath: sessionData?.boardPath || '',
      users,
      queueState: {
        sequence: queueState.sequence,
        stateHash: queueState.stateHash,
        queue: queueState.queue,
        currentClimbQueueItem: queueState.currentClimbQueueItem,
      },
      isLeader: leaderConnectionId === ctx.connectionId,
      driverParticipantId: participantId,
      lastConnectedBoardSerial,
      clientId: ctx.connectionId,
      participantId,
      goal: sessionData?.goal || null,
      isPublic: sessionData?.isPublic ?? true,
      startedAt: sessionData?.startedAt?.toISOString() || null,
      endedAt: sessionData?.endedAt?.toISOString() || null,
      isPermanent: sessionData?.isPermanent ?? false,
      color: sessionData?.color || null,
    };
  },

  /**
   * Confirm to all session members that a climb was successfully sent to the
   * wall over BLE from this client's phone. Any session participant may call —
   * the BLE-capable phone that handled the send is the source of truth for
   * confirmation, regardless of who holds the driver role. The server stamps
   * `confirmedAt` and derives `confirmedByParticipantId` from the caller's
   * identity so clients cannot forge either field. The optional
   * `queueItemUuid` disambiguates the press when the same climb is queued
   * twice. Publishes `WallConfirmedClimb`. Returns the resolved `Session` so
   * optimistic-UI callers can apply server-derived state without a follow-up
   * query (symmetric with `takeControl` / `releaseControl`). Session identity
   * comes from the WebSocket connection context — no `sessionId` argument.
   */
  confirmClimbOnWall: async (
    _: unknown,
    { climbUuid, queueItemUuid }: { climbUuid: string; queueItemUuid?: string | null },
    ctx: ConnectionContext,
  ) => {
    // Give confirmClimbOnWall its own per-operation bucket. The previous
    // `applyRateLimit(ctx, 6)` shared the default bucket with every other
    // mutation on the same user — six rapid forward swipes (which fire
    // setCurrentClimb / addQueueItem alongside the wall confirm) would burn
    // through it and every peer's recovery fallback would wedge on the
    // 2 s picker timeout. 60/min covers worst-case rapid swiping with
    // headroom while still choking off replay storms from a misbehaving
    // client.
    await applyRateLimit(ctx, 60, 'confirmClimbOnWall');
    // Session identity comes from the WebSocket connection context (the
    // "WS-implicit" pattern used by takeControl / releaseControl) — clients
    // no longer pass `sessionId` as an argument.
    const sessionId = requireSession(ctx);
    validateInput(ClimbUuidSchema, climbUuid, 'climbUuid');
    await requireSessionMember(ctx, sessionId);

    // Hard-error when ctx.participantId is missing. ConnectionIds rotate on
    // every reconnect, so falling back would leak the confirmer's identity
    // across reconnects and weaken the wire event. See takeControl above for
    // the full reasoning.
    if (!ctx.participantId) {
      throw new Error('confirmClimbOnWall requires ctx.participantId; refusing to fall back to connectionId.');
    }
    const participantId = ctx.participantId;

    // Correlate the wire climb against the session's recent-climbs ring
    // buffer (last RECENT_CLIMBS_BUFFER_SIZE authoritative wall climbs, per
    // services/distributed-state/constants.ts). Strict equality against
    // `currentClimbQueueItem` rejects legitimate confirms when the driver
    // navigates on in the ~hundreds-of-ms window between BLE write and
    // mutation arrival — the buffer turns over every wall change, so it
    // still gates against arbitrary stale/forged UUIDs without the race.
    const isRecent = await roomManager.isRecentClimb(sessionId, climbUuid);
    if (!isRecent) {
      throw new Error(
        `confirmClimbOnWall: climbUuid ${climbUuid.slice(0, 8)} not in session ${sessionId.slice(0, 8)}'s recent climbs`,
      );
    }

    pubsub.publishSessionEvent(sessionId, {
      __typename: 'WallConfirmedClimb',
      climbUuid,
      confirmedAt: new Date().toISOString(),
      confirmedByParticipantId: participantId,
      queueItemUuid: queueItemUuid ?? null,
    });

    // Mirror takeControl / releaseControl: return the resolved Session so
    // optimistic-UI callers can apply server-derived state without a
    // follow-up query. Fan the independent reads out in parallel.
    const [users, sessionData, queueState, driverParticipantId, lastConnectedBoardSerial, leaderConnectionId] =
      await Promise.all([
        roomManager.getSessionUsers(sessionId),
        roomManager.getSessionById(sessionId),
        roomManager.getQueueState(sessionId),
        roomManager.getSessionDriverParticipantId(sessionId),
        roomManager.getSessionBoardSerial(sessionId),
        roomManager.getSessionLeaderConnectionId(sessionId),
      ]);

    return {
      id: sessionId,
      name: sessionData?.name || null,
      boardPath: sessionData?.boardPath || '',
      users,
      queueState: {
        sequence: queueState.sequence,
        stateHash: queueState.stateHash,
        queue: queueState.queue,
        currentClimbQueueItem: queueState.currentClimbQueueItem,
      },
      isLeader: leaderConnectionId === ctx.connectionId,
      driverParticipantId,
      lastConnectedBoardSerial,
      clientId: ctx.connectionId,
      participantId,
      goal: sessionData?.goal || null,
      isPublic: sessionData?.isPublic ?? true,
      startedAt: sessionData?.startedAt?.toISOString() || null,
      endedAt: sessionData?.endedAt?.toISOString() || null,
      isPermanent: sessionData?.isPermanent ?? false,
      color: sessionData?.color || null,
    };
  },

  /**
   * Record the BLE board serial paired with this client's phone. The serial is
   * stored on the session (Redis when distributed, in-memory otherwise) so
   * other mobile participants can auto-connect to the same physical board.
   * Idempotent: when the stored serial already equals the incoming value, no
   * `SessionBoardSerialChanged` event is emitted. Returns the resolved
   * `Session` so optimistic-UI callers can apply server-derived state without
   * a follow-up query (symmetric with `takeControl` / `releaseControl`).
   * Session identity comes from the WebSocket connection context — no
   * `sessionId` argument.
   */
  setSessionBoardSerial: async (_: unknown, { serial }: { serial: string }, ctx: ConnectionContext) => {
    await applyRateLimit(ctx);
    // Session identity from the WebSocket context (WS-implicit pattern); no
    // sessionId argument.
    const sessionId = requireSession(ctx);
    validateInput(BoardSerialSchema, serial, 'serial');
    await requireSessionMember(ctx, sessionId);

    const previousSerial = await roomManager.setSessionBoardSerialAndReturnPrevious(sessionId, serial);
    if (previousSerial !== serial) {
      pubsub.publishSessionEvent(sessionId, {
        __typename: 'SessionBoardSerialChanged',
        lastConnectedBoardSerial: serial,
      });
    }

    // Hard-error when ctx.participantId is missing — same reasoning as
    // takeControl / confirmClimbOnWall: connectionIds aren't stable across
    // reconnects.
    if (!ctx.participantId) {
      throw new Error('setSessionBoardSerial requires ctx.participantId; refusing to fall back to connectionId.');
    }
    const participantId = ctx.participantId;

    // Mirror takeControl / releaseControl: return the resolved Session. Fan
    // the independent reads out in parallel — sequential awaits over six
    // unrelated lookups burns latency on every wall-pair. Re-read
    // `lastConnectedBoardSerial` from the room manager rather than echoing
    // the input: another writer (different participant on a different board)
    // can land between our write and this read, and the authoritative
    // value is what every other Session-returning resolver returns.
    const [users, sessionData, queueState, driverParticipantId, lastConnectedBoardSerial, leaderConnectionId] =
      await Promise.all([
        roomManager.getSessionUsers(sessionId),
        roomManager.getSessionById(sessionId),
        roomManager.getQueueState(sessionId),
        roomManager.getSessionDriverParticipantId(sessionId),
        roomManager.getSessionBoardSerial(sessionId),
        roomManager.getSessionLeaderConnectionId(sessionId),
      ]);

    return {
      id: sessionId,
      name: sessionData?.name || null,
      boardPath: sessionData?.boardPath || '',
      users,
      queueState: {
        sequence: queueState.sequence,
        stateHash: queueState.stateHash,
        queue: queueState.queue,
        currentClimbQueueItem: queueState.currentClimbQueueItem,
      },
      isLeader: leaderConnectionId === ctx.connectionId,
      driverParticipantId,
      lastConnectedBoardSerial,
      clientId: ctx.connectionId,
      participantId,
      goal: sessionData?.goal || null,
      isPublic: sessionData?.isPublic ?? true,
      startedAt: sessionData?.startedAt?.toISOString() || null,
      endedAt: sessionData?.endedAt?.toISOString() || null,
      isPermanent: sessionData?.isPermanent ?? false,
      color: sessionData?.color || null,
    };
  },

  /**
   * Release wall-control authority. Idempotent — when the caller is not the
   * current driver, the mutation is a no-op (returns the current session state
   * with `driverParticipantId` unchanged). Publishes `DriverChanged { null }`
   * only when the clear actually happened.
   */
  releaseControl: async (_: unknown, __: unknown, ctx: ConnectionContext) => {
    await applyRateLimit(ctx);
    const sessionId = requireSession(ctx);
    await requireSessionMember(ctx, sessionId);

    // Hard-error when ctx.participantId is missing. Falling back to
    // connectionId would silently fail to clear the driver key after the
    // user's connectionId rotated — the original takeControl wrote under
    // their stable participantId, and a release under a rotated connectionId
    // wouldn't match. See takeControl above for the full reasoning.
    if (!ctx.participantId) {
      throw new Error('releaseControl requires ctx.participantId; refusing to fall back to connectionId.');
    }
    const participantId = ctx.participantId;
    const cleared = await roomManager.clearSessionDriverIf(sessionId, participantId);

    if (cleared) {
      // `cleared = true` means the caller was the driver, so they are also the
      // previousDriverParticipantId carried on the event.
      pubsub.publishSessionEvent(sessionId, {
        __typename: 'DriverChanged',
        driverParticipantId: null,
        previousDriverParticipantId: participantId,
      });
    }

    // Fan the response-payload reads out in parallel — these five queries
    // are independent and sequential awaits only burn latency.
    // `driverParticipantId` is short-circuited when we just cleared (we
    // already know it's null), avoiding the extra read in that branch.
    const [users, sessionData, queueState, lastConnectedBoardSerial, leaderConnectionId, driverParticipantId] =
      await Promise.all([
        roomManager.getSessionUsers(sessionId),
        roomManager.getSessionById(sessionId),
        roomManager.getQueueState(sessionId),
        roomManager.getSessionBoardSerial(sessionId),
        roomManager.getSessionLeaderConnectionId(sessionId),
        cleared ? Promise.resolve(null) : roomManager.getSessionDriverParticipantId(sessionId),
      ]);

    return {
      id: sessionId,
      name: sessionData?.name || null,
      boardPath: sessionData?.boardPath || '',
      users,
      queueState: {
        sequence: queueState.sequence,
        stateHash: queueState.stateHash,
        queue: queueState.queue,
        currentClimbQueueItem: queueState.currentClimbQueueItem,
      },
      isLeader: leaderConnectionId === ctx.connectionId,
      driverParticipantId,
      lastConnectedBoardSerial,
      clientId: ctx.connectionId,
      participantId,
      goal: sessionData?.goal || null,
      isPublic: sessionData?.isPublic ?? true,
      startedAt: sessionData?.startedAt?.toISOString() || null,
      endedAt: sessionData?.endedAt?.toISOString() || null,
      isPermanent: sessionData?.isPermanent ?? false,
      color: sessionData?.color || null,
    };
  },

  /**
   * End a session explicitly.
   * Validates the caller is the creator or current leader.
   * Returns a session summary with stats, or null if no ticks.
   */
  endSession: async (_: unknown, { sessionId }: { sessionId: string }, ctx: ConnectionContext) => {
    await applyRateLimit(ctx, 5);
    validateInput(SessionIdSchema, sessionId, 'sessionId');
    // Ending a session is destructive (terminates every subscriber, generates
    // a summary row, marks the session ended in Postgres). The pre-#2128 code
    // required authentication unconditionally; the reland accidentally
    // narrowed the auth check to the HTTP branch only, which would let an
    // anonymous WS member who is the current leader destroy the session.
    // Restore the unconditional requirement so the WS branch's
    // membership-and-leadership check is gated on an authenticated principal.
    requireAuthenticated(ctx);

    const sessionData = await roomManager.getSessionById(sessionId);
    if (!sessionData) {
      throw new Error('Session not found');
    }

    if (ctx.transport === 'http') {
      if (!sessionData.createdByUserId || sessionData.createdByUserId !== ctx.userId) {
        throw new Error('Only the session creator can end this session over HTTP');
      }
    } else {
      await requireSessionMember(ctx, sessionId);
      // Use the authoritative leader from distributed state for authorization,
      // not `SessionUser.isLeader` derived from getSessionUsers. The user-list
      // path reads from `sessionParticipants` (or the connection-key fallback)
      // and can briefly show stale leadership during handoff — a participant
      // whose local entry still says isLeader=true could otherwise authorize
      // a destructive endSession after the leader has already moved on. The
      // leader key in Redis is the source of truth; compare connectionIds
      // directly since that's what's stored there.
      const isCreator = !!ctx.userId && sessionData.createdByUserId === ctx.userId;
      const leaderConnectionId = await roomManager.getSessionLeaderConnectionId(sessionId);
      // Note: `leaderConnectionId === null` is treated as "no current
      // leader" → the caller is not the leader. There is a brief window
      // between an election and the new leader key's TTL refresh where
      // the key can be momentarily absent; a current leader hitting that
      // window will get a 403 here instead of being authorized. With
      // connection/sessionTTL now aligned at 4h and REFRESH_TTL_SCRIPT
      // bumping the leader key on every refresh (A7), this window is on
      // the order of milliseconds. Behavior is a deliberate trade-off
      // for not trusting stale `SessionUser.isLeader`: failing closed is
      // safer than authorizing destructive ops on a stale read. The
      // creator path above always succeeds regardless.
      const isLeader = leaderConnectionId !== null && leaderConnectionId === ctx.connectionId;
      if (!isCreator && !isLeader) {
        logger.warn(
          `[endSession] authorization denied for session ${sessionId.slice(0, 8)}: connectionId=${ctx.connectionId.slice(0, 8)}, participantId=${ctx.participantId?.slice(0, 8) ?? 'none'}, userId=${ctx.userId?.slice(0, 8) ?? 'none'}, isAuthenticated=${ctx.isAuthenticated}, leaderConnectionId=${leaderConnectionId?.slice(0, 8) ?? 'none'}`,
        );
        throw new Error('Only the session creator or current leader can end this session');
      }
    }

    // End the session via room manager
    await roomManager.endSession(sessionId);

    // Publish SessionEnded event so all connected clients are notified
    const sessionEndedEvent: SessionEvent = {
      __typename: 'SessionEnded',
      reason: 'Session ended by participant',
    };
    pubsub.publishSessionEvent(sessionId, sessionEndedEvent);

    // Send APNs `end` push to dismiss every device's Live Activity. Without
    // this, other participants' lock-screen tiles linger with stale data
    // until ActivityKit's stale date elapses.
    try {
      await endLiveActivity(sessionId);
    } catch (err) {
      logger.error(`[APNs] endLiveActivity failed for session ${sessionId}:`, err);
    }

    // Generate and return summary
    const summary = await generateSessionSummary(sessionId);
    return summary;
  },

  /**
   * Update username and avatar for the current user in the session
   * Re-announces the user to all session members
   */
  updateUsername: async (
    _: unknown,
    { username, avatarUrl }: { username: string; avatarUrl?: string },
    ctx: ConnectionContext,
  ) => {
    // Validate inputs
    validateInput(UsernameSchema, username, 'username');
    if (avatarUrl) validateInput(AvatarUrlSchema, avatarUrl, 'avatarUrl');

    await roomManager.updateUsername(ctx.connectionId, username, avatarUrl);

    if (ctx.sessionId) {
      const client = roomManager.getClient(ctx.connectionId);
      if (client) {
        // Re-announce user with updated info
        pubsub.publishSessionEvent(ctx.sessionId, {
          __typename: 'UserJoined',
          user: {
            id: client.participantId || client.connectionId,
            username,
            isLeader: client.isLeader,
            avatarUrl: client.avatarUrl,
            userId: client.userId,
            connectionState: 'CONNECTED',
          },
        });
      }
    }

    return true;
  },
};
