/**
 * Boulder-grade taxonomy: the static V ↔ Font mapping table.
 *
 * Owned by board-constants (zero deps) so display utilities can import it
 * without dragging the full @boardsesh/board-config module graph (board
 * image dimensions, set IDs, moonboard config, etc.) into the bundle.
 *
 * @boardsesh/board-config re-exports `BOULDER_GRADES` from here for
 * back-compat with existing call sites.
 */

export const BOULDER_GRADES = [
  { difficulty_id: 10, font_grade: '4a', v_grade: 'V0', difficulty_name: '4a/V0' },
  { difficulty_id: 11, font_grade: '4b', v_grade: 'V0', difficulty_name: '4b/V0' },
  { difficulty_id: 12, font_grade: '4c', v_grade: 'V0', difficulty_name: '4c/V0' },
  { difficulty_id: 13, font_grade: '5a', v_grade: 'V1', difficulty_name: '5a/V1' },
  { difficulty_id: 14, font_grade: '5b', v_grade: 'V1', difficulty_name: '5b/V1' },
  { difficulty_id: 15, font_grade: '5c', v_grade: 'V2', difficulty_name: '5c/V2' },
  { difficulty_id: 16, font_grade: '6a', v_grade: 'V3', difficulty_name: '6a/V3' },
  { difficulty_id: 17, font_grade: '6a+', v_grade: 'V3', difficulty_name: '6a+/V3' },
  { difficulty_id: 18, font_grade: '6b', v_grade: 'V4', difficulty_name: '6b/V4' },
  { difficulty_id: 19, font_grade: '6b+', v_grade: 'V4', difficulty_name: '6b+/V4' },
  { difficulty_id: 20, font_grade: '6c', v_grade: 'V5', difficulty_name: '6c/V5' },
  { difficulty_id: 21, font_grade: '6c+', v_grade: 'V5', difficulty_name: '6c+/V5' },
  { difficulty_id: 22, font_grade: '7a', v_grade: 'V6', difficulty_name: '7a/V6' },
  { difficulty_id: 23, font_grade: '7a+', v_grade: 'V7', difficulty_name: '7a+/V7' },
  { difficulty_id: 24, font_grade: '7b', v_grade: 'V8', difficulty_name: '7b/V8' },
  { difficulty_id: 25, font_grade: '7b+', v_grade: 'V8', difficulty_name: '7b+/V8' },
  { difficulty_id: 26, font_grade: '7c', v_grade: 'V9', difficulty_name: '7c/V9' },
  { difficulty_id: 27, font_grade: '7c+', v_grade: 'V10', difficulty_name: '7c+/V10' },
  { difficulty_id: 28, font_grade: '8a', v_grade: 'V11', difficulty_name: '8a/V11' },
  { difficulty_id: 29, font_grade: '8a+', v_grade: 'V12', difficulty_name: '8a+/V12' },
  { difficulty_id: 30, font_grade: '8b', v_grade: 'V13', difficulty_name: '8b/V13' },
  { difficulty_id: 31, font_grade: '8b+', v_grade: 'V14', difficulty_name: '8b+/V14' },
  { difficulty_id: 32, font_grade: '8c', v_grade: 'V15', difficulty_name: '8c/V15' },
  { difficulty_id: 33, font_grade: '8c+', v_grade: 'V16', difficulty_name: '8c+/V16' },
] as const;

export type BoulderGrade = {
  readonly difficulty_id: number;
  readonly font_grade: string;
  readonly v_grade: string;
  readonly difficulty_name: string;
};

/**
 * The difficulty ids a MoonBoard problem can be graded at. Moon's own scale is
 * 5+, 6A, 6A+, 6B … 8C+, so it skips the shared 5b and 5c stops (14, 15) and
 * everything under 5a. Lists (the grade rail, filters, the setter picker) offer
 * only these; a label lookup still resolves 14/15, because a community grade
 * average can round onto them.
 */
export const MOONBOARD_DIFFICULTY_IDS: ReadonlySet<number> = new Set(
  BOULDER_GRADES.map((grade) => grade.difficulty_id).filter(
    (difficultyId) => difficultyId === 13 || difficultyId >= 16,
  ),
);

/**
 * Where Moon Climbing's Font → V conversion disagrees with the shared (Aurora)
 * one. The MoonBoard app shows 6A as V2; the shared table says 6a/V3. Ids are
 * unchanged, so ticks, filters and stats still compare across boards; only the
 * V half of the label moves.
 */
const MOONBOARD_V_GRADE_OVERRIDES: ReadonlyMap<number, string> = new Map([[16, 'V2']]);

/** Every shared difficulty id, labelled the way the MoonBoard app labels it. */
export const MOONBOARD_BOULDER_GRADES: readonly BoulderGrade[] = BOULDER_GRADES.map((grade) => {
  const vGrade = MOONBOARD_V_GRADE_OVERRIDES.get(grade.difficulty_id);
  if (!vGrade) return grade;
  return { ...grade, v_grade: vGrade, difficulty_name: `${grade.font_grade}/${vGrade}` };
});

/**
 * The id → label table for one board. MoonBoard has its own V conversion; every
 * other board (and an unknown or missing board name) uses the shared table.
 * Matches `board_difficulty_grades.boulder_name` for that board.
 */
export function getBoulderGradesForBoard(boardName: string | null | undefined): readonly BoulderGrade[] {
  return boardName === 'moonboard' ? MOONBOARD_BOULDER_GRADES : BOULDER_GRADES;
}
