import { formatGrade, type GradeDisplayFormat } from '@boardsesh/play-view';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { findGradeStop, type GradeStop } from '@boardsesh/climb-filters';

/** One chip of the grade range rail: the grades it covers and how it is drawn. */
export type GradeRailStop = GradeStop & { label: string; gradeColor: string };

/**
 * The range rail's chips, easiest first.
 *
 * Consecutive grades that read the same in the climber's format are ONE stop.
 * Under V grades 4a, 4b and 4c are all "V0": three chips saying "V0" told a
 * climber nothing about which one they were picking, so the rail draws one
 * "V0" chip that covers all three. Under Font, or with both formats shown,
 * every label differs and every grade stays its own stop.
 *
 * The single-select rail does not use this. Logging a tick needs the exact
 * grade, so it keeps one chip per grade (`distinctGradeChipLabels`).
 */
export function buildGradeRailStops(
  grades: ReadonlyArray<{ difficultyId: number; name: string }>,
  gradeFormat: GradeDisplayFormat,
  boardName?: string | null,
): GradeRailStop[] {
  const ascendingGrades = [...grades].sort(
    (firstGrade, secondGrade) => firstGrade.difficultyId - secondGrade.difficultyId,
  );
  const stops: GradeRailStop[] = [];
  for (const grade of ascendingGrades) {
    const label = formatGrade(grade.name, gradeFormat, boardName) ?? grade.name;
    const previousStop = stops.at(-1);
    if (previousStop?.label === label) {
      previousStop.maxGradeId = grade.difficultyId;
      continue;
    }
    stops.push({
      minGradeId: grade.difficultyId,
      maxGradeId: grade.difficultyId,
      label,
      // A group shares one V grade, and the colour ramp follows the V grade.
      gradeColor: getGradeColor(grade.name) ?? DEFAULT_GRADE_COLOR,
    });
  }
  return stops;
}

/** How the rail names a grade: the label of the stop it falls in, if it has one. */
export function gradeRailStopLabel(
  stops: ReadonlyArray<GradeStop & { label: string }>,
  difficultyId: number,
): string | undefined {
  return findGradeStop(stops, difficultyId)?.label;
}
