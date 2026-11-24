import { GraphQLError } from 'graphql';
import {
  resolveLockedSessionBoardId,
  resolveSessionBoardId,
  SESSION_BOARD_LOCK_TIMEOUT_MS,
} from '../session-board-binding';
import { lockActiveBoardForWrite } from '../board-reference-lock';
import type { DbTransaction } from '../../db/after-commit';
import { publishSessionBoardPathChanged } from '../session-wall-refresh';
import {
  notifyResourcePrivacyChanged,
  projectSessionBoardPath,
  sessionsVisibleUserIds,
} from '../board-session-privacy';
import { requireResourceAccess, resourceAccessCondition, sessionBoardLocationCondition } from '../privacy';
import { db, runWithDatabaseTransaction } from '../../db/client';
import { sessions, type Session } from '../../db/schema';
import { sessionBoards } from '@boardsesh/db/schema/app';
import { eq, and, asc, gt, gte, lt, lte, ne, sql, getTableColumns } from 'drizzle-orm';
import { haversineDistance, getBoundingBox, DEFAULT_SEARCH_RADIUS_METERS } from '../../utils/geo';
import type { DiscoverableSession, LiveSession, RoomManagerDeps } from './types';
import { logger } from '../../utils/logger';
import type { PartnerDatabase } from '../../auth/partner/tables';
import {
  lockSessionAppWorkouts,
  lockSessionAppWorkoutUsers,
  completeSessionAppWorkouts,
} from '../public-api/workout-lifecycle';
import { lockAppWorkoutSession, type AppWorkoutRow } from '../public-api/workouts';
import { reportCompletedAppWorkouts } from '../public-api/workout-telemetry';
import { hasLiveConnectionsOrSessionKey, readSessionLiveness } from './session-liveness';

/**
 * Rows that back a live session — party mode, presence, queue, the lot.
 *
 * `board_sessions` also holds inferred sessions (`origin = 'inferred'`), which are
 * reconstructed from tick timing and are over before they exist. They have no board
 * path and nothing to join, so every live-session loader scopes them out here rather
 * than leaving each caller to remember. See `docs/data/inferred-sessions.md`.
 */
const isLiveSessionRow = eq(sessions.origin, 'explicit');

/**
 * Narrow a row to a {@link LiveSession}.
 *
 * Only inferred sessions have a null `board_path` and `isLiveSessionRow` has already
 * excluded those, so this discards nothing in practice. It states the invariant to the
 * type system instead of asserting past it, which means a future writer that leaves an
 * explicit session without a board path gets dropped here rather than crashing a
 * caller that assumed the string.
 */
function toLiveSession(row: Session): LiveSession | null {
  return row.boardPath === null ? null : { ...row, boardPath: row.boardPath };
}

/**
 * Get a session by its ID from the database.
 */
export async function getSessionById(sessionId: string): Promise<LiveSession | null> {
  const result = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), isLiveSessionRow))
    .limit(1);
  return result[0] ? toLiveSession(result[0]) : null;
}

