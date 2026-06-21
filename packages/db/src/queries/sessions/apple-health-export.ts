import { and, asc, eq, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import {
  boardClimbAliases,
  boardClimbs,
  boardDifficultyGrades,
  boardSessions,
  boardseshTicks,
  sessionHealthKitWorkouts,
} from '../../schema';
import { getGradeLabel } from '../climbs/grade-lookup';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export type SessionHealthExportLapRecord = {
  tickUuid: string;
  climbUuid: string;
  climbName: string | null;
  grade: string | null;
  status: string;
  attemptCount: number;
  boardType: string;
  angle: number | null;
  climbedAt: string;
};

export type SessionHealthExportHardestClimbRecord = {
  climbUuid: string;
  climbName: string;
  grade: string;
};

export type SessionHealthExportRecord = {
  sessionId: string;
  createdByUserId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMinutes: number | null;
  boardType: string;
  totalSends: number;
  totalAttempts: number;
  hardestClimb: SessionHealthExportHardestClimbRecord | null;
  laps: SessionHealthExportLapRecord[];
  healthKitWorkoutId: string | null;
};

export type GetSessionHealthExportParams = {
  sessionId: string;
  viewerUserId: string;
};

function boardTypeFromPath(boardPath: string | null | undefined): string {
  const [boardType] = (boardPath ?? '').split('/');
  return boardType || 'unknown';
}

function attemptUnits(status: string, attemptCount: number): number {
  if (status === 'flash') return 1;
  if (status === 'send') return Math.max(attemptCount, 1);
  if (status === 'attempt') return Math.max(attemptCount, 0);
  return 0;
}

function dateToIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function gradeForDifficulty(difficulty: number | null): string | null {
  if (difficulty === null) return null;
  return getGradeLabel(difficulty) ?? `V${difficulty}`;
}

/**
 * Viewer-scoped Apple Health workout export read model.
 *
 * The backend stores only Boardsesh session/tick facts and the HealthKit
 * workout UUID used for dedupe. Native HealthKit-only fields such as samples,
 * body mass, calories, permissions, and raw workouts stay on-device.
 */
export async function getSessionHealthExport(
  db: DrizzleDb,
  { sessionId, viewerUserId }: GetSessionHealthExportParams,
): Promise<SessionHealthExportRecord | null> {
  const [sessionRows, tickRows, healthKitWorkoutRows] = await Promise.all([
    db.select().from(boardSessions).where(eq(boardSessions.id, sessionId)).limit(1),
    db
      .select({
        tickUuid: boardseshTicks.uuid,
        climbUuid: boardseshTicks.climbUuid,
        climbName: boardClimbs.name,
        grade: boardDifficultyGrades.boulderName,
        status: boardseshTicks.status,
        attemptCount: boardseshTicks.attemptCount,
        boardType: boardseshTicks.boardType,
        angle: boardseshTicks.angle,
        difficulty: boardseshTicks.difficulty,
        climbedAt: boardseshTicks.climbedAt,
      })
      .from(boardseshTicks)
      .leftJoin(
        boardClimbAliases,
        and(
          eq(boardseshTicks.climbUuid, boardClimbAliases.aliasUuid),
          eq(boardseshTicks.boardType, boardClimbAliases.boardType),
        ),
      )
      .leftJoin(
        boardClimbs,
        and(
          sql`COALESCE(${boardClimbAliases.canonicalUuid}, ${boardseshTicks.climbUuid}) = ${boardClimbs.uuid}`,
          eq(boardClimbs.boardType, boardseshTicks.boardType),
        ),
      )
      .leftJoin(
        boardDifficultyGrades,
        and(
          eq(boardDifficultyGrades.difficulty, boardseshTicks.difficulty),
          eq(boardDifficultyGrades.boardType, boardseshTicks.boardType),
        ),
      )
      .where(and(eq(boardseshTicks.sessionId, sessionId), eq(boardseshTicks.userId, viewerUserId)))
      .orderBy(asc(boardseshTicks.climbedAt)),
    db
      .select({ workoutId: sessionHealthKitWorkouts.workoutId })
      .from(sessionHealthKitWorkouts)
      .where(and(eq(sessionHealthKitWorkouts.sessionId, sessionId), eq(sessionHealthKitWorkouts.userId, viewerUserId)))
      .limit(1),
  ]);

  const session = sessionRows[0];
  if (!session) return null;

  const laps: SessionHealthExportLapRecord[] = tickRows.map((tick) => ({
    tickUuid: tick.tickUuid,
    climbUuid: tick.climbUuid,
    climbName: tick.climbName ?? null,
    grade: tick.grade ?? gradeForDifficulty(tick.difficulty),
    status: tick.status,
    attemptCount: tick.attemptCount,
    boardType: tick.boardType,
    angle: tick.angle,
    climbedAt: tick.climbedAt,
  }));

  const totalSends = tickRows.filter((tick) => tick.status === 'flash' || tick.status === 'send').length;
  const totalAttempts = tickRows.reduce((sum, tick) => sum + attemptUnits(tick.status, tick.attemptCount), 0);
  const hardestTick = tickRows
    .filter((tick) => (tick.status === 'flash' || tick.status === 'send') && tick.difficulty != null)
    .sort((firstTick, secondTick) => (secondTick.difficulty ?? -Infinity) - (firstTick.difficulty ?? -Infinity))[0];

  let durationMinutes: number | null = null;
  if (session.startedAt && session.endedAt) {
    durationMinutes = Math.round((session.endedAt.getTime() - session.startedAt.getTime()) / 60000);
  }

  return {
    sessionId,
    createdByUserId: session.createdByUserId,
    startedAt: dateToIso(session.startedAt),
    endedAt: dateToIso(session.endedAt),
    durationMinutes,
    boardType: laps[0]?.boardType ?? boardTypeFromPath(session.boardPath),
    totalSends,
    totalAttempts,
    hardestClimb: hardestTick
      ? {
          climbUuid: hardestTick.climbUuid,
          climbName: hardestTick.climbName || 'Unknown climb',
          grade: hardestTick.grade ?? gradeForDifficulty(hardestTick.difficulty) ?? `V${hardestTick.difficulty}`,
        }
      : null,
    laps,
    healthKitWorkoutId: healthKitWorkoutRows[0]?.workoutId ?? null,
  };
}
