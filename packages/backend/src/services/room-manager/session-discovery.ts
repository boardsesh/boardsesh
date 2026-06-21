import { db } from '../../db/client';
import { sessions, type Session } from '../../db/schema';
import { userBoards } from '@boardsesh/db/schema/app';
import { eq, and, gt, gte, lt, lte, ne, isNull, sql } from 'drizzle-orm';
import type { RedisSessionStore } from '../redis-session-store';
import type { DistributedStateManager } from '../distributed-state';
import type { WriteScheduler } from './write-scheduler';
import { haversineDistance, getBoundingBox, DEFAULT_SEARCH_RADIUS_METERS } from '../../utils/geo';
import type { DiscoverableSession } from './types';
import { logger } from '../../utils/logger';

/**
 * Get a session by its ID from the database.
 */
export async function getSessionById(sessionId: string): Promise<Session | null> {
  const result = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  return result[0] || null;
}

/**
 * Update the session's stored boardPath. Returns the previous value when
 * the update actually mutated state, or `null` when the row was already
 * at `boardPath` (idempotent no-op). Throws when the session row doesn't
 * exist — distinguishing "not found" from "unchanged" lets the caller
 * publish `SessionBoardPathChanged` strictly on real transitions instead
 * of overloading `null` across both meanings.
 *
 * **Not atomic.** Two queries: SELECT the existing boardPath, then UPDATE
 * if it differs. Two concurrent callers can both read the same prior
 * value and both publish `SessionBoardPathChanged`. We accept this because
 * the event is idempotent on the client (`router.replace` to the same URL
 * is a no-op) and the realistic write pressure is one angle-selector tap
 * at a time per device. If a future caller can't tolerate double-publish,
 * tighten to a single-statement CTE
 * (`UPDATE sessions SET boardPath = $2, ... FROM (SELECT boardPath AS prev FROM sessions WHERE id = $1) sub WHERE id = $1 AND sub.prev <> $2 RETURNING sub.prev`)
 * or use Redis-backed CAS the same way `setSessionBoardSerialAndReturnPrevious`
 * does. The concurrent double-publish path is pinned in
 * `wall-confirm-and-board-serial.test.ts`'s `setSessionBoardPath` block.
 */
export async function updateSessionBoardPathIfChanged(sessionId: string, boardPath: string): Promise<string | null> {
  // Read-then-write — simpler than a CTE and matches the
  // setSessionBoardSerialAndReturnPrevious shape elsewhere. See the outer
  // JSDoc for the non-atomicity contract this consciously accepts.
  const existing = await db
    .select({ boardPath: sessions.boardPath })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (existing.length === 0) {
    // Resolvers should reach the helper only after `requireSessionMember`,
    // which already throws when the row is missing. Reaching this branch
    // means a race between leave/sweep and the boardPath write — surface
    // it explicitly rather than returning `null` (the "unchanged" signal).
    throw new Error(`updateSessionBoardPathIfChanged: session ${sessionId} not found`);
  }
  const previous = existing[0].boardPath;
  if (previous === boardPath) return null;
  await db.update(sessions).set({ boardPath, lastActivity: new Date() }).where(eq(sessions.id, sessionId));
  return previous;
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
): Promise<Session> {
  const now = new Date();

  // Auto-resolve boardId from slug paths (e.g., "/b/my-home-wall")
  let boardId: number | null = null;
  const slugMatch = boardPath.match(/^\/b\/([^/]+)/);
  if (slugMatch) {
    const boardRows = await db
      .select({ id: userBoards.id })
      .from(userBoards)
      .where(and(eq(userBoards.slug, slugMatch[1]), isNull(userBoards.deletedAt)))
      .limit(1);
    if (boardRows[0]) {
      boardId = boardRows[0].id;
    }
  }

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
      },
    })
    .returning();

  return result[0];
}

/**
 * Find discoverable sessions near a location (within radius).
 * Uses bounding box for initial SQL filter, then precise Haversine distance.
 */
export async function findNearbySessions(
  latitude: number,
  longitude: number,
  radiusMeters: number = DEFAULT_SEARCH_RADIUS_METERS,
  sessionsMap: Map<string, Set<string>>,
  redisStore: RedisSessionStore | null,
  distributedState: DistributedStateManager | null,
): Promise<DiscoverableSession[]> {
  const box = getBoundingBox(latitude, longitude, radiusMeters);

  const candidates = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.discoverable, true),
        ne(sessions.status, 'ended'),
        gte(sessions.latitude, box.minLat),
        lte(sessions.latitude, box.maxLat),
        gte(sessions.longitude, box.minLon),
        lte(sessions.longitude, box.maxLon),
      ),
    );

  type SessionWithCoords = Session & { latitude: number; longitude: number };
  const sessionsWithDistance = candidates
    .filter((s): s is SessionWithCoords => s.latitude !== null && s.longitude !== null)
    .map((s: SessionWithCoords) => ({
      session: s,
      distance: haversineDistance(latitude, longitude, s.latitude, s.longitude),
    }))
    .filter((item: { session: SessionWithCoords; distance: number }) => item.distance <= radiusMeters)
    .sort((a: { distance: number }, b: { distance: number }) => a.distance - b.distance);

  const sessionIds = sessionsWithDistance.map(({ session }) => session.id);

  // Batch check Redis existence to avoid N+1 queries
  let redisExistsMap = new Map<string, boolean>();
  if (redisStore && sessionIds.length > 0) {
    redisExistsMap = await redisStore.batchExists(sessionIds);
  }

  const result: DiscoverableSession[] = [];
  for (const { session, distance } of sessionsWithDistance) {
    let participantCount: number;
    if (distributedState) {
      participantCount = await distributedState.getSessionMemberCount(session.id);
    } else {
      participantCount = sessionsMap.get(session.id)?.size || 0;
    }

    let isActive = participantCount > 0;
    if (!isActive && redisStore) {
      isActive = redisExistsMap.get(session.id) || false;
    }

    if (!isActive) {
      continue;
    }

    result.push({
      id: session.id,
      name: session.name,
      boardPath: session.boardPath,
      latitude: session.latitude,
      longitude: session.longitude,
      createdAt: session.createdAt,
      createdByUserId: session.createdByUserId,
      participantCount,
      distance,
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
export async function getUserSessions(userId: string): Promise<Session[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const result = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.createdByUserId, userId), gt(sessions.createdAt, sevenDaysAgo)))
    .orderBy(sessions.lastActivity);

  return result;
}

/**
 * Explicitly end a session (user action).
 */
export async function endSession(
  sessionId: string,
  sessionsMap: Map<string, Set<string>>,
  redisStore: RedisSessionStore | null,
  writeScheduler: WriteScheduler,
  sessionGraceTimers: Map<string, NodeJS.Timeout>,
  pendingJoinPersists: Map<string, Promise<void>>,
): Promise<void> {
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
      .where(and(eq(sessions.status, 'active'), eq(sessions.isPermanent, false), lt(sessions.lastActivity, cutoff)))
      .returning({ id: sessions.id });
    if (result.length > 0) {
      logger.info(`[RoomManager] Auto-ended ${result.length} inactive session(s)`);
    }
    return result.map((row) => row.id);
  });
}
