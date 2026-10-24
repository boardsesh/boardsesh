import { formatGradeByDifficultyId, type GradeDisplayFormat } from '@boardsesh/play-view';

export type BorrowedGradeLabels = {
  /** The grade the climb came from. */
  grade: string;
  /** The grade the plan asked for. */
  plannedGrade: string;
};

/**
 * The two grades a borrowed row's caption names ("V4 for V5"): the grade the
 * climb came from, then the one it fills in for, in the climber's format.
 *
 * Under the V format two grades can read the same: 4a, 4b and 4c are all V0 on
 * Kilter, so a 4b climb borrowed for 4a said "V0 for V0". When the two labels
 * match, both fall back to the 'both' format ("V0 / 4B for V0 / 4A"), the same
 * way the grade rail's chips tell those grades apart (`distinctGradeChipLabels`).
 *
 * Null when either grade is off the board's scale, or when the two still read
 * the same, so the row draws no caption rather than one that says nothing.
 */
export function borrowedGradeLabels(
  borrowedGrade: number | null,
  plannedGrade: number | null,
  gradeFormat: GradeDisplayFormat,
  boardName?: string | null,
): BorrowedGradeLabels | null {
  if (borrowedGrade === null || plannedGrade === null) return null;
  const labelsIn = (format: GradeDisplayFormat): BorrowedGradeLabels | null => {
    const borrowedLabel = formatGradeByDifficultyId(borrowedGrade, format, boardName);
    const plannedLabel = formatGradeByDifficultyId(plannedGrade, format, boardName);
    return borrowedLabel && plannedLabel ? { grade: borrowedLabel, plannedGrade: plannedLabel } : null;
  };
  const preferred = labelsIn(gradeFormat);
  if (!preferred || preferred.grade !== preferred.plannedGrade) return preferred;
  const named = labelsIn('both');
  return named && named.grade !== named.plannedGrade ? named : null;
}
