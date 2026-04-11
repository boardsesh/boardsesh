import { sessions } from '../../../db/schema';

import type { RequestDbInstance } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { eq, and, inArray, sql, count, desc, isNotNull } from 'drizzle-orm';
import type { SessionSummary } from '@boardsesh/shared-schema';

/**
 * Generate a summary for a session including grade distribution,
 * hardest climb, participant stats, and duration.
 *
 * Takes a db instance from the caller so we reuse the request-scoped
 * neon-http client instead of allocating a new one per call.
 */
export async function generateSessionSummary(
  db: RequestDbInstance,
  sessionId: string,
): Promise<SessionSummary | null> {
  // Fetch session metadata using Drizzle ORM
  const sessionRows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);

  if (sessionRows.length === 0) {
    return null;
  }

  const session = sessionRows[0];

  // Run aggregation queries in parallel
  // Note: These queries use GROUP BY with aggregation, COUNT FILTER, and COALESCE
  // which cannot be expressed with Drizzle's query builder per CLAUDE.md guidelines.
  const [gradeDistRows, hardestRows, participantRows] = await Promise.all([
    // Grade distribution: count sends grouped by grade
    db
      .select({
        grade: dbSchema.boardDifficultyGrades.boulderName,
        difficulty: dbSchema.boardDifficultyGrades.difficulty,
        count: count(),
      })
      .from(dbSchema.boardseshTicks)
      .leftJoin(
        dbSchema.boardDifficultyGrades,
        and(
          eq(dbSchema.boardDifficultyGrades.difficulty, dbSchema.boardseshTicks.difficulty),
          eq(dbSchema.boardDifficultyGrades.boardType, dbSchema.boardseshTicks.boardType),
        ),
      )
      .where(
        and(
          eq(dbSchema.boardseshTicks.sessionId, sessionId),
          inArray(dbSchema.boardseshTicks.status, ['flash', 'send']),
          isNotNull(dbSchema.boardseshTicks.difficulty),
        ),
      )
      .groupBy(dbSchema.boardDifficultyGrades.boulderName, dbSchema.boardDifficultyGrades.difficulty)
      .orderBy(desc(dbSchema.boardDifficultyGrades.difficulty)),

    // Hardest climb: highest difficulty send with climb name (JOINed to avoid N+1)
    db
      .select({
        climbUuid: dbSchema.boardseshTicks.climbUuid,
        boardType: dbSchema.boardseshTicks.boardType,
        difficulty: dbSchema.boardseshTicks.difficulty,
        grade: dbSchema.boardDifficultyGrades.boulderName,
        climbName: dbSchema.boardClimbs.name,
      })
      .from(dbSchema.boardseshTicks)
      .leftJoin(
        dbSchema.boardDifficultyGrades,
        and(
          eq(dbSchema.boardDifficultyGrades.difficulty, dbSchema.boardseshTicks.difficulty),
          eq(dbSchema.boardDifficultyGrades.boardType, dbSchema.boardseshTicks.boardType),
        ),
      )
      .leftJoin(
        dbSchema.boardClimbs,
        eq(dbSchema.boardClimbs.uuid, dbSchema.boardseshTicks.climbUuid),
      )
      .where(
        and(
          eq(dbSchema.boardseshTicks.sessionId, sessionId),
          inArray(dbSchema.boardseshTicks.status, ['flash', 'send']),
          isNotNull(dbSchema.boardseshTicks.difficulty),
        ),
      )
      .orderBy(desc(dbSchema.boardseshTicks.difficulty))
      .limit(1),

    // Participant stats: sends and attempts per user
    // Uses COUNT FILTER which requires raw SQL (not available in Drizzle query builder)
    db.execute(sql`
      SELECT t.user_id AS "userId",
             COALESCE(up.display_name, u.name) AS "displayName",
             up.avatar_url AS "avatarUrl",
             COUNT(*) FILTER (WHERE t.status IN ('flash', 'send'))::int AS sends,
             COUNT(*)::int AS attempts
      FROM boardsesh_ticks t
      LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN user_profiles up ON up.user_id = t.user_id
      WHERE t.session_id = ${sessionId}
      GROUP BY t.user_id, up.display_name, u.name, up.avatar_url
      ORDER BY sends DESC
    `),
  ]);

  const participantCastRows = (participantRows as unknown as Array<{
    userId: string;
    displayName: string | null;
    avatarUrl: string | null;
    sends: number;
    attempts: number;
  }>);

  // Build grade distribution (filter out null grades using type guard)
  const gradeDistribution = gradeDistRows
    .filter((r): r is typeof r & { grade: string } => r.grade != null)
    .map((r) => ({ grade: r.grade, count: r.count }));

  // Build hardest climb (climb name already JOINed — no separate query needed)
  let hardestClimb = null;
  if (hardestRows.length > 0) {
    const h = hardestRows[0];
    hardestClimb = {
      climbUuid: h.climbUuid,
      climbName: h.climbName || 'Unknown climb',
      grade: h.grade || `V${h.difficulty}`,
    };
  }

  // Build participants
  const participants = participantCastRows.map((r) => ({
    userId: r.userId,
    displayName: r.displayName,
    avatarUrl: r.avatarUrl,
    sends: r.sends,
    attempts: r.attempts,
  }));

  // Calculate totals
  const totalSends = participants.reduce((sum, p) => sum + p.sends, 0);
  const totalAttempts = participants.reduce((sum, p) => sum + p.attempts, 0);

  // Calculate duration
  let durationMinutes: number | null = null;
  if (session.startedAt && session.endedAt) {
    durationMinutes = Math.round(
      (session.endedAt.getTime() - session.startedAt.getTime()) / 60000
    );
  }

  return {
    sessionId,
    totalSends,
    totalAttempts,
    gradeDistribution,
    hardestClimb,
    participants,
    startedAt: session.startedAt?.toISOString() || null,
    endedAt: session.endedAt?.toISOString() || null,
    durationMinutes,
    goal: session.goal || null,
  };
}
