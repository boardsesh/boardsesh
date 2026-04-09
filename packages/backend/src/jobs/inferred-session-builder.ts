import { v5 as uuidv5 } from 'uuid';
import { db } from '../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { sql, eq, and, isNull, desc, inArray } from 'drizzle-orm';
import { recalculateSessionStats } from '../graphql/resolvers/social/session-mutations';

// Namespace UUID for generating deterministic inferred session IDs
const INFERRED_SESSION_NAMESPACE = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';

// 4 hours in milliseconds
const SESSION_GAP_MS = 4 * 60 * 60 * 1000;

/**
 * Tick data needed for session grouping
 */
export interface TickForGrouping {
  id: bigint | number;
  uuid: string;
  userId: string;
  climbedAt: string;
  status: string;
  sessionId: string | null;
  inferredSessionId: string | null;
}

/**
 * Result of grouping ticks into inferred sessions
 */
export interface InferredSessionGroup {
  sessionId: string;
  userId: string;
  firstTickAt: string;
  lastTickAt: string;
  tickUuids: string[];
  totalSends: number;
  totalFlashes: number;
  totalAttempts: number;
  tickCount: number;
}

/**
 * Generate a deterministic UUID v5 for an inferred session.
 * Same (userId, firstTickTimestamp) always produces the same ID.
 */
export function generateInferredSessionId(userId: string, firstTickTimestamp: string): string {
  return uuidv5(`${userId}:${firstTickTimestamp}`, INFERRED_SESSION_NAMESPACE);
}

/**
 * Pure function: group ticks into inferred sessions based on 4-hour gap heuristic.
 * Only groups ticks that don't already have a sessionId or inferredSessionId.
 * Returns groups per-user (multi-user ticks at the same time produce separate sessions).
 */
export function groupTicksIntoSessions(ticks: TickForGrouping[]): InferredSessionGroup[] {
  // Filter to ticks that need assignment
  const unassigned = ticks.filter(
    (t) => t.sessionId === null && t.inferredSessionId === null,
  );

  if (unassigned.length === 0) return [];

  // Group by user
  const byUser = new Map<string, TickForGrouping[]>();
  for (const tick of unassigned) {
    const userTicks = byUser.get(tick.userId) ?? [];
    userTicks.push(tick);
    byUser.set(tick.userId, userTicks);
  }

  const sessions: InferredSessionGroup[] = [];

  for (const [userId, userTicks] of byUser) {
    // Sort by climbedAt ascending
    userTicks.sort(
      (a, b) => new Date(a.climbedAt).getTime() - new Date(b.climbedAt).getTime(),
    );

    let currentGroup: TickForGrouping[] = [userTicks[0]];

    for (let i = 1; i < userTicks.length; i++) {
      const prevTime = new Date(userTicks[i - 1].climbedAt).getTime();
      const currTime = new Date(userTicks[i].climbedAt).getTime();
      const gap = currTime - prevTime;

      if (gap > SESSION_GAP_MS) {
        // Gap exceeds threshold — finalize current group and start new one
        sessions.push(buildSessionGroup(userId, currentGroup));
        currentGroup = [userTicks[i]];
      } else {
        currentGroup.push(userTicks[i]);
      }
    }

    // Finalize last group
    sessions.push(buildSessionGroup(userId, currentGroup));
  }

  return sessions;
}

function buildSessionGroup(userId: string, ticks: TickForGrouping[]): InferredSessionGroup {
  const firstTickAt = ticks[0].climbedAt;
  const lastTickAt = ticks[ticks.length - 1].climbedAt;
  const sessionId = generateInferredSessionId(userId, firstTickAt);

  let totalSends = 0;
  let totalFlashes = 0;
  let totalAttempts = 0;

  for (const tick of ticks) {
    if (tick.status === 'flash') {
      totalFlashes++;
      totalSends++;
    } else if (tick.status === 'send') {
      totalSends++;
    } else if (tick.status === 'attempt') {
      totalAttempts++;
    }
  }

  return {
    sessionId,
    userId,
    firstTickAt,
    lastTickAt,
    tickUuids: ticks.map((t) => t.uuid),
    totalSends,
    totalFlashes,
    totalAttempts,
    tickCount: ticks.length,
  };
}

/**
 * Assign an inferred session to a newly-created tick (called from saveTick).
 * Checks the user's most recent tick to determine if this tick belongs
 * to an existing inferred session or starts a new one.
 */
