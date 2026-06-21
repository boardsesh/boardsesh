import { db } from '../../../db/client';
import { sessions } from '../../../db/schema';
import * as dbSchema from '@boardsesh/db/schema';
import { eq, and, inArray, sql, desc, isNotNull } from 'drizzle-orm';
import type { SessionHealthExport, SessionSummary } from '@boardsesh/shared-schema';
import { rowsFromResult } from '@boardsesh/db/client';
import { getSessionHealthExport } from '@boardsesh/db/queries';
import { logger } from '../../../utils/logger';

/**
 * Generate a summary for a session including grade distribution,
 * hardest climb, participant stats, and duration.
 */
export async function generateSessionSummary(sessionId: string): Promise<SessionSummary | null> {
  // Fetch session metadata using Drizzle ORM
  const sessionRows = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);

  if (sessionRows.length === 0) {
    return null;
  }

  const session = sessionRows[0];

  // Run aggregation queries in parallel
  // Note: These queries use GROUP BY with aggregation, COUNT FILTER, and COALESCE
  // which cannot be expressed with Drizzle's query builder per CLAUDE.md guidelines.
  const [gradeDistRows, hardestRows, participantRows] = await Promise.all([
    // Grade distribution: per-grade {flash, send, attempt} breakdown, the shape
    // the session-detail chart consumes (see buildSessionGradeBars). Grouped over
    // flash/send ticks only — attempt-status ticks carry a null difficulty
    // (ascents.ts), so they can't be attributed to a grade here. `attempt` is the
    // implicit failed attempts on sends (attemptCount - 1), matching the
    // send-contribution in session-feed-utils' buildGradeDistributionFromTicks.
    // Every emitted row therefore has flash + send >= 1 (no "×0" grade rows).
    db
      .select({
        grade: dbSchema.boardDifficultyGrades.boulderName,
        difficulty: dbSchema.boardDifficultyGrades.difficulty,
        flash: sql<number>`COUNT(*) FILTER (WHERE ${dbSchema.boardseshTicks.status} = 'flash')::int`,
        send: sql<number>`COUNT(*) FILTER (WHERE ${dbSchema.boardseshTicks.status} = 'send')::int`,
        attempt: sql<number>`COALESCE(SUM(${dbSchema.boardseshTicks.attemptCount} - 1) FILTER (WHERE ${dbSchema.boardseshTicks.status} = 'send'), 0)::int`,
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
        // Frames + layoutId let the client render a board thumbnail of the
        // hardest send (sizeId/setIds are resolved client-side from layoutId).
        frames: dbSchema.boardClimbs.frames,
        layoutId: dbSchema.boardClimbs.layoutId,
        isMirror: dbSchema.boardseshTicks.isMirror,
      })
      .from(dbSchema.boardseshTicks)
      .leftJoin(
        dbSchema.boardDifficultyGrades,
        and(
          eq(dbSchema.boardDifficultyGrades.difficulty, dbSchema.boardseshTicks.difficulty),
          eq(dbSchema.boardDifficultyGrades.boardType, dbSchema.boardseshTicks.boardType),
        ),
      )
      // Resolve dedup-merged climbs to their canonical UUID before the
      // board_climbs join. A tick may point at an alias UUID that was
      // deduplicated away (no board_climbs row); the alias table maps it to the
      // canonical. Ticks already on a canonical have no alias row, so COALESCE
      // falls back to the tick's own climb_uuid. The PK (board_type, alias_uuid)
      // keeps the hop to ≤1 row. Otherwise the hardest climb's name is dropped.
      .leftJoin(
        dbSchema.boardClimbAliases,
        and(
          eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbAliases.aliasUuid),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbAliases.boardType),
        ),
      )
      .leftJoin(
        dbSchema.boardClimbs,
        and(
          sql`COALESCE(${dbSchema.boardClimbAliases.canonicalUuid}, ${dbSchema.boardseshTicks.climbUuid}) = ${dbSchema.boardClimbs.uuid}`,
          eq(dbSchema.boardClimbs.boardType, dbSchema.boardseshTicks.boardType),
        ),
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
             COUNT(*) FILTER (WHERE t.status = 'flash')::int AS flashes,
             COUNT(*)::int AS attempts
      FROM boardsesh_ticks t
      LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN user_profiles up ON up.user_id = t.user_id
      WHERE t.session_id = ${sessionId}
      GROUP BY t.user_id, up.display_name, u.name, up.avatar_url
      ORDER BY sends DESC
    `),
  ]);

  const participantCastRows = rowsFromResult<{
    userId: string;
    displayName: string | null;
    avatarUrl: string | null;
    sends: number;
    flashes: number;
    attempts: number;
  }>(participantRows);

  // Build grade distribution (filter out null grades using type guard). Matches
  // the {grade, flash, send, attempt} shape used across session views.
  const gradeDistribution = gradeDistRows
    .filter((r): r is typeof r & { grade: string } => r.grade != null)
    // `count` (flash + send) is the deprecated back-compat field; new clients read flash/send.
    .map((r) => ({ grade: r.grade, count: r.flash + r.send, flash: r.flash, send: r.send, attempt: r.attempt }));

  // Build hardest climb (climb name already JOINed — no separate query needed).
  // frames/layoutId/boardType/isMirror let the client draw a board thumbnail.
  let hardestClimb = null;
  if (hardestRows.length > 0) {
    const h = hardestRows[0];
    hardestClimb = {
      climbUuid: h.climbUuid,
      climbName: h.climbName || 'Unknown climb',
      grade: h.grade || `V${h.difficulty}`,
      frames: h.frames ?? null,
      layoutId: h.layoutId ?? null,
      boardType: h.boardType,
      isMirror: h.isMirror ?? false,
    };
  }

  // Build participants
  const participants = participantCastRows.map((r) => ({
    userId: r.userId,
    displayName: r.displayName,
    avatarUrl: r.avatarUrl,
    sends: r.sends,
    flashes: r.flashes,
    attempts: r.attempts,
  }));

  // Calculate totals
  const totalSends = participants.reduce((sum, p) => sum + p.sends, 0);
  const totalFlashes = participants.reduce((sum, p) => sum + p.flashes, 0);
  const totalAttempts = participants.reduce((sum, p) => sum + p.attempts, 0);

  // Calculate duration. A null startedAt is unusual — sessions get one on
  // creation — but it's persisted as nullable so we have to handle it. Log
  // when we hit this so the auto-finish flow (the first user-visible path
  // for sessions without a startedAt) doesn't display a blank duration with
  // no breadcrumb in the logs.
  let durationMinutes: number | null = null;
  if (session.startedAt && session.endedAt) {
    durationMinutes = Math.round((session.endedAt.getTime() - session.startedAt.getTime()) / 60000);
  } else if (session.endedAt && !session.startedAt) {
    logger.warn(`[sessionSummary] Session ${sessionId} has endedAt but no startedAt; durationMinutes will be null.`);
  }

  return {
    sessionId,
    totalSends,
    totalFlashes,
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

/**
 * Generate a viewer-specific Apple Health export payload. Unlike
 * generateSessionSummary, this intentionally filters to the authenticated
 * viewer so a personal Health workout never includes another climber's stats.
 */
export async function generateSessionHealthExport(
  sessionId: string,
  viewerUserId: string,
): Promise<SessionHealthExport | null> {
  const exportRecord = await getSessionHealthExport(db, { sessionId, viewerUserId });
  if (!exportRecord) return null;
  if (exportRecord.createdByUserId !== viewerUserId && exportRecord.laps.length === 0) return null;

  return {
    sessionId: exportRecord.sessionId,
    startedAt: exportRecord.startedAt,
    endedAt: exportRecord.endedAt,
    durationMinutes: exportRecord.durationMinutes,
    boardType: exportRecord.boardType,
    totalSends: exportRecord.totalSends,
    totalAttempts: exportRecord.totalAttempts,
    hardestClimb: exportRecord.hardestClimb,
    laps: exportRecord.laps,
    healthKitWorkoutId: exportRecord.healthKitWorkoutId,
  };
}
