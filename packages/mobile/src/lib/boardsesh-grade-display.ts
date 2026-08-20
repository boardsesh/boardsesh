// Pure, O(1) resolver for how a climb/tick renders its grade under the
// app-wide "Show Boardsesh grades" preference (boardsesh-grades-preference.ts
// + hooks/use-display-grade.ts): the data-science Boardsesh grade versus the
// legacy Aurora-set difficulty. No React — one Map lookup + format per call,
// so list rows can call this per item without cost.
//
// Owns the difficulty-scale primitives (GRADE_BY_ID, renderDifficulty,
// clampDifficultyId, MIN/MAX_DIFFICULTY_ID) that used to live in the play
// drawer's boardsesh-grade-utils.ts. That file now re-exports them from here
// unchanged so its own callers (buildBoardseshGradeView) and tests are
// untouched — a lib must not import from components, so the primitives moved
// here and components import them, never the reverse.
import { formatGrade, type GradeDisplayFormat } from '@boardsesh/play-view';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { BOULDER_GRADES, type BoulderGrade } from '@boardsesh/board-constants/boulder-grade-mapping';
import { BOARDSESH_TIER, isCrossAngleEstimate, resolveCrowdDifficulty } from '@boardsesh/logbook';

export const GRADE_BY_ID = new Map<number, BoulderGrade>(BOULDER_GRADES.map((grade) => [grade.difficulty_id, grade]));

// The difficulty scale the data-science grade shares with Aurora's ids.
export const MIN_DIFFICULTY_ID = BOULDER_GRADES[0].difficulty_id;
export const MAX_DIFFICULTY_ID = BOULDER_GRADES[BOULDER_GRADES.length - 1].difficulty_id;

export type RenderedGrade = {
  /** Formatted label per the user's grade preference (e.g. "V5", "6c"). */
  label: string;
  /** Hex colour for the grade, consistent with the play drawer header. */
  color: string;
};

/** Round to the nearest grade id and clamp to the shared difficulty scale. */
export function clampDifficultyId(value: number): number {
  return Math.min(MAX_DIFFICULTY_ID, Math.max(MIN_DIFFICULTY_ID, Math.round(value)));
}

/** Round a float difficulty to the nearest grade and render its label + colour. */
export function renderDifficulty(value: number, gradeFormat: GradeDisplayFormat): RenderedGrade | null {
  const grade = GRADE_BY_ID.get(clampDifficultyId(value));
  if (!grade) return null;
  return {
    label: formatGrade(grade.difficulty_name, gradeFormat) ?? grade.v_grade,
    color: getGradeColor(grade.difficulty_name) ?? DEFAULT_GRADE_COLOR,
  };
}

// --- App-wide "Show Boardsesh grades" resolver ------------------------------

/** The two Boardsesh grade fields carried on every climb and tick/ascent object. */
export type BoardseshGradeFields = {
  boardseshDifficulty?: number | null;
  boardseshConfidence?: string | null;
};

export type DisplayGrade = {
  label: string;
  color: string;
  /** True when this label/color came from the Boardsesh grade, not the legacy Aurora grade. */
  isBoardsesh: boolean;
  /**
   * True when the grade was projected from the climb's other angles because
   * nobody has climbed this one (`cross_angle_estimate`). The label already
   * carries the `≈` marker; this flag lets a row also mute or annotate it.
   */
  isEstimated: boolean;
};

/**
 * Marks a projected grade wherever it appears next to real ones. A single
 * character so it fits the tightest list chip without a layout change, and it
 * reads the same in every language — the play drawer spells the caveat out in
 * words, list rows carry the glyph.
 */
export const ESTIMATE_PREFIX = '≈';

/**
 * The raw Boardsesh difficulty value a climb/tick should use, or null when
 * there is none or it isn't trusted enough to show (`setter_only`
 * confidence). Does not check the app-wide toggle — callers gate on that
 * separately (see `resolveDisplayGrade`, `useDisplayGrade`).
 *
 * A `cross_angle_estimate` DOES pass: it is a real number, it is what grade
 * search/sort/filter now index on, and hiding it would put the list back in
 * disagreement with the detail view. Callers that render it must mark it — see
 * `resolveDisplayGrade`'s `isEstimated`.
 */