/**
 * Core logic for assigning an inferred session to a tick.
 * Extracted so it can be called with either a transaction or the global db.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function assignInferredSessionWithConn(
  conn: any,
  tickUuid: string,
  userId: string,
  climbedAt: string,
): Promise<string | null> {
  // Find user's most recent tick (excluding the current one)
  const [prevTick] = await conn
    .select({
      inferredSessionId: dbSchema.boardseshTicks.inferredSessionId,
      climbedAt: dbSchema.boardseshTicks.climbedAt,
    })
    .from(dbSchema.boardseshTicks)
    .where(
      and(
        eq(dbSchema.boardseshTicks.userId, userId),
        sql`${dbSchema.boardseshTicks.uuid} != ${tickUuid}`,
        isNull(dbSchema.boardseshTicks.sessionId),
      ),
    )
    .orderBy(desc(dbSchema.boardseshTicks.climbedAt))
    .limit(1);

  const currentTime = new Date(climbedAt).getTime();

  if (prevTick) {
    const prevTime = new Date(prevTick.climbedAt).getTime();
    const gap = Math.abs(currentTime - prevTime);

    if (gap <= SESSION_GAP_MS && prevTick.inferredSessionId) {
      // Within 4h of previous tick — join the same inferred session
      const sessionId = prevTick.inferredSessionId;

      // Assign tick to the existing session
      await conn
        .update(dbSchema.boardseshTicks)
        .set({ inferredSessionId: sessionId })
        .where(eq(dbSchema.boardseshTicks.uuid, tickUuid));

      // Recalculate stats
      await recalculateSessionStats(sessionId, conn);

      return sessionId;
    }
  }

  // No previous tick within 4h or no previous inferred session — create a new one
  const sessionId = generateInferredSessionId(userId, climbedAt);

  await conn.insert(dbSchema.inferredSessions).values({
    id: sessionId,
    userId,
    firstTickAt: climbedAt,
    lastTickAt: climbedAt,
    totalSends: 0,
    totalFlashes: 0,
    totalAttempts: 0,
    tickCount: 0,
  }).onConflictDoNothing();

  // Assign tick to the new session
  await conn
    .update(dbSchema.boardseshTicks)
    .set({ inferredSessionId: sessionId })
    .where(eq(dbSchema.boardseshTicks.uuid, tickUuid));

  // Recalculate stats
  await recalculateSessionStats(sessionId, conn);

  // If there was a previous inferred session, mark it as ended
  if (prevTick?.inferredSessionId && prevTick.inferredSessionId !== sessionId) {
    await conn
      .update(dbSchema.inferredSessions)
      .set({ endedAt: prevTick.climbedAt })
      .where(
        and(
          eq(dbSchema.inferredSessions.id, prevTick.inferredSessionId),
          isNull(dbSchema.inferredSessions.endedAt),
        ),
      );
  }

  return sessionId;
}

/**
 * Assign an inferred session to a newly-created tick (called from saveTick).
 * Wraps in a transaction when called standalone. Pass an optional conn to
 * participate in an outer transaction instead.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function assignInferredSession(
  tickUuid: string,
  userId: string,
  climbedAt: string,
  _status: string,
  conn?: any,
): Promise<string | null> {
  if (conn) {
    return assignInferredSessionWithConn(conn, tickUuid, userId, climbedAt);
  }
  return db.transaction(async (tx) => {
    return assignInferredSessionWithConn(tx, tickUuid, userId, climbedAt);
  });
}

/**
 * Upsert an inferred session and bulk-update its ticks.
 * Shared by the batched builder and the web-side post-sync builder.
 */
async function upsertSessionAndAssignTicks(group: InferredSessionGroup): Promise<void> {
  // Upsert the inferred session (time bounds only — stats recalculated below)
  await db
    .insert(dbSchema.inferredSessions)
    .values({
      id: group.sessionId,
      userId: group.userId,
      firstTickAt: group.firstTickAt,
      lastTickAt: group.lastTickAt,
      totalSends: group.totalSends,
      totalFlashes: group.totalFlashes,
      totalAttempts: group.totalAttempts,
      tickCount: group.tickCount,
    })
    .onConflictDoUpdate({
      target: dbSchema.inferredSessions.id,
      set: {
        firstTickAt: sql`LEAST(${dbSchema.inferredSessions.firstTickAt}, EXCLUDED.first_tick_at)`,
        lastTickAt: sql`GREATEST(${dbSchema.inferredSessions.lastTickAt}, EXCLUDED.last_tick_at)`,
      },
    });

  // Bulk-update ticks with IN (...) instead of per-tick updates
  await db
    .update(dbSchema.boardseshTicks)
    .set({ inferredSessionId: group.sessionId })
    .where(inArray(dbSchema.boardseshTicks.uuid, group.tickUuids));

  // Recalculate stats from actual ticks (avoids double-counting on races)
  await recalculateSessionStats(group.sessionId);
}

