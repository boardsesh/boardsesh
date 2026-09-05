// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { SUPPORTED_BOARDS as ALL_SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import type { BoardName } from '@boardsesh/shared-schema';
import type { Angle } from './types';
import { MOONBOARD_ENABLED, MOONBOARD_ANGLES, MOONBOARD_WIDE_ANGLES } from './moonboard-config';
import { WOODS_DIFFICULTY_IDS } from '@boardsesh/board-constants/woods';
import { WOODS_ANGLES } from './woods-config';

type ImageDimensions = Record<
  string,
  {
    width: number;
    height: number;
  }
>;

// Conditionally include the non-Aurora boards based on their feature flags.
// Aurora boards are always enabled; moonboard gates on its flag. Woods ships unflagged.
export const SUPPORTED_BOARDS: BoardName[] = [...ALL_SUPPORTED_BOARDS].filter((boardName) => {
  if (boardName === 'moonboard') return MOONBOARD_ENABLED;
  return true;
});

export const BOARD_IMAGE_DIMENSIONS: Record<BoardName, ImageDimensions> = {
  kilter: {
    'product_sizes_layouts_sets/15_5_24.png': { width: 1080, height: 2498 },
    'product_sizes_layouts_sets/36-1.png': { width: 1080, height: 1350 },
    'product_sizes_layouts_sets/38-1.png': { width: 1080, height: 1350 },
    'product_sizes_layouts_sets/39-1.png': { width: 1080, height: 1755 },
    'product_sizes_layouts_sets/41-1.png': { width: 1080, height: 1755 },
    'product_sizes_layouts_sets/45-1.png': { width: 1080, height: 1170 },
    'product_sizes_layouts_sets/46-1.png': { width: 1080, height: 1170 },
    'product_sizes_layouts_sets/47.png': { width: 1200, height: 663 },
    'product_sizes_layouts_sets/48.png': { width: 1080, height: 1080 },
    'product_sizes_layouts_sets/49.png': { width: 1080, height: 1188 },
    'product_sizes_layouts_sets/50-1.png': { width: 1080, height: 1473 },
    'product_sizes_layouts_sets/51-1.png': { width: 1080, height: 1473 },
    'product_sizes_layouts_sets/53.png': { width: 1080, height: 1636 },
    'product_sizes_layouts_sets/54.png': { width: 1080, height: 1636 },
    'product_sizes_layouts_sets/55-v2.png': { width: 1080, height: 1473 },
    'product_sizes_layouts_sets/56-v3.png': { width: 1080, height: 1473 },
    'product_sizes_layouts_sets/59.png': { width: 1080, height: 1404 },
    'product_sizes_layouts_sets/60-v3.png': { width: 1080, height: 1157 },
    'product_sizes_layouts_sets/61-v3.png': { width: 1080, height: 1157 },
    'product_sizes_layouts_sets/63-v3.png': { width: 1080, height: 1915 },
    'product_sizes_layouts_sets/64-v3.png': { width: 1080, height: 1915 },
    'product_sizes_layouts_sets/65-v2.png': { width: 1080, height: 1915 },
    'product_sizes_layouts_sets/66-v2.png': { width: 1080, height: 1915 },
    'product_sizes_layouts_sets/70-v2.png': { width: 1080, height: 1504 },
    'product_sizes_layouts_sets/71-v3.png': { width: 1080, height: 1504 },
    'product_sizes_layouts_sets/72.png': { width: 1080, height: 1504 },
    'product_sizes_layouts_sets/73.png': { width: 1080, height: 1504 },
    'product_sizes_layouts_sets/77-1.png': { width: 1080, height: 1080 },
    'product_sizes_layouts_sets/78-1.png': { width: 1080, height: 1080 },
    'product_sizes_layouts_sets/original-16x12-bolt-ons-v2.png': { width: 1477, height: 1200 },
    'product_sizes_layouts_sets/original-16x12-screw-ons-v2.png': { width: 1477, height: 1200 },
  },
  tension: {
    'product_sizes_layouts_sets/1.png': { width: 1080, height: 1755 },
    'product_sizes_layouts_sets/10.png': { width: 1080, height: 1665 },
    'product_sizes_layouts_sets/11.png': { width: 1080, height: 1665 },
    'product_sizes_layouts_sets/12.png': { width: 1080, height: 1665 },
    'product_sizes_layouts_sets/12x10-tb2-plastic.png': { width: 1080, height: 953 },
    'product_sizes_layouts_sets/12x10-tb2-wood.png': { width: 1080, height: 953 },
    'product_sizes_layouts_sets/12x12-tb2-plastic.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/12x12-tb2-wood.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/13.png': { width: 1080, height: 1395 },
    'product_sizes_layouts_sets/14.png': { width: 1080, height: 1395 },
    'product_sizes_layouts_sets/15.png': { width: 1080, height: 1395 },
    'product_sizes_layouts_sets/16.png': { width: 1080, height: 1395 },
    'product_sizes_layouts_sets/17.png': { width: 1080, height: 2093 },
    'product_sizes_layouts_sets/18.png': { width: 1080, height: 2093 },
    'product_sizes_layouts_sets/19.png': { width: 1080, height: 2093 },
    'product_sizes_layouts_sets/2.png': { width: 1080, height: 1755 },
    'product_sizes_layouts_sets/20.png': { width: 1080, height: 2093 },
    'product_sizes_layouts_sets/21-2.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/22-2.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/23.png': { width: 1080, height: 953 },
    'product_sizes_layouts_sets/24-2.png': { width: 1080, height: 953 },
    'product_sizes_layouts_sets/25.png': { width: 1080, height: 1767 },
    'product_sizes_layouts_sets/26.png': { width: 1080, height: 1767 },
    'product_sizes_layouts_sets/27.png': { width: 1080, height: 1473 },
    'product_sizes_layouts_sets/28.png': { width: 1080, height: 1473 },
    'product_sizes_layouts_sets/3.png': { width: 1080, height: 1755 },
    // Tension Board 2 — 12 high x 16 wide (product_size_id=10), landscape orientation.
    'product_sizes_layouts_sets/37.png': { width: 1461, height: 1144 },
    'product_sizes_layouts_sets/38.png': { width: 1461, height: 1144 },
    'product_sizes_layouts_sets/39.png': { width: 1461, height: 1144 },
    'product_sizes_layouts_sets/4.png': { width: 1080, height: 1755 },
    'product_sizes_layouts_sets/40.png': { width: 1461, height: 1144 },
    'product_sizes_layouts_sets/41.png': { width: 1461, height: 1144 },
    'product_sizes_layouts_sets/42.png': { width: 1461, height: 1144 },
    'product_sizes_layouts_sets/5.png': { width: 1080, height: 1710 },
    'product_sizes_layouts_sets/6.png': { width: 1080, height: 1710 },
    'product_sizes_layouts_sets/7.png': { width: 1080, height: 1710 },
    'product_sizes_layouts_sets/8.png': { width: 1080, height: 1710 },
    'product_sizes_layouts_sets/8x10-tb2-plastic.png': { width: 1080, height: 1473 },
    'product_sizes_layouts_sets/8x10-tb2-wood.png': { width: 1080, height: 1473 },
    'product_sizes_layouts_sets/8x12-tb2-plastic.png': { width: 1080, height: 1767 },
    'product_sizes_layouts_sets/8x12-tb2-wood.png': { width: 1080, height: 1767 },
    'product_sizes_layouts_sets/9.png': { width: 1080, height: 1665 },
  },
  moonboard: {
    // MoonBoard 2010
    'moonboard2010/originalschoolholds.png': { width: 650, height: 1000 },
    // MoonBoard 2016
    'moonboard2016/holdseta.png': { width: 650, height: 1000 },
    'moonboard2016/holdsetb.png': { width: 650, height: 1000 },
    'moonboard2016/originalschoolholds.png': { width: 650, height: 1000 },
    // MoonBoard 2024
    'moonboard2024/holdsetd.png': { width: 650, height: 1000 },
    'moonboard2024/holdsete.png': { width: 650, height: 1000 },
    'moonboard2024/holdsetf.png': { width: 650, height: 1000 },
    'moonboard2024/woodenholds.png': { width: 650, height: 1000 },
    'moonboard2024/woodenholdsb.png': { width: 650, height: 1000 },
    'moonboard2024/woodenholdsc.png': { width: 650, height: 1000 },
    // MoonBoard Masters 2017
    'moonboardmasters2017/holdseta.png': { width: 650, height: 1000 },
    'moonboardmasters2017/holdsetb.png': { width: 650, height: 1000 },
    'moonboardmasters2017/holdsetc.png': { width: 650, height: 1000 },
    'moonboardmasters2017/originalschoolholds.png': { width: 650, height: 1000 },
    'moonboardmasters2017/screw-onfeet.png': { width: 650, height: 1000 },
    'moonboardmasters2017/woodenholds.png': { width: 650, height: 1000 },
    // MoonBoard Masters 2019
    'moonboardmasters2019/holdseta.png': { width: 650, height: 1000 },
    'moonboardmasters2019/holdsetb.png': { width: 650, height: 1000 },
    'moonboardmasters2019/originalschoolholds.png': { width: 650, height: 1000 },
    'moonboardmasters2019/screw-onfeet.png': { width: 650, height: 1000 },
    'moonboardmasters2019/woodenholds.png': { width: 650, height: 1000 },
    'moonboardmasters2019/woodenholdsb.png': { width: 650, height: 1000 },
    'moonboardmasters2019/woodenholdsc.png': { width: 650, height: 1000 },
    // Mini MoonBoard 2020 — shorter board art (11 cols × rows 2–12).
    'minimoonboard2020/originalschoolholds.png': { width: 650, height: 694 },
    'minimoonboard2020/woodenholds.png': { width: 650, height: 694 },
    'minimoonboard2020/woodenholdsb.png': { width: 650, height: 694 },
    'minimoonboard2020/woodenholdsc.png': { width: 650, height: 694 },
    // Mini MoonBoard 2025 — shorter board art (11 cols × rows 1–12).
    'minimoonboard2025/holdsetf.png': { width: 650, height: 694 },
    'minimoonboard2025/originalschoolholds.png': { width: 650, height: 694 },
    'minimoonboard2025/woodenholdsb.png': { width: 650, height: 694 },
    'minimoonboard2025/woodenholdsc.png': { width: 650, height: 694 },
  },
  decoy: {
    'product_sizes_layouts_sets/1.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/10.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/11.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/12.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/12x12_foundation_12x12.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/12x12_foundation_feet_12x12.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/12x12_lime_foot_12x12.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/12x12_lime_foot.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/12x12_lime.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/12x12_pacos_12x12.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/12x12_rollies_12x12.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/12x12_sams_12x12.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/12x12_schist_12x12.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/13-2.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/14.png': { width: 1080, height: 1767 },
    'product_sizes_layouts_sets/15.png': { width: 1080, height: 1767 },
    'product_sizes_layouts_sets/16.png': { width: 1080, height: 1767 },
    'product_sizes_layouts_sets/17.png': { width: 1080, height: 1767 },
    'product_sizes_layouts_sets/18.png': { width: 1080, height: 1767 },
    'product_sizes_layouts_sets/19.png': { width: 1080, height: 1767 },
    'product_sizes_layouts_sets/2.png': { width: 1080, height: 1767 },
    'product_sizes_layouts_sets/20.png': { width: 1080, height: 1767 },
    'product_sizes_layouts_sets/21.png': { width: 1080, height: 1767 },
    'product_sizes_layouts_sets/22.png': { width: 1080, height: 1767 },
    'product_sizes_layouts_sets/23-2.png': { width: 1080, height: 1767 },
    'product_sizes_layouts_sets/24.png': { width: 1080, height: 1473 },
    'product_sizes_layouts_sets/25.png': { width: 1080, height: 1473 },
    'product_sizes_layouts_sets/26.png': { width: 1080, height: 1473 },
    'product_sizes_layouts_sets/27.png': { width: 1080, height: 1473 },
    'product_sizes_layouts_sets/28.png': { width: 1080, height: 1473 },
    'product_sizes_layouts_sets/29.png': { width: 1080, height: 1473 },
    'product_sizes_layouts_sets/3.png': { width: 1080, height: 1473 },
    'product_sizes_layouts_sets/30.png': { width: 1080, height: 1473 },
    'product_sizes_layouts_sets/31.png': { width: 1080, height: 1473 },
    'product_sizes_layouts_sets/32.png': { width: 1080, height: 1473 },
    'product_sizes_layouts_sets/33-2.png': { width: 1080, height: 1473 },
    'product_sizes_layouts_sets/4.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/5.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/6.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/7.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/8.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/8x10_lime_foot.png': { width: 1080, height: 1473 },
    'product_sizes_layouts_sets/8x10_lime.png': { width: 1080, height: 1473 },
    'product_sizes_layouts_sets/8x12_lime_foot.png': { width: 1080, height: 1767 },
    'product_sizes_layouts_sets/8x12_lime.png': { width: 1080, height: 1767 },
    'product_sizes_layouts_sets/9.png': { width: 1080, height: 1144 },
  },
  touchstone: {
    'product_sizes_layouts_sets/1-v2.png': { width: 1080, height: 1170 },
    'product_sizes_layouts_sets/1-v4.png': { width: 1080, height: 1170 },
  },
  grasshopper: {
    'product_sizes_layouts_sets/1_v3.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/12x12-2020-flow.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/12x12-2020-tweeners-v2.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/13_v2.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/14.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/3_v3.png': { width: 1080, height: 1144 },
    'product_sizes_layouts_sets/8x10-2020-engage.png': { width: 1080, height: 1473 },
    'product_sizes_layouts_sets/8x10-2020-flow.png': { width: 1080, height: 1473 },
    'product_sizes_layouts_sets/8x10-2020-gradient.png': { width: 1080, height: 1473 },
    'product_sizes_layouts_sets/8x10-2020-power.png': { width: 1080, height: 1473 },
    'product_sizes_layouts_sets/8x10-2020-tweeners-v2.png': { width: 1080, height: 1473 },
    'product_sizes_layouts_sets/8x12-2020-engage.png': { width: 1080, height: 1767 },
    'product_sizes_layouts_sets/8x12-2020-flow.png': { width: 1080, height: 1767 },
    'product_sizes_layouts_sets/8x12-2020-gradient.png': { width: 1080, height: 1767 },
    'product_sizes_layouts_sets/8x12-2020-power.png': { width: 1080, height: 1767 },
    'product_sizes_layouts_sets/8x12-2020-tweeners-v2.png': { width: 1080, height: 1767 },
  },
  soill: {
    'product_sizes_layouts_sets/1-v3.png': { width: 1080, height: 1800 },
    'product_sizes_layouts_sets/2-v2.png': { width: 1080, height: 1200 },
  },
  // Woods board art extracted from the decompiled Woods app. Keys end in `.png`
  // because every consumer rewrites the extension to `.webp` at request time.
  woods: {
    'woods-8x10-bg.png': { width: 720, height: 1000 },
    'woods-12x12-bg.png': { width: 1225, height: 1400 },
  },
};

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
import { BOULDER_GRADES, type BoulderGrade } from '@boardsesh/board-constants/boulder-grade-mapping';
export { BOULDER_GRADES, type BoulderGrade };

// Alias for backwards compatibility
export const TENSION_KILTER_GRADES = BOULDER_GRADES;

// MoonBoard supports grades from 5+ (V1) and above
// Uses Font grade notation (uppercase) for display
export const MOONBOARD_MIN_DIFFICULTY_ID = 13; // 5a/V1 (MoonBoard "5+" grade)

// Helper to get grades for a specific board
export function getGradesForBoard(boardName: BoardName) {
  if (boardName === 'moonboard') {
    return BOULDER_GRADES.filter((g) => g.difficulty_id >= MOONBOARD_MIN_DIFFICULTY_ID);
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
