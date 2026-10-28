// The workout part of an exported activity (#6903): "4x4 at V4" for the title
// and "Workout: Warm-up 4/4 · 4x4 V4 9/16 reps · Cool-down 2/3" for the
// description. Block names come from the shared `session` catalog through
// `@boardsesh/workout-summary`, so they read as they do in the app; the rest of
// the activity text is English, like the lines around it.

import { and, eq } from 'drizzle-orm';
import { boardSessions, boardseshTicks, sessionWorkouts } from '@boardsesh/db/schema';
import { getGradeLabel } from '@boardsesh/db/queries';
import english from '@boardsesh/i18n/locales/en-US/session.json';
import {
  deriveWorkoutStages,
  isFourByFourStage,
  parseSessionWorkoutPlan,
  parseSessionWorkoutTickMap,
  workoutHeadlineOfStages,
  workoutKindName,
  workoutMainBlocksText,
  workoutRepBar,
  type DerivedWorkout,
  type SessionWorkoutRepOutcome,
  type WorkoutStageLike,
  type WorkoutTranslate,
} from '@boardsesh/workout-summary';
import { db } from '../db/client';

export type ExportWorkout = {
  /** The main block(s), for the title: "4x4 at V4", "4x4 at V4 + Pyramid". */
  title: string;
  /** The description's first line. */
  line: string;
};

const lookup = (key: string): string | undefined => {
  let node: unknown = english;
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === 'string' ? node : undefined;
};

/** i18next's `t` over the en-US `session` catalog: `_one`/`_other` plurals and `{{name}}` values. */
export const englishSessionT: WorkoutTranslate = (key, options) => {
  const count = options?.count;
  const template =
    (typeof count === 'number' ? lookup(`${key}_${count === 1 ? 'one' : 'other'}`) : undefined) ?? lookup(key) ?? key;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    options && name in options ? String(options[name]) : match,
  );
};

/** "V4" from "6b/V4"; a label with no V grade stays as it is. */
const vGrade = (label: string): string => label.split('/').find((part) => /^V\d/.test(part)) ?? label;

/** "4/4": climbs of a block with a send or a flash, of the climbs in it. */
const climbsSent = (stage: WorkoutStageLike): string => {
  const sent = stage.climbs.filter((climb) => climb.reps.some((rep) => rep !== 'attempt')).length;
  return `${sent}/${stage.climbs.length}`;
};

/**
 * The workout part of the activity, from what the blocks came to. `gradeLabel`
 * names a difficulty id on the session's board. Null for a workout with no
 * blocks.
 */
export function buildExportWorkout(
  derived: DerivedWorkout,
  gradeLabel: (difficulty: number) => string | null,
): ExportWorkout | null {
  const stages: WorkoutStageLike[] = derived.stages.map((stage) => ({
    ...stage,
    targetGrade: stage.targetGrade === undefined ? null : gradeLabel(stage.targetGrade),
  }));
  const title = workoutMainBlocksText(workoutHeadlineOfStages(stages), englishSessionT);
  if (!title) return null;

  const blocks = stages.map((stage) => {
    const name = workoutKindName(stage.kind, englishSessionT, stage.isCoolDown);
    const label = stage.targetGrade && stage.kind !== 'warmUp' ? `${name} ${stage.targetGrade}` : name;
    const repBar = isFourByFourStage(stage) ? workoutRepBar(stage) : null;
    return repBar ? `${label} ${repBar.sent}/${repBar.total} reps` : `${label} ${climbsSent(stage)}`;
  });
  return { title, line: `${englishSessionT('mobile.session.preGeneratorLabel')}: ${blocks.join(' · ')}` };
}

/** The board type an explicit session's path starts with ("/kilter/1/10/1,2/40"). */
const boardTypeFromPath = (boardPath: string | null): string | null =>
  boardPath?.split('/').find((segment) => segment.length > 0) ?? null;

/**
 * The workout to name on `userId`'s activity for a session: their own, else
 * the one the session's creator ran (a crew climbs the creator's queue).
 * Either way it is tallied from `userId`'s own ticks, so the numbers are
 * theirs; the creator's tick map is never applied to someone else's ticks.
 * Null when neither has a workout, the exporter logged nothing, the row
 * can't be read, or (on the creator's workout) none of the exporter's ticks
 * landed on it: a crewmate who climbed their own thing keeps today's title.
 */
export async function loadExportWorkout(sessionId: string, userId: string): Promise<ExportWorkout | null> {
  const [session] = await db
    .select({ createdByUserId: boardSessions.createdByUserId, boardPath: boardSessions.boardPath })
    .from(boardSessions)
    .where(eq(boardSessions.id, sessionId))
    .limit(1);
  const rows = await db
    .select({ userId: sessionWorkouts.userId, plan: sessionWorkouts.plan, tickMap: sessionWorkouts.tickMap })
    .from(sessionWorkouts)
    .where(eq(sessionWorkouts.sessionId, sessionId));
  const row =
    rows.find((candidate) => candidate.userId === userId) ??
    rows.find((candidate) => candidate.userId === session?.createdByUserId);
  if (!row) return null;
  const plan = parseSessionWorkoutPlan(row.plan);
  const tickMap = row.userId === userId ? parseSessionWorkoutTickMap(row.tickMap) : [];
  if (!plan || !tickMap) return null;

  const ticks = await db
    .select({
      uuid: boardseshTicks.uuid,
      climbUuid: boardseshTicks.climbUuid,
      angle: boardseshTicks.angle,
      isMirror: boardseshTicks.isMirror,
      status: boardseshTicks.status,
      climbedAt: boardseshTicks.climbedAt,
      boardType: boardseshTicks.boardType,
    })
    .from(boardseshTicks)
    .where(and(eq(boardseshTicks.sessionId, sessionId), eq(boardseshTicks.userId, userId)));
  if (ticks.length === 0) return null;

  const derived = deriveWorkoutStages(
    plan,
    tickMap,
    ticks.map((tick) => ({ ...tick, status: tick.status as SessionWorkoutRepOutcome })),
  );
  if (row.userId !== userId && derived.offPlan >= ticks.length) return null;
  const boardType = ticks[0].boardType ?? boardTypeFromPath(session?.boardPath ?? null);
  return buildExportWorkout(derived, (difficulty) => {
    const label = getGradeLabel(difficulty, boardType);
    return label ? vGrade(label) : null;
  });
}