export function resolveBoardseshDifficulty(fields: BoardseshGradeFields): number | null {
  if (fields.boardseshDifficulty == null) return null;
  if (fields.boardseshConfidence === BOARDSESH_TIER.setterOnly) return null;
  return fields.boardseshDifficulty;
}

/** `resolveBoardseshDifficulty`, rounded to a real grade bucket and clamped to the scale. */
export function resolveBoardseshDifficultyId(fields: BoardseshGradeFields): number | null {
  const difficulty = resolveBoardseshDifficulty(fields);
  if (difficulty == null) return null;
  return clampDifficultyId(difficulty);
}

/**
 * Resolve how a climb/tick renders its grade under the "Show Boardsesh
 * grades" preference: the Boardsesh grade when the toggle is on and one is
 * available and trusted, otherwise the legacy Aurora-set grade. This never
 * looks at a climber's own logged ascent grade — a user grade always wins,
 * so callers with one must check it themselves before falling through here.
 */
export function resolveDisplayGrade(
  climb: BoardseshGradeFields & { difficulty?: string | null },
  opts: { useBoardseshGrades: boolean; gradeFormat: GradeDisplayFormat },
): DisplayGrade {
  if (opts.useBoardseshGrades) {
    const boardseshId = resolveBoardseshDifficultyId(climb);
    if (boardseshId != null) {
      const rendered = renderDifficulty(boardseshId, opts.gradeFormat);
      if (rendered) {
        // A projected angle wears the marker everywhere it is shown, including
        // the compact chips in search results, the queue and session rows —
        // otherwise a grade nobody has climbed reads identically to one 200
        // people have.
        const estimated = isCrossAngleEstimate(climb.boardseshConfidence);
        return {
          ...rendered,
          label: estimated ? `${ESTIMATE_PREFIX}${rendered.label}` : rendered.label,
          isBoardsesh: true,
          isEstimated: estimated,
        };
      }
    }
  }
  return {
    label: formatGrade(climb.difficulty, opts.gradeFormat) ?? climb.difficulty ?? '',
    color: getGradeColor(climb.difficulty) ?? DEFAULT_GRADE_COLOR,
    isBoardsesh: false,
    isEstimated: false,
  };
}

/**
 * Which crowd-sourced difficulty id a row should show for an ungraded
 * ascent: the Boardsesh grade when the toggle is on and one is trusted,
 * otherwise the legacy community consensus. Re-exported (renamed) from
 * `@boardsesh/logbook`'s `resolveCrowdDifficulty` — same rules, same tests —
 * so mobile has one source of truth for the toggle/consensus fallback
 * instead of a second implementation to keep in sync.
 */
export const resolveCrowdDifficultyId = resolveCrowdDifficulty;

/**
 * The Aurora `difficulty_name` string (e.g. `"6b/V4"`) for the Boardsesh
 * grade, used to seed the tick picker's default grade when a climber hasn't
 * graded their own ascent. Logging itself still writes to the normal Aurora
 * scale — this only chooses which value the picker opens on.
 *
 * A `cross_angle_estimate` never seeds the picker. Everything else here is a
 * grade the crowd produced, so pre-filling it is just showing the climber what
 * the crowd already thinks; a projection is the MODEL's number, and pre-filling
 * that would feed the model's own output back into the ascent grades it is
 * estimated from. The echo problem the whole model is built to correct for
 * (docs/boardsesh-grade.md §2) is exactly this loop, and the first ascents at a
 * new angle are the ones with the least reason to be anchored.
 */
export function resolveTickDefaultGradeName(fields: BoardseshGradeFields, useBoardseshGrades: boolean): string | null {
  if (!useBoardseshGrades) return null;
  if (isCrossAngleEstimate(fields.boardseshConfidence)) return null;
  const boardseshId = resolveBoardseshDifficultyId(fields);
  if (boardseshId == null) return null;
  return GRADE_BY_ID.get(boardseshId)?.difficulty_name ?? null;
}
