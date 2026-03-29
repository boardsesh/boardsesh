/**
 * Boulder grade lookup table matching board_difficulty_grades.
 * Duplicated from packages/web/app/lib/board-data.ts to avoid web-package dependency.
 */
const BOULDER_GRADES = [
  { difficulty_id: 10, font_grade: '4a' },
  { difficulty_id: 11, font_grade: '4b' },
  { difficulty_id: 12, font_grade: '4c' },
  { difficulty_id: 13, font_grade: '5a' },
  { difficulty_id: 14, font_grade: '5b' },
  { difficulty_id: 15, font_grade: '5c' },
  { difficulty_id: 16, font_grade: '6a' },
  { difficulty_id: 17, font_grade: '6a+' },
  { difficulty_id: 18, font_grade: '6b' },
  { difficulty_id: 19, font_grade: '6b+' },
  { difficulty_id: 20, font_grade: '6c' },
  { difficulty_id: 21, font_grade: '6c+' },
  { difficulty_id: 22, font_grade: '7a' },
  { difficulty_id: 23, font_grade: '7a+' },
  { difficulty_id: 24, font_grade: '7b' },
  { difficulty_id: 25, font_grade: '7b+' },
  { difficulty_id: 26, font_grade: '7c' },
  { difficulty_id: 27, font_grade: '7c+' },
  { difficulty_id: 28, font_grade: '8a' },
  { difficulty_id: 29, font_grade: '8a+' },
  { difficulty_id: 30, font_grade: '8b' },
  { difficulty_id: 31, font_grade: '8b+' },
  { difficulty_id: 32, font_grade: '8c' },
  { difficulty_id: 33, font_grade: '8c+' },
] as const;

/**
 * Convert a Font grade string to a difficulty ID.
 * Handles formats like "6a", "7B+", "6A/V3".
 */
export function fontGradeToDifficultyId(fontGrade: string): number | null {
  const fontPart = fontGrade.split('/')[0].trim();
  const normalized = fontPart.toLowerCase();
  const grade = BOULDER_GRADES.find(g => g.font_grade === normalized);
  return grade?.difficulty_id ?? null;
}
