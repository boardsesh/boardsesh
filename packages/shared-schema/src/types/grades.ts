// Grade mapping data shared between web and backend packages

export type GradeFormat = 'FONT' | 'V_GRADE';

export interface BoulderGradeEntry {
  difficultyId: number;
  fontGrade: string;
  vGrade: string;
}

/**
 * Mapping from numeric difficulty IDs to font grades and V-grades.
 * Source of truth for grade conversions across all packages.
 */
export const BOULDER_GRADE_MAP: readonly BoulderGradeEntry[] = [
  { difficultyId: 10, fontGrade: '4a', vGrade: 'V0' },
  { difficultyId: 11, fontGrade: '4b', vGrade: 'V0' },
  { difficultyId: 12, fontGrade: '4c', vGrade: 'V0' },
  { difficultyId: 13, fontGrade: '5a', vGrade: 'V1' },
  { difficultyId: 14, fontGrade: '5b', vGrade: 'V1' },
  { difficultyId: 15, fontGrade: '5c', vGrade: 'V2' },
  { difficultyId: 16, fontGrade: '6a', vGrade: 'V3' },
  { difficultyId: 17, fontGrade: '6a+', vGrade: 'V3' },
  { difficultyId: 18, fontGrade: '6b', vGrade: 'V4' },
  { difficultyId: 19, fontGrade: '6b+', vGrade: 'V4' },
  { difficultyId: 20, fontGrade: '6c', vGrade: 'V5' },
  { difficultyId: 21, fontGrade: '6c+', vGrade: 'V5' },
  { difficultyId: 22, fontGrade: '7a', vGrade: 'V6' },
  { difficultyId: 23, fontGrade: '7a+', vGrade: 'V7' },
  { difficultyId: 24, fontGrade: '7b', vGrade: 'V8' },
  { difficultyId: 25, fontGrade: '7b+', vGrade: 'V8' },
  { difficultyId: 26, fontGrade: '7c', vGrade: 'V9' },
  { difficultyId: 27, fontGrade: '7c+', vGrade: 'V10' },
  { difficultyId: 28, fontGrade: '8a', vGrade: 'V11' },
  { difficultyId: 29, fontGrade: '8a+', vGrade: 'V12' },
  { difficultyId: 30, fontGrade: '8b', vGrade: 'V13' },
  { difficultyId: 31, fontGrade: '8b+', vGrade: 'V14' },
  { difficultyId: 32, fontGrade: '8c', vGrade: 'V15' },
  { difficultyId: 33, fontGrade: '8c+', vGrade: 'V16' },
] as const;

// Pre-built lookup by difficulty ID for O(1) access
const byDifficultyId = new Map<number, BoulderGradeEntry>(
  BOULDER_GRADE_MAP.map((entry) => [entry.difficultyId, entry]),
);

/**
 * Convert a numeric difficulty ID to a grade string in the given format.
 * Returns null if the difficulty ID is not recognized.
 */
export function difficultyToGrade(difficultyId: number, format: GradeFormat): string | null {
  const entry = byDifficultyId.get(Math.round(difficultyId));
  if (!entry) return null;
  return format === 'FONT' ? entry.fontGrade : entry.vGrade;
}
