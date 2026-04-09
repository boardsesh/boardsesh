import { createRequestDb } from '@boardsesh/db/client';
import { sessions, type Session } from '../../db/schema';
import { eq, and, gt, gte, lte, ne } from 'drizzle-orm';
import type { RedisSessionStore } from '../redis-session-store';
import type { DistributedStateManager } from '../distributed-state';
import { haversineDistance, getBoundingBox, DEFAULT_SEARCH_RADIUS_METERS } from '../../utils/geo';
import type { DiscoverableSession } from './types';

/**
 * Get a session by its ID from the database.
 */
export async function getSessionById(sessionId: string): Promise<Session | null> {
  const db = createRequestDb();
  const result = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  return result[0] || null;
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
  color?: string
): Promise<Session> {
  const db = createRequestDb();
  const now = new Date();
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
  distributedState: DistributedStateManager | null
): Promise<DiscoverableSession[]> {
  const db = createRequestDb();
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
        lte(sessions.longitude, box.maxLon)
      )
    );

  type SessionWithCoords = Session & { latitude: number; longitude: number };
  const sessionsWithDistance = candidates
    .filter((s): s is SessionWithCoords =>
      s.latitude !== null && s.longitude !== null)
    .map((s: SessionWithCoords) => ({
      session: s,
      distance: haversineDistance(latitude, longitude, s.latitude, s.longitude),
    }))
    .filter((item: { session: SessionWithCoords; distance: number }) => item.distance <= radiusMeters)
    .sort((a: { distance: number }, b: { distance: number }) => a.distance - b.distance);

  const sessionIds = sessionsWithDistance.map(({ session }) => session.id);

  // Batch check Redis existence to avoid N+1 queries
  let redisExistsMap: Map<string, boolean> = new Map();
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
      latitude: session.latitude!,
      longitude: session.longitude!,
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
  const db = createRequestDb();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const result = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.createdByUserId, userId),
        gt(sessions.createdAt, sevenDaysAgo)
      )
    )
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
  writeScheduler: import('./write-scheduler').WriteScheduler,
  sessionGraceTimers: Map<string, NodeJS.Timeout>,
  pendingJoinPersists: Map<string, Promise<void>>
): Promise<void> {
  const db = createRequestDb();
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
  await db
    .update(sessions)
    .set({ status: 'ended', lastActivity: now, endedAt: now })
    .where(eq(sessions.id, sessionId));

  // Remove from memory
  sessionsMap.delete(sessionId);

  console.log(`[RoomManager] Session ${sessionId} explicitly ended`);
}
