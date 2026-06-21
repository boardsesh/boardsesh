/**
 * Grade color scheme — a punchier yellow→red→purple arc that ends on the
 * Boardsesh logo's V11–V16 purples (kept byte-for-byte).
 *
 * Color progression from yellow (easy) to purple (hard):
 * - V0: Golden yellow
 * - V1-V2: Orange
 * - V3-V4: Red-orange
 * - V5-V6: Red
 * - V7-V10: Crimson → magenta → grape (bridge into the logo purples)
 * - V11+: Purple (logo range — unchanged)
 *
 * Luminance descends monotonically except the single V10→V11 step, which is
 * inherent: the fixed logo purple V11 is brighter than its grape neighbours. The
 * per-pill text colour is auto-picked by contrast (black on V0–V6, white on V7+).
 */

// V-grade to hex color mapping
export const V_GRADE_COLORS: Record<string, string> = {
  V0: '#FFD400', // Golden yellow
  V1: '#FFB300', // Amber
  V2: '#FF9100', // Orange
  V3: '#FF6D2E', // Deep orange
  V4: '#FF5026', // Red-orange
  V5: '#F03E3E', // Red
  V6: '#E22A2A', // Red (slightly darker)
  V7: '#CF1F3C', // Crimson
  V8: '#B81A5A', // Raspberry
  V9: '#9E1A78', // Magenta-purple
  V10: '#7E1C8E', // Grape (bridge into the logo purples)
  V11: '#9C27B0', // Purple (logo)
  V12: '#7B1FA2', // Dark purple (logo)
  V13: '#6A1B9A', // Darker purple (logo)
  V14: '#5C1A87', // Deep purple (logo)
  V15: '#4A148C', // Very deep purple (logo)
  V16: '#38006B', // Near black purple (logo)
  V17: '#2A0054', // Darkest purple
};

// Font grade to hex color mapping (uses same color as corresponding V-grade)
export const FONT_GRADE_COLORS: Record<string, string> = {
  '4a': '#FFD400', // V0
  '4b': '#FFD400', // V0
  '4c': '#FFD400', // V0
  '5a': '#FFB300', // V1
  '5b': '#FFB300', // V1
  '5c': '#FF9100', // V2
  '6a': '#FF6D2E', // V3
  '6a+': '#FF6D2E', // V3
  '6b': '#FF5026', // V4
  '6b+': '#FF5026', // V4
  '6c': '#F03E3E', // V5
  '6c+': '#F03E3E', // V5
  '7a': '#E22A2A', // V6
  '7a+': '#CF1F3C', // V7
  '7b': '#B81A5A', // V8
  '7b+': '#B81A5A', // V8
  '7c': '#9E1A78', // V9
  '7c+': '#7E1C8E', // V10
  '8a': '#9C27B0', // V11
  '8a+': '#7B1FA2', // V12
  '8b': '#6A1B9A', // V13
  '8b+': '#5C1A87', // V14
  '8c': '#4A148C', // V15
  '8c+': '#38006B', // V16
};

// Default color when grade cannot be determined
export const DEFAULT_GRADE_COLOR = '#808080';

/**
 * Get color for a V-grade string (e.g., "V3", "V10", "V5+")
 * @returns Hex color string, or undefined if not found
 */
export function getVGradeColor(vGrade: string | null | undefined): string | undefined {
  if (!vGrade) return undefined;
  // Strip trailing "+" so "V5+" looks up the same color as "V5"
  const normalized = vGrade.toUpperCase().replace(/\+$/, '');
  return V_GRADE_COLORS[normalized];
}

/**
 * Get color for a Font grade string (e.g., "6a", "7b+")
 * @returns Hex color string, or undefined if not found
 */
export function getFontGradeColor(fontGrade: string | null | undefined): string | undefined {
  if (!fontGrade) return undefined;
  return FONT_GRADE_COLORS[fontGrade.toLowerCase()];
}

/**
 * Get color for a difficulty string that may contain both Font and V-grade (e.g., "6a/V3")
 * Extracts the V-grade and returns its color.
 * @returns Hex color string, or undefined if no grade found
 */
export function getGradeColor(difficulty: string | null | undefined): string | undefined {
  if (!difficulty) return undefined;

  // Try to extract V-grade first
  const vGradeMatch = difficulty.match(/V\d+/i);
  if (vGradeMatch) {
    return getVGradeColor(vGradeMatch[0]);
  }

  // Fall back to Font grade
  const fontGradeMatch = difficulty.match(/\d[abc]\+?/i);
  if (fontGradeMatch) {
    return getFontGradeColor(fontGradeMatch[0]);
  }

  return undefined;
}