/** Change the path and its durable privacy parents in the same transaction. */
export async function updateSessionBoardPathIfChanged(
  sessionId: string,
  boardPath: string,
  viewerId?: string | null,
  changedByParticipantId: string | null = null,
): Promise<string | null> {
  const transition = await runWithDatabaseTransaction(async (executor) => {
    const tx = executor as unknown as DbTransaction;
    const [snapshot] = await tx
      .select({ boardPath: sessions.boardPath, boardId: sessions.boardId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!snapshot) throw new Error(`updateSessionBoardPathIfChanged: session ${sessionId} not found`);
    const boardId = await resolveSessionBoardId(boardPath, viewerId, sessionId);
    const previousPathBoardId =
      snapshot.boardId ?? (await resolveSessionBoardId(snapshot.boardPath ?? '', viewerId, sessionId));
    // A session is readable only through every wall it references. Prior wall
    // activity stays capped when the party moves to another wall.
    const parents = [
      ...new Set([snapshot.boardId, previousPathBoardId, boardId].filter((id): id is number => id !== null)),
    ];
    for (const parentId of [...parents].sort((first, second) => first - second)) {
      if (!(await lockActiveBoardForWrite(tx, { id: parentId }, { lockTimeoutMs: SESSION_BOARD_LOCK_TIMEOUT_MS })))
        throw new GraphQLError('Board not found', { extensions: { code: 'NOT_FOUND' } });
    }
    // Board-before-session matches tick writers. Recheck the snapshot after
    // taking the session lock so a concurrent wall move cannot supply access.
    const [existing] = await tx
      .select({ boardPath: sessions.boardPath, boardId: sessions.boardId })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .for('update');
    if (!existing || existing.boardPath !== snapshot.boardPath || existing.boardId !== snapshot.boardId)
      throw new GraphQLError('This session changed. Retry the session action.', { extensions: { code: 'CONFLICT' } });
    if ((await resolveSessionBoardId(boardPath, viewerId, sessionId)) !== boardId)
      throw new GraphQLError('Board not found', { extensions: { code: 'NOT_FOUND' } });
    await requireResourceAccess('session', sessionId, viewerId);
    if (existing.boardPath === boardPath && existing.boardId === boardId) return null;
    if (parents.length)
      await tx
        .insert(sessionBoards)
        .values(parents.map((parentId) => ({ sessionId, boardId: parentId })))
        .onConflictDoNothing();
    await tx.update(sessions).set({ boardPath, boardId, lastActivity: new Date() }).where(eq(sessions.id, sessionId));
    return {
      previous: existing.boardPath,
      parentChanged: existing.boardId !== boardId || previousPathBoardId !== boardId,
    };
  });
  if (!transition) return null;
  // Viewers who lost the session through the new wall are refused on their
  // next read, and their live streams end at their next event. A move to
  // another wall changes identity projections for opted-in climbers, even when
  // both walls are public, so connected peers re-project their roster and
  // queue. An angle change keeps the wall: peers only apply the path.
  // Published before the preview's fallible reads.
  publishSessionBoardPathChanged(sessionId, boardPath, changedByParticipantId, transition.parentChanged);
  if (transition.parentChanged) {
    // The move has committed, and a retry would find the path already stored,
    // so a failed kiosk refresh is logged rather than failing the move.
    try {
      await notifyResourcePrivacyChanged('session', sessionId);
    } catch (error) {
      logger.error('[SessionDiscovery] kiosk preview refresh failed after a committed wall move', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return transition.previous;
}

/**
 * Create a discoverable session with GPS coordinates.
 */
export async function createDiscoverableSession(
  sessionId: string,
  boardPath: string,
  userId: string,
  latitude: number,
  longitude: number,
  name?: string,
  goal?: string,
  isPermanent?: boolean,
  color?: string,
  isPublic: boolean = true,
): Promise<Session> {
  const now = new Date();

  return runWithDatabaseTransaction(async (executor) => {
    const tx = executor as unknown as DbTransaction;
    const boardId = await resolveLockedSessionBoardId(tx, boardPath, userId);

    const result = await tx
      .insert(sessions)
      .values({
        id: sessionId,
        boardPath,
        latitude,
        longitude,
        discoverable: true,
        createdByUserId: userId,
        name: name || null,
        lastActivity: now,
        goal: goal || null,
        isPermanent: isPermanent || false,
        color: color || null,
        startedAt: now,
        boardId,
        isPublic,
      })
      .onConflictDoUpdate({
        target: sessions.id,
        set: {
          boardPath,
          latitude,
          longitude,
          discoverable: true,
          createdByUserId: userId,
          name: name || null,
          lastActivity: now,
          goal: goal || null,
          isPermanent: isPermanent || false,
          color: color || null,
          startedAt: now,
          boardId,
          isPublic,
        },
        setWhere: and(
          eq(sessions.createdByUserId, userId),
          eq(sessions.boardPath, boardPath),
          sql`${sessions.boardId} IS NOT DISTINCT FROM ${boardId}`,
        ),
      })
      .returning();

    if (!result[0]) throw new GraphQLError('Session not found', { extensions: { code: 'NOT_FOUND' } });
    return result[0];
  });
}

/**
 * Find discoverable sessions near a location (within radius).
 * Uses bounding box for initial SQL filter, then precise Haversine distance.
 */
export async function findNearbySessions(
  deps: RoomManagerDeps,
  latitude: number,
  longitude: number,
  radiusMeters: number = DEFAULT_SEARCH_RADIUS_METERS,
  viewerId?: string,
): Promise<DiscoverableSession[]> {
  const box = getBoundingBox(latitude, longitude, radiusMeters);

  const candidates = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.discoverable, true),
        // Nearby is discovery: an unlisted session's link never lists it.
        resourceAccessCondition('session', sessions.id, viewerId, { allowUnlistedLink: false }),
        sessionBoardLocationCondition(sessions.id, viewerId),
        ne(sessions.status, 'ended'),
        gte(sessions.latitude, box.minLat),
        lte(sessions.latitude, box.maxLat),
        gte(sessions.longitude, box.minLon),
        lte(sessions.longitude, box.maxLon),
        isLiveSessionRow,
      ),
    );

  type SessionWithCoords = LiveSession & { latitude: number; longitude: number };
  const sessionsWithDistance = candidates
    .filter((s): s is SessionWithCoords => s.latitude !== null && s.longitude !== null && s.boardPath !== null)
    .map((s: SessionWithCoords) => ({
      session: s,
      distance: haversineDistance(latitude, longitude, s.latitude, s.longitude),
    }))
    .filter((item: { session: SessionWithCoords; distance: number }) => item.distance <= radiusMeters)
    .sort((a: { distance: number }, b: { distance: number }) => a.distance - b.distance);

  const livenessBySession = await readSessionLiveness(
    deps,
    sessionsWithDistance.map(({ session }) => session.id),
  );

  const liveSessions = sessionsWithDistance.flatMap(({ session, distance }) => {
    const liveness = livenessBySession.get(session.id);
    return liveness && hasLiveConnectionsOrSessionKey(liveness)
      ? [{ session, distance, participantCount: liveness.participantCount }]
      : [];
  });
  // The host is named by their account, and stays anonymous when they chose to
  // and the session's board is not theirs (or nothing places it on one yet).
  // One query for every host on the page.
  const visibleHosts = await sessionsVisibleUserIds(
    liveSessions.map(({ session }) => ({ session, userIds: [session.createdByUserId] })),
    viewerId,
  );

  return Promise.all(
    liveSessions.map(async ({ session, distance, participantCount }, index): Promise<DiscoverableSession> => ({
      id: session.id,
      name: session.name,
      // A deleted or renamed named board's slug is not this viewer's to read,
      // and a nearby listing is discovery: an unlisted gym's walls stay unnamed.
      boardPath: await projectSessionBoardPath(session.boardPath, viewerId, { discovery: true }),
      latitude: 0,
      longitude: 0,
      createdAt: session.createdAt,
      createdByUserId:
        session.createdByUserId && visibleHosts[index].has(session.createdByUserId) ? session.createdByUserId : null,
      participantCount,
      distance: Math.ceil(distance / 1000) * 1000,
      isActive: true,
      goal: session.goal || null,
      isPublic: session.isPublic,
      isPermanent: session.isPermanent,
      color: session.color || null,
    })),
  );
}

/**
 * Get sessions created by a user (within 7 days).
 */
export async function getUserSessions(userId: string): Promise<LiveSession[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const result = await db
    .select({ ...getTableColumns(sessions), locationVisible: sessionBoardLocationCondition(sessions.id, userId) })
    .from(sessions)
    .where(
      and(
        eq(sessions.createdByUserId, userId),
        gt(sessions.createdAt, sevenDaysAgo),
        isLiveSessionRow,
        resourceAccessCondition('session', sessions.id, userId),
      ),
    )
    .orderBy(sessions.lastActivity);

  return result
    .map(({ locationVisible, ...session }) =>
      toLiveSession(locationVisible ? session : { ...session, latitude: null, longitude: null }),
    )
    .filter((session): session is LiveSession => session !== null);
}

/**
 * Explicitly end a session (user action).
 */
export async function endSession(deps: RoomManagerDeps, sessionId: string): Promise<void> {
  const { sessions: sessionsMap, redisStore, writeScheduler, sessionGraceTimers, pendingJoinPersists } = deps;

  // Cancel any pending writes to prevent FK violations after session ends
  writeScheduler.cancelPendingWrites(sessionId);

  // Clear grace timer if one exists
  const graceTimer = sessionGraceTimers.get(sessionId);
  if (graceTimer) {
    clearTimeout(graceTimer);
    sessionGraceTimers.delete(sessionId);
  }

  // Await pending join persist
  const pending = pendingJoinPersists.get(sessionId);
  if (pending) {
    await pending;
  }

  // Remove from Redis
  if (redisStore) {
    await redisStore.deleteSession(sessionId);
  }

  // Mark as ended in Postgres
  const now = new Date();
  const completedWorkouts = await db.transaction(async (tx) => {
    const transaction = tx as unknown as PartnerDatabase;
    const workouts = await lockSessionAppWorkouts(transaction, sessionId);
    const ended = await tx
      .update(sessions)
      .set({ status: 'ended', lastActivity: now, endedAt: now })
      .where(and(eq(sessions.id, sessionId), ne(sessions.status, 'ended')))
      .returning({ id: sessions.id });
    if (ended.length) {
      await completeSessionAppWorkouts(transaction, workouts, 'completed', now);
      return workouts;
    }
    return [];
  });
  await reportCompletedAppWorkouts(completedWorkouts, 'completed');

  // Remove from memory
  sessionsMap.delete(sessionId);

  logger.info(`[RoomManager] Session ${sessionId} explicitly ended`);
}

// Advisory lock slot for the inactivity sweep (derived from issue #1955).
// Postgres accepts a bigint; this slot just needs to be distinct from any
// other advisory lock keys we add later.
//
// Reserved range for app-level advisory locks in this package: 19550000 –
// 19559999 (i.e. ~10k slots seeded from issue #1955). New advisory locks
// should pick another unused integer in that range and add a comment here
// describing what they're for, so collisions stay greppable.
const INACTIVITY_SWEEP_LOCK_KEY = 19551850;

/**
 * Mark sessions as ended when they have been inactive for longer than `thresholdMs`.
 * Permanent sessions are exempt. Skips Redis / WriteScheduler cleanup because these
 * sessions have no live clients (otherwise lastActivity would have been refreshed).
 *
 * Uses a Postgres transaction-scoped advisory lock so in multi-instance deploys
 * only one instance runs the UPDATE per tick; the others see `locked=false`
 * and return 0 immediately. The UPDATE itself is idempotent (already-ended
 * rows don't re-match the WHERE clause), so the lock is a fan-out optimisation
 * rather than a correctness requirement.
 *
 * Returns the IDs of sessions that were ended so the caller can fire follow-up
 * side effects (publish SessionEnded events, end any active iOS Live
 * Activities). Returns an empty array when another instance held the advisory
 * lock for this tick.
 */
export async function endStaleInactiveSessions(thresholdMs: number): Promise<string[]> {
  const completedWorkouts: AppWorkoutRow[] = [];
  const endedSessionIds = await db.transaction(async (tx) => {
    const lockResult = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(${INACTIVITY_SWEEP_LOCK_KEY}) AS locked`,
    );
    if (!lockResult[0]?.locked) {
      return [];
    }

    const cutoff = new Date(Date.now() - thresholdMs);
    // endedAt mirrors the existing lastActivity so session duration reflects
    // when the user actually stopped, not when the sweep ran. lastActivity is
    // left untouched so the column keeps recording last-evidence going forward.
    const candidates = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.status, 'active'),
          eq(sessions.isPermanent, false),
          lt(sessions.lastActivity, cutoff),
          // Inferred sessions are written already-ended, so this would not match
          // them today — but the guard is cheap and the failure it prevents is
          // silent: a sweep rewriting `ended_at` across reconstructed history
          // would corrupt session durations with nothing to show for it.
          isLiveSessionRow,
        ),
      )
      .orderBy(asc(sessions.id))
      .limit(100);
    const result: Array<{ id: string }> = [];
    // Take every session fence before any user/connection lock. Otherwise a
    // later session could wait for an End holding its fence and awaiting a
    // connection that an earlier session in this batch already holds.
    for (const candidate of candidates) await lockAppWorkoutSession(tx as unknown as PartnerDatabase, candidate.id);
    await lockSessionAppWorkoutUsers(
      tx as unknown as PartnerDatabase,
      candidates.map((candidate) => candidate.id),
    );
    for (const candidate of candidates) {
      const transaction = tx as unknown as PartnerDatabase;
      const workouts = await lockSessionAppWorkouts(transaction, candidate.id);
      const [ended] = await tx
        .update(sessions)
        .set({ status: 'ended', endedAt: sql`${sessions.lastActivity}` })
        .where(and(eq(sessions.id, candidate.id), eq(sessions.status, 'active'), lt(sessions.lastActivity, cutoff)))
        .returning({ id: sessions.id, endedAt: sessions.endedAt });
      if (ended) {
        await completeSessionAppWorkouts(transaction, workouts, 'auto_closed', ended.endedAt ?? new Date());
        completedWorkouts.push(...workouts);
        result.push({ id: ended.id });
      }
    }
    if (result.length > 0) {
      logger.info(`[RoomManager] Auto-ended ${result.length} inactive session(s)`);
    }
    return result.map((row) => row.id);
  });
  await reportCompletedAppWorkouts(completedWorkouts, 'auto_closed');
  return endedSessionIds;
}
