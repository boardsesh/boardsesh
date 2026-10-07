import { formatGrade, type GradeDisplayFormat } from '@boardsesh/play-view';

/**
 * One label per grade chip, never the same label on two chips (#5960).
 *
 * Under the V format several grades on the shared scale read the same: 4a, 4b
 * and 4c are all V0, so a rail drew "V0 V0 V0" and a climber could not tell
 * which chip they were picking. Every label that would repeat falls back to the
 * 'both' format ("V0 / 4A"), which names the grade the chip stands for. A label
 * that is already unique stays as the climber's own format drew it.
 *
 * Keyed by difficulty id. Pure, so both rails memoize it once per grade list.
 */
export function distinctGradeChipLabels(
  grades: ReadonlyArray<{ difficultyId: number; name: string }>,
  gradeFormat: GradeDisplayFormat,
  boardName?: string | null,
): Map<number, string> {
  const preferred = grades.map((grade) => ({
    grade,
    label: formatGrade(grade.name, gradeFormat, boardName) ?? grade.name,
  }));
  const counts = new Map<string, number>();
  for (const { label } of preferred) counts.set(label, (counts.get(label) ?? 0) + 1);

  const labels = new Map<number, string>();
  for (const { grade, label } of preferred) {
    const repeats = (counts.get(label) ?? 0) > 1;
    labels.set(grade.difficultyId, repeats ? (formatGrade(grade.name, 'both', boardName) ?? grade.name) : label);
  }
  return labels;
}
