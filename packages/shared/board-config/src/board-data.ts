import { SUPPORTED_BOARDS as ALL_SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import type { BoardName } from '@boardsesh/shared-schema';
import type { Angle } from './types';
import { MOONBOARD_ENABLED, MOONBOARD_ANGLES, MOONBOARD_WIDE_ANGLES } from './moonboard-config';
import { WOODS_DIFFICULTY_IDS } from '@boardsesh/board-constants/woods';
import { WOODS_ANGLES } from './woods-config';
import { SPRAY_ANGLES } from './spray-config';

// The boards a generic picker may LIST. Deliberately narrower than the schema's
// `SUPPORTED_BOARDS`, which answers "is this a board?" — this one answers "may a
// board picker offer it?".
//
// Aurora boards are always enabled; moonboard gates on its flag. Woods ships
// unflagged. `spray` is excluded outright and not behind a flag: a spray wall is
// not a board model you pick from a list, it is a wall a climber creates, so it
// has no catalogue rows for the picker, the board builder or the wall finder to
// build an option from. It is reached through its own `/b/{slug}` board and its
// add-a-wall flow (SW-09).
export const SUPPORTED_BOARDS: BoardName[] = [...ALL_SUPPORTED_BOARDS].filter((boardName) => {
  if (boardName === 'moonboard') return MOONBOARD_ENABLED;
  if (boardName === 'spray') return false;
  return true;
});

export { BOARD_IMAGE_DIMENSIONS } from './board-image-dimensions';

export const ANGLES: Record<BoardName, Angle[]> = {
  kilter: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70],
  tension: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70],
  moonboard: [...MOONBOARD_ANGLES],
  // New Aurora boards use the same angle range as Kilter/Tension
  decoy: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70],
  touchstone: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70],
  grasshopper: [-5, 0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70],
  soill: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70],
  woods: [...WOODS_ANGLES],
  // A wall's angle is fixed at creation; this is the list the create flow offers
  // once, not a rail. See SPRAY_ANGLES.
  spray: [...SPRAY_ANGLES],
};

// Module scope so every call returns the same array reference (a stable dep/memo key).
const MOONBOARD_WIDE_ANGLE_OPTIONS: Angle[] = [...MOONBOARD_WIDE_ANGLES];

// Angle options for `boardName`: ANGLES[boardName], except MoonBoard swaps in
// the full Kilter/Tension-style range when `wideAnglesEnabled` is true (the
// `moonboard-wide-angles` feature flag, read by the platform-specific
// `useBoardAngleOptions` hooks in web and mobile). Pure so it's shared as-is
// by both platforms instead of duplicating the branch.
export function getBoardAngleOptions(boardName: BoardName, wideAnglesEnabled: boolean): Angle[] {
  if (boardName === 'moonboard' && wideAnglesEnabled) {
    return MOONBOARD_WIDE_ANGLE_OPTIONS;
  }
  return ANGLES[boardName];
}

const NON_NEGATIVE_ROUTABLE_ANGLES: Angle[] = Array.from({ length: 91 }, (_, angle) => angle);

// Module scope for the same reason as MOONBOARD_WIDE_ANGLE_OPTIONS above: one
// stable reference rather than a fresh 92-element spread per call. This is on
// the climb-view render path, the busiest route on the site.
const GRASSHOPPER_ROUTABLE_ANGLES: Angle[] = [ANGLES.grasshopper[0], ...NON_NEGATIVE_ROUTABLE_ANGLES];

/**
 * Every angle that may appear as a canonical URL segment for a board.
 *
 * Picker options use practical 5-degree steps, but existing write contracts
 * accept every integer from 0° through 90°. Keep those stored board and climb
 * URLs routable; Grasshopper additionally supports its real -5° slab setting.
 */
export function getRoutableBoardAngles(boardName: BoardName): Angle[] {
  return boardName === 'grasshopper' ? GRASSHOPPER_ROUTABLE_ANGLES : NON_NEGATIVE_ROUTABLE_ANGLES;
}

/**
 * Parse an exact, canonical board-angle route segment.
 *
 * Comparing against the decimal spelling of known angles deliberately rejects
 * numeric aliases such as `040`, `40.0`, `+40`, and surrounding whitespace.
 */
export function parseBoardAngleSegment(boardName: BoardName, segment: string): Angle | null {
  const parsedAngle = Number(segment);
  if (!Number.isInteger(parsedAngle) || String(parsedAngle) !== segment) return null;
  return getRoutableBoardAngles(boardName).includes(parsedAngle) ? parsedAngle : null;
}

// BOULDER_GRADES + BoulderGrade live in @boardsesh/board-constants so display
// utilities can depend on the grade taxonomy without pulling in the rest of
// board-config (image dimensions, set IDs, moonboard config). Re-exported
// here for back-compat with existing call sites.
import {
  BOULDER_GRADES,
  MOONBOARD_DIFFICULTY_IDS,
  getBoulderGradesForBoard,
  type BoulderGrade,
} from '@boardsesh/board-constants/boulder-grade-mapping';
export { BOULDER_GRADES, getBoulderGradesForBoard, type BoulderGrade };

// Alias for backwards compatibility
export const TENSION_KILTER_GRADES = BOULDER_GRADES;

// MoonBoard supports grades from 5+ (V1) and above
// Uses Font grade notation (uppercase) for display
export const MOONBOARD_MIN_DIFFICULTY_ID = 13; // 5a/V1 (MoonBoard "5+" grade)

// Helper to get grades for a specific board
export function getGradesForBoard(boardName: BoardName): readonly BoulderGrade[] {
  if (boardName === 'moonboard') {
    // Moon's scale (5+, 6A, 6A+ …) has no 5b/5c, and labels 6A as V2.
    return getBoulderGradesForBoard(boardName).filter((grade) => MOONBOARD_DIFFICULTY_IDS.has(grade.difficulty_id));
  }
  if (boardName === 'woods') {
    // The Woods app grades on a 0-based V scale, and the importer folds each V
    // band onto the LOWEST shared difficulty id in it, so only 17 of the 24 ids
    // ever appear on a Woods climb. Offering the whole ladder would put dead
    // stops on the grade rail and in the filters — a range no climb can match.
    return BOULDER_GRADES.filter((grade) => WOODS_DIFFICULTY_IDS.has(grade.difficulty_id));
  }
  return BOULDER_GRADES;
}

// Helper to convert Font grade string to difficulty ID
// Handles various formats from OCR:
// - "6a", "7b+" (lowercase Font grade)
// - "6A", "7B+" (uppercase Font grade)
// - "6A/V3", "7B+/V8" (combined Font + V-grade from MoonBoard OCR)
export function fontGradeToDifficultyId(fontGrade: string): number | null {
  // Extract just the Font grade portion if combined with V-grade (e.g., "6A/V3" -> "6A")
  const fontPart = fontGrade.split('/')[0].trim();
  // Normalize to lowercase for comparison
  const normalized = fontPart.toLowerCase();
  const grade = BOULDER_GRADES.find((g) => g.font_grade === normalized);
  return grade?.difficulty_id ?? null;
}

// Helper to get grade info by difficulty ID
// Note: difficultyId may come from database as a float (doublePrecision), so we round it
export function getGradeByDifficultyId(difficultyId: number): BoulderGrade | undefined {
  const roundedId = Math.round(difficultyId);
  return BOULDER_GRADES.find((g) => g.difficulty_id === roundedId);
}
