import { getGradeColor, getVGradeColor, getFontGradeColor } from '@boardsesh/board-constants/grade-colors';
// Import via the narrow `/boulder-grade-mapping` deep-path so we don't pull
// the whole @boardsesh/board-config module graph (board image dimensions,
// set IDs, moonboard config) into anything that touches the grade helpers.
import { BOULDER_GRADES } from '@boardsesh/board-constants/boulder-grade-mapping';

// Re-export for convenience
export { getGradeColor };

// V-grades that map from multiple Font grades. Only these need "+" disambiguation
// when the source difficulty's Font part ends with "+". Computed once at module
// load from BOULDER_GRADES so the set stays in sync with config.
const V_GRADES_WITH_MULTIPLE_FONT_GRADES: Set<string> = (() => {
  const countByVGrade = new Map<string, number>();
  for (const grade of BOULDER_GRADES) {
    countByVGrade.set(grade.v_grade, (countByVGrade.get(grade.v_grade) ?? 0) + 1);
  }
  const result = new Set<string>();
  for (const [vGrade, count] of countByVGrade) {
    if (count > 1) result.add(vGrade);
  }
  return result;
})();

function extractVGrade(difficulty: string | null | undefined): string | null {
  if (!difficulty) return null;
  const vGradeMatch = difficulty.match(/V\d+/i);
  return vGradeMatch ? vGradeMatch[0].toUpperCase() : null;
}

function extractFontGrade(difficulty: string | null | undefined): string | null {
  if (!difficulty) return null;
  const slashIndex = difficulty.indexOf('/');
  if (slashIndex > 0) {
    return difficulty.substring(0, slashIndex).toUpperCase();
  }
  const fontGradeMatch = difficulty.match(/\d[abc]\+?/i);
  return fontGradeMatch ? fontGradeMatch[0].toUpperCase() : null;
}

/**
 * Format a difficulty string to a V-grade display label.
 * Adds "+" only when the Font grade has "+" AND the V-grade has multiple Font
 * grade mappings (e.g., "6c+/V5" → "V5+" because V5 maps from both 6c and 6c+).
 * V-grades with a single Font mapping (e.g., "7a+/V7") never get a "+".
 */
export function formatVGrade(difficulty: string | null | undefined): string | null {
  if (!difficulty) return null;
  const vGrade = extractVGrade(difficulty);
  if (!vGrade) return null;
  const slashIndex = difficulty.indexOf('/');
  if (slashIndex > 0) {
    const fontPart = difficulty.substring(0, slashIndex);
    if (fontPart.endsWith('+') && V_GRADES_WITH_MULTIPLE_FONT_GRADES.has(vGrade)) {
      return `${vGrade}+`;
    }
  }
  return vGrade;
}

/**
 * Format a difficulty string to a Font grade display label (uppercased).
 */
export function formatFontGrade(difficulty: string | null | undefined): string | null {
  return extractFontGrade(difficulty);
}

export type GradeDisplayFormat = 'v-grade' | 'font';
export const DEFAULT_GRADE_DISPLAY_FORMAT: GradeDisplayFormat = 'v-grade';

/**
 * Format a difficulty string according to the user's preference.
 * `'v-grade'` → V-style label (`"V5"`, `"V5+"`). `'font'` → Font label (`"6A"`).
 */
export function formatGrade(difficulty: string | null | undefined, format: GradeDisplayFormat): string | null {
  return format === 'font' ? formatFontGrade(difficulty) : formatVGrade(difficulty);
}

/**
 * Convert a hex color to HSL components.
 * @returns Object with h (0-360), s (0-1), l (0-1)
 */
export function hexToHSL(hex: string): { h: number; s: number; l: number } {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) return { h: 0, s: 0, l };

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;

  return { h: h * 360, s, l };
}

/**
 * Extract hue from a hex color.
 */
function hexToHue(hex: string): number {
  return hexToHSL(hex).h;
}

/**
 * Get a semi-transparent version of a grade color for backgrounds.
 * @param color - Hex color string
 * @param opacity - Opacity value between 0 and 1
 * @returns RGBA color string
 */
