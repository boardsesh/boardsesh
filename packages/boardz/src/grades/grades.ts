import type { BoardName } from '@boardsesh/shared-schema';
import { fontGradeToDifficultyId, getGradesForBoard } from '@boardsesh/board-config';
import { formatGrade, formatGradeByDifficultyId, type GradeDisplayFormat } from '@boardsesh/play-view';

export type { GradeDisplayFormat };

export const GRADE_FORMATS: { value: GradeDisplayFormat; label: string }[] = [
  { value: 'font', label: 'Font (6B+)' },
  { value: 'v-grade', label: 'V-grade (V4)' },
  { value: 'both', label: 'Both' },
];

/** The difficulty id behind a catalogue grade string like "6b+/V4" or "6B+". */
export function difficultyIdFromGrade(difficulty: string | null | undefined): number | null {
  if (!difficulty) return null;
  return fontGradeToDifficultyId(difficulty);
}

/** A climb's grade string ("6b+/V4") in the climber's format. */
export function gradeLabel(difficulty: string | null | undefined, format: GradeDisplayFormat): string | null {
  return formatGrade(difficulty, format);
}

/** A difficulty id's grade in the climber's format. */
export function gradeLabelFromId(difficultyId: number | null | undefined, format: GradeDisplayFormat): string | null {
  return formatGradeByDifficultyId(difficultyId == null ? null : Math.round(difficultyId), format);
}

/**
 * Graphite's grade bands: 1 ≤6A+ · 2 6B · 3 6C · 4 7A · 5 7B · 6 7C · 7 8A+.
 * V grades fall in the same bands. 0 means the grade couldn't be read.
 * Each band has a colour per theme (`Theme.grades`), used only on grades.
 */
export type GradeBand = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** The band for a difficulty id (16 = 6a, 18 = 6b, 20 = 6c, 22 = 7a, 24 = 7b, 26 = 7c, 28 = 8a). */
export function gradeBandFromId(difficultyId: number | null | undefined): GradeBand {
  if (difficultyId == null) return 0;
  const id = Math.round(difficultyId);
  if (id <= 17) return 1;
  if (id <= 19) return 2;
  if (id <= 21) return 3;
  if (id <= 23) return 4;
  if (id <= 25) return 5;
  if (id <= 27) return 6;
  return 7;
}

function bandFromVGrade(vGrade: number): GradeBand {
  if (vGrade <= 3) return 1;
  if (vGrade === 4) return 2;
  if (vGrade === 5) return 3;
  if (vGrade <= 7) return 4;
  if (vGrade === 8) return 5;
  if (vGrade <= 10) return 6;
  return 7;
}

/** The band for a grade string: "6b+/V4", "6B+", "V4" or "V6 / 7A". */
export function gradeBand(difficulty: string | null | undefined): GradeBand {
  if (!difficulty) return 0;
  const difficultyId = difficultyIdFromGrade(difficulty);
  if (difficultyId !== null) return gradeBandFromId(difficultyId);
  const vGrade = /V(\d+)/i.exec(difficulty);
  return vGrade ? bandFromVGrade(Number(vGrade[1])) : 0;
}

/** A band's colour in the given theme's grade ramp, or undefined for an unread grade. */
export function bandColor(grades: readonly string[], band: GradeBand): string | undefined {
  return band === 0 ? undefined : grades[band - 1];
}

export type GradeOption = { difficultyId: number; label: string };

/** Every grade a board's climbs can have, easiest first. MoonBoard starts at 5+. */
export function gradeOptions(boardName: BoardName, format: GradeDisplayFormat): GradeOption[] {
  return getGradesForBoard(boardName).map((grade) => ({
    difficultyId: grade.difficulty_id,
    label: formatGrade(grade.difficulty_name, format) ?? grade.difficulty_name,
  }));
}
