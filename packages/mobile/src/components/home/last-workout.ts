import { workoutHeadlineOfStages, type WorkoutHeadlineLike } from '@boardsesh/workout-summary';
import type { EndedWorkoutRecord } from '../../lib/ended-workout-store';

export type LastWorkoutSummary = {
  /** The blocks, for `workoutMainBlocksText`: "4x4 at V4 + Pyramid". */
  headline: WorkoutHeadlineLike;
  /** Flashes and sends logged on the workout's climbs. */
  sends: number;
  endedAtMs: number;
};

type FormatDifficultyId = (difficultyId: number | null | undefined, boardName?: string | null) => string | null;

/**
 * What Home's Session card says about the last workout this phone ran (#7689),
 * from its recap. Grades are the climber's own display labels; the board comes
 * from the climbs the run captured, so a MoonBoard workout reads on its scale.
 */
export function lastWorkoutSummary(record: EndedWorkoutRecord, formatGrade: FormatDifficultyId): LastWorkoutSummary {
  const boardType = Object.values(record.climbs ?? {}).find((climb) => climb.boardType)?.boardType ?? null;
  const stages = record.run.stages.map((stage) => ({
    kind: stage.kind,
    targetGrade: stage.targetGrade === undefined ? null : formatGrade(stage.targetGrade, boardType),
  }));
  const sends = (record.log ?? []).filter((entry) => entry.status === 'flash' || entry.status === 'send').length;
  return { headline: workoutHeadlineOfStages(stages), sends, endedAtMs: record.endedAtMs };
}

/** Whole local calendar days between two instants: 0 today, 1 yesterday. */
export function localDaysAgo(thenMs: number, nowMs: number): number {
  const then = new Date(thenMs);
  const now = new Date(nowMs);
  const thenDay = Date.UTC(then.getFullYear(), then.getMonth(), then.getDate());
  const nowDay = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((nowDay - thenDay) / 86_400_000);
}