export function getGradeColorWithOpacity(color: string | undefined, opacity: number = 0.7): string {
  if (!color) return 'rgba(200, 200, 200, 0.7)';

  // Convert hex to RGB
  const hex = color.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);

  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/**
 * Determine if a color is light or dark (for text contrast).
 * @param hexColor - Hex color string
 * @returns true if the color is light (should use dark text)
 */
export function isLightColor(hexColor: string): boolean {
  const hex = hexColor.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);

  // Calculate relative luminance
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5;
}

/**
 * Get appropriate text color (black or white) for a grade color background.
 * @param gradeColor - Hex color string of the background
 * @returns 'black' or 'white' hex string, or 'inherit' for undefined input
 */
export function getGradeTextColor(gradeColor: string | undefined): string {
  if (!gradeColor) return 'inherit';
  return isLightColor(gradeColor) ? '#000000' : '#FFFFFF';
}

/**
 * Get a subtle HSL tint color derived from a climb's grade color.
 * @param difficulty - Difficulty string like "6a/V3" or "V5"
 * @param variant - 'default' for queue bar (30% sat, 88% light), 'light' for list items (20% sat, 94% light)
 * @param darkMode - When true, uses lower lightness values suitable for dark backgrounds
 * @returns HSL color string or undefined if no grade color found
 */
export function getGradeTintColor(
  difficulty: string | null | undefined,
  variant: 'default' | 'light' | 'session' = 'default',
  darkMode?: boolean,
): string | undefined {
  const color = getGradeColor(difficulty);
  if (!color) return undefined;

  const hue = Math.round(hexToHue(color));

  if (darkMode) {
    if (variant === 'light') {
      return `hsl(${hue}, 25%, 22%)`;
    }
    if (variant === 'session') {
      return `hsla(${hue}, 40%, 14%, 0.85)`;
    }
    return `hsla(${hue}, 35%, 28%, 0.6)`;
  }

  if (variant === 'light') {
    return `hsl(${hue}, 20%, 94%)`;
  }
  if (variant === 'session') {
    return `hsl(${hue}, 35%, 82%)`;
  }
  return `hsl(${hue}, 30%, 88%)`;
}

/**
 * Soften a hex color into a readable HSL value for use as text/foreground color.
 * Preserves hue, picks a lightness band that contrasts with the surface.
 */
export function softenColor(hex: string, darkMode?: boolean): string {
  const { h } = hexToHSL(hex);
  if (darkMode) {
    return `hsl(${Math.round(h)}, 80%, 77%)`;
  }
  return `hsl(${Math.round(h)}, 72%, 44%)`;
}

/**
 * Softened color for a V-grade label (e.g. "V3").
 */
export function getSoftVGradeColor(vGrade: string | null | undefined, darkMode?: boolean): string | undefined {
  const color = getVGradeColor(vGrade);
  if (!color) return undefined;
  return softenColor(color, darkMode);
}

/**
 * Softened color for a Font-grade label (e.g. "6a", "7b+").
 */
export function getSoftFontGradeColor(fontGrade: string | null | undefined, darkMode?: boolean): string | undefined {
  const color = getFontGradeColor(fontGrade);
  if (!color) return undefined;
  return softenColor(color, darkMode);
}

/**
 * Softened color for a full difficulty string (e.g. "6a/V3", "V5"). Uses the
 * embedded V-grade when present.
 */
export function getSoftGradeColor(difficulty: string | null | undefined, darkMode?: boolean): string | undefined {
  const color = getGradeColor(difficulty);
  if (!color) return undefined;
  return softenColor(color, darkMode);
}

/**
 * Softened color for the user's selected display format. `'font'` reads the
 * Font part of the difficulty; `'v-grade'` (default) reads the V part.
 */
export function getSoftGradeColorByFormat(
  difficulty: string | null | undefined,
  format: GradeDisplayFormat,
  darkMode?: boolean,
): string | undefined {
  if (format === 'font') {
    // extractFontGrade returns uppercase (e.g. "7A+"); getFontGradeColor
    // normalizes via .toLowerCase() before the lookup, so no caller-side
    // case conversion is needed.
    return getSoftFontGradeColor(extractFontGrade(difficulty), darkMode);
  }
  return getSoftVGradeColor(extractVGrade(difficulty), darkMode);
}
