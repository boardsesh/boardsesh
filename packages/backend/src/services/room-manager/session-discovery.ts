import { GraphQLError } from 'graphql';
import { resolveSessionBoardId } from '../session-board-binding';
import { notifyResourcePrivacyChanged } from '../board-session-privacy';
import { pubsub } from '../../pubsub';
import {
  canViewActivityIdentity,
  requireResourceAccess,
  resourceAccessCondition,
  sessionBoardLocationCondition,
} from '../privacy';
import { db } from '../../db/client';
import { sessions, type Session } from '../../db/schema';
import { sessionBoards } from '@boardsesh/db/schema/app';
import { eq, and, gt, gte, lt, lte, ne, isNull, sql, getTableColumns } from 'drizzle-orm';
import { haversineDistance, getBoundingBox, DEFAULT_SEARCH_RADIUS_METERS } from '../../utils/geo';
import type { DiscoverableSession, LiveSession, RoomManagerDeps } from './types';
import { logger } from '../../utils/logger';
import { hasLiveConnectionsOrSessionKey, readSessionLiveness } from './session-liveness';

/**
 * Rows that back a live session — party mode, presence, queue, the lot.
 *
 * `board_sessions` also holds inferred sessions (`origin = 'inferred'`), which are
 * reconstructed from tick timing and are over before they exist. They have no board
 * path and nothing to join, so every live-session loader scopes them out here rather
 * than leaving each caller to remember. See `docs/inferred-sessions.md`.
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
): Promise<string | null> {
  const boardId = await resolveSessionBoardId(boardPath, viewerId);
  const transition = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ boardPath: sessions.boardPath, boardId: sessions.boardId })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .for('update');
    if (!existing) throw new Error(`updateSessionBoardPathIfChanged: session ${sessionId} not found`);
    await requireResourceAccess('session', sessionId, viewerId);
    const previousPathBoardId = await resolveSessionBoardId(existing.boardPath ?? '', viewerId);
    if (existing.boardPath === boardPath && existing.boardId === boardId) return null;
    // Prior wall activity stays capped when the party moves to another wall.
    const parents = [
      ...new Set([existing.boardId, previousPathBoardId, boardId].filter((id): id is number => id !== null)),
    ];
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
  if (transition.parentChanged) {
    await pubsub.publishPrivacyChanged();
    await notifyResourcePrivacyChanged('session', sessionId);
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

  const boardId = await resolveSessionBoardId(boardPath, userId);

  const result = await db
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
        resourceAccessCondition('session', sessions.id, viewerId),
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

  const result: DiscoverableSession[] = [];
  for (const { session, distance } of sessionsWithDistance) {
    const liveness = livenessBySession.get(session.id);
    if (!liveness || !hasLiveConnectionsOrSessionKey(liveness)) {
      continue;
    }
    const { participantCount } = liveness;

    result.push({
      id: session.id,
      name: session.name,
      boardPath: session.boardPath,
      latitude: 0,
      longitude: 0,
      createdAt: session.createdAt,
      createdByUserId:
        session.createdByUserId &&
        (await canViewActivityIdentity(session.createdByUserId, viewerId, { sessionId: session.id }))
          ? session.createdByUserId
          : null,
      participantCount,
      distance: Math.ceil(distance / 1000) * 1000,
      isActive: true,
      goal: session.goal || null,
      isPublic: session.isPublic,
      isPermanent: session.isPermanent,
      color: session.color || null,
    });
  }

  return result;
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
  await db.update(sessions).set({ status: 'ended', lastActivity: now, endedAt: now }).where(eq(sessions.id, sessionId));

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
  return db.transaction(async (tx) => {
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
    const result = await tx
      .update(sessions)
      .set({ status: 'ended', endedAt: sql`${sessions.lastActivity}` })
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
      .returning({ id: sessions.id });
    if (result.length > 0) {
      logger.info(`[RoomManager] Auto-ended ${result.length} inactive session(s)`);
    }
    return result.map((row) => row.id);
  });
}