/**
 * Background job: assign inferred sessions to all unassigned ticks.
 * Processes per-user in batches, checking if the first unassigned tick
 * should join the user's latest open inferred session.
 */
export async function runInferredSessionBuilderBatched(options?: {
  userId?: string;
  batchSize?: number;
}): Promise<{ usersProcessed: number; ticksAssigned: number }> {
  const batchSize = options?.batchSize ?? 5000;

  // Find distinct users with unassigned ticks
  const userFilter = options?.userId
    ? and(
        isNull(dbSchema.boardseshTicks.sessionId),
        isNull(dbSchema.boardseshTicks.inferredSessionId),
        eq(dbSchema.boardseshTicks.userId, options.userId),
      )
    : and(
        isNull(dbSchema.boardseshTicks.sessionId),
        isNull(dbSchema.boardseshTicks.inferredSessionId),
      );

  const usersWithUnassigned = await db
    .selectDistinct({ userId: dbSchema.boardseshTicks.userId })
    .from(dbSchema.boardseshTicks)
    .where(userFilter);

  if (usersWithUnassigned.length === 0) {
    return { usersProcessed: 0, ticksAssigned: 0 };
  }

  let totalAssigned = 0;

  for (const { userId } of usersWithUnassigned) {
    // Fetch all unassigned ticks for this user, ordered by climbed_at ASC
    const unassignedTicks = await db
      .select({
        id: dbSchema.boardseshTicks.id,
        uuid: dbSchema.boardseshTicks.uuid,
        userId: dbSchema.boardseshTicks.userId,
        climbedAt: dbSchema.boardseshTicks.climbedAt,
        status: dbSchema.boardseshTicks.status,
        sessionId: dbSchema.boardseshTicks.sessionId,
        inferredSessionId: dbSchema.boardseshTicks.inferredSessionId,
      })
      .from(dbSchema.boardseshTicks)
      .where(
        and(
          eq(dbSchema.boardseshTicks.userId, userId),
          isNull(dbSchema.boardseshTicks.sessionId),
          isNull(dbSchema.boardseshTicks.inferredSessionId),
        ),
      )
      .orderBy(dbSchema.boardseshTicks.climbedAt)
      .limit(batchSize);

    if (unassignedTicks.length === 0) continue;

    // Check user's latest open inferred session to see if the first tick should join it
    const [latestSession] = await db
      .select({
        id: dbSchema.inferredSessions.id,
        lastTickAt: dbSchema.inferredSessions.lastTickAt,
      })
      .from(dbSchema.inferredSessions)
      .where(
        and(
          eq(dbSchema.inferredSessions.userId, userId),
          isNull(dbSchema.inferredSessions.endedAt),
        ),
      )
      .orderBy(desc(dbSchema.inferredSessions.lastTickAt))
      .limit(1);

    // Group ticks into sessions
    const groups = groupTicksIntoSessions(unassignedTicks);

    // Check if the first group should merge into the user's latest open session
    if (latestSession && groups.length > 0) {
      const firstGroup = groups[0];
      const latestSessionTime = new Date(latestSession.lastTickAt).getTime();
      const firstTickTime = new Date(firstGroup.firstTickAt).getTime();
      const gap = firstTickTime - latestSessionTime;

      if (gap <= SESSION_GAP_MS && gap >= 0) {
        // First group should merge into the existing session — use its ID instead
        groups[0] = {
          ...firstGroup,
          sessionId: latestSession.id,
        };
      }
    }

    // Upsert sessions and assign ticks
    for (const group of groups) {
      await upsertSessionAndAssignTicks(group);
      totalAssigned += group.tickUuids.length;
    }
  }

  return { usersProcessed: usersWithUnassigned.length, ticksAssigned: totalAssigned };
}
