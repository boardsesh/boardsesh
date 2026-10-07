import { getBoulderGradesForBoard } from '@boardsesh/board-config';
import { formatGrade, type GradeDisplayFormat } from '@boardsesh/play-view';

type DifficultyMappings = Record<GradeDisplayFormat, Record<number, string>>;

function buildDifficultyMappings(boardName: string | null | undefined): DifficultyMappings {
  const grades = getBoulderGradesForBoard(boardName);
  return {
    // Difficulty id → V-grade (e.g. 16 → "V3", 17 → "V3"). Multiple Font grades
    // collapse into the same V-grade, which is what we want for chart
    // aggregation and display labels.
    'v-grade': Object.fromEntries(grades.map((grade) => [grade.difficulty_id, grade.v_grade])),
    // Difficulty id → uppercase Font grade (e.g. 16 → "6A").
    font: Object.fromEntries(grades.map((grade) => [grade.difficulty_id, grade.font_grade.toUpperCase()])),
    // Difficulty id → V then French (e.g. "V5+ / 6C+").
    both: Object.fromEntries(
      grades.map((grade) => [
        grade.difficulty_id,
        formatGrade(grade.difficulty_name, 'both', boardName) ?? grade.difficulty_name,
      ]),
    ),
  };
}

const sharedDifficultyMappings = buildDifficultyMappings(null);
// MoonBoard converts Font to V its own way (6A is V2), so its ticks get their
// own labels. Every other board reads the shared mappings.
const moonBoardDifficultyMappings = buildDifficultyMappings('moonboard');

// Shared-scale id → V-grade, for callers that bucket without a board.
export const difficultyMapping: Record<number, string> = sharedDifficultyMappings['v-grade'];

/**
 * Difficulty-id → grade-label mapping for the requested display format, on
 * `boardName`'s scale (the shared one when the board is missing or unknown).
 */
export const getDifficultyMapping = (format: GradeDisplayFormat, boardName?: string | null): Record<number, string> =>
  (boardName === 'moonboard' ? moonBoardDifficultyMappings : sharedDifficultyMappings)[format];

// Reverse mapping from grade string → numeric difficulty, for sorting.
const buildGradeOrder = (mappings: readonly Record<number, string>[]): Map<string, number> => {
  const order = new Map<string, number>();
  for (const [numStr, grade] of mappings.flatMap((mapping) => Object.entries(mapping))) {
    const num = parseInt(numStr, 10);
    // For grades that map to the same string (e.g. V0 from 10, 11, 12), keep
    // the lowest number.
    if (!order.has(grade) || num < (order.get(grade) ?? Infinity)) {
      order.set(grade, num);
    }
  }
  return order;
};

// Ordered over every board's labels, so a chart mixing a MoonBoard "V2" (id 16)
// with a Kilter "V2" (id 15) sorts each label by its lowest id.
const orderFor = (format: GradeDisplayFormat) =>
  buildGradeOrder([sharedDifficultyMappings[format], moonBoardDifficultyMappings[format]]);
const vGradeOrder = orderFor('v-grade');
const fontGradeOrderMap = orderFor('font');
const combinedGradeOrderMap = orderFor('both');

/** Sort grade strings by their numeric difficulty value. */
export const sortGrades = (grades: string[], format: GradeDisplayFormat): string[] => {
  let gradeOrder = vGradeOrder;
  if (format === 'font') {
    gradeOrder = fontGradeOrderMap;
  } else if (format === 'both') {
    gradeOrder = combinedGradeOrderMap;
  }
  return [...grades].sort((a, b) => {
    const orderA = gradeOrder.get(a) ?? 999;
    const orderB = gradeOrder.get(b) ?? 999;
    return orderA - orderB;
  });
};
