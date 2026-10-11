import { formatGrade, type GradeDisplayFormat } from '@boardsesh/play-view';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { findGradeStop, type GradeStop } from '@boardsesh/climb-filters';

/**
 * What a stop needs to name a grade bound: its own label, and for each grade it
 * covers the label that names that grade alone. A one-grade stop has one entry,
 * labelled as the stop. In a group every grade carries both formats
 * ("V0 / 4A"), since the stop's label is the same for all of them.
 */
export type NamedGradeStop = GradeStop & {
  label: string;
  gradeLabels: ReadonlyArray<{ difficultyId: number; label: string }>;
};

/** One chip of the grade range rail: the grades it covers and how it is drawn. */
export type GradeRailStop = NamedGradeStop & { gradeColor: string };

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
  const groups: Array<{ label: string; grades: Array<{ difficultyId: number; name: string }> }> = [];
  for (const grade of ascendingGrades) {
    const label = formatGrade(grade.name, gradeFormat, boardName) ?? grade.name;
    const previousGroup = groups.at(-1);
    if (previousGroup?.label === label) previousGroup.grades.push(grade);
    else groups.push({ label, grades: [grade] });
  }
  return groups.map(({ label, grades: groupGrades }) => {
    const [easiestGrade] = groupGrades;
    return {
      minGradeId: easiestGrade.difficultyId,
      maxGradeId: groupGrades[groupGrades.length - 1].difficultyId,
      label,
      gradeLabels: groupGrades.map((grade) => ({
        difficultyId: grade.difficultyId,
        label: groupGrades.length === 1 ? label : (formatGrade(grade.name, 'both', boardName) ?? grade.name),
      })),
      // A group shares one V grade, and the colour ramp follows the V grade.
      gradeColor: getGradeColor(easiestGrade.name) ?? DEFAULT_GRADE_COLOR,
    };
  });
}

/**
 * How to name the two ends of a grade bound, the way the rail's chips do.
 *
 * An end takes its stop's plain label only when the bound covers that stop out
 * to its edge: "V0" for 4a to 4c, "V0–V2" for 4a to 5c. A bound can also sit
 * inside a group without covering it (saved under Font grades, or before chips
 * were grouped): 4a alone is NOT "V0", the query still sends 4a only. That end
 * is named precisely instead, "V0 / 4A", so the label never claims more than
 * the filter does.
 *
 * Each end is undefined when it is unset or has no chip on this row.
 */
export function gradeBoundLabels(
  stops: readonly NamedGradeStop[],
  bound: { minGradeId?: number | null; maxGradeId?: number | null },
): { min: string | undefined; max: string | undefined } {
  const { minGradeId, maxGradeId } = bound;
  const lowerStop = minGradeId == null ? undefined : findGradeStop(stops, minGradeId);
  const upperStop = maxGradeId == null ? undefined : findGradeStop(stops, maxGradeId);
  const preciseLabel = (stop: NamedGradeStop, gradeId: number | null | undefined) =>
    stop.gradeLabels.find((grade) => grade.difficultyId === gradeId)?.label ?? stop.label;

  // Both ends in one stop: its plain label only when the bound is all of it.
  if (lowerStop && lowerStop === upperStop) {
    const coversStop = minGradeId === lowerStop.minGradeId && maxGradeId === lowerStop.maxGradeId;
    return coversStop
      ? { min: lowerStop.label, max: lowerStop.label }
      : { min: preciseLabel(lowerStop, minGradeId), max: preciseLabel(lowerStop, maxGradeId) };
  }
  // Otherwise each end on its own: a lower end covers its stop when it starts
  // on the stop's lower edge, an upper end when it stops on the upper edge.
  return {
    min: lowerStop
      ? minGradeId === lowerStop.minGradeId
        ? lowerStop.label
        : preciseLabel(lowerStop, minGradeId)
      : undefined,
    max: upperStop
      ? maxGradeId === upperStop.maxGradeId
        ? upperStop.label
        : preciseLabel(upperStop, maxGradeId)
      : undefined,
  };
}
