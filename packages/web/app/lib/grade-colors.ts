import {
  V_GRADE_COLORS,
  FONT_GRADE_COLORS,
  DEFAULT_GRADE_COLOR,
  getVGradeColor,
  getFontGradeColor,
  getGradeColor,
} from '@boardsesh/board-constants/grade-colors';
import { BOULDER_GRADES } from './board-data';

// Re-export grade color data and core lookups from the canonical source
export { V_GRADE_COLORS, FONT_GRADE_COLORS, DEFAULT_GRADE_COLOR, getVGradeColor, getFontGradeColor, getGradeColor };

/**
 * Extract V-grade from a difficulty string (e.g., "6a/V3" -> "V3")
 * Internal helper - not exported.
 * @param difficulty - Difficulty string that may contain V-grade
 * @returns Uppercase V-grade string (e.g., "V3") or null if not found
 */
function extractVGrade(difficulty: string | null | undefined): string | null {
  if (!difficulty) return null;
  const vGradeMatch = difficulty.match(/V\d+/i);
  return vGradeMatch ? vGradeMatch[0].toUpperCase() : null;
}

// Build set of V-grades that have more than one Font grade mapping.
// Only these V-grades should show "+" to disambiguate (e.g., V3 vs V3+).
// V-grades with a single Font grade (e.g., V7 from 7a+) don't need "+".
const V_GRADES_WITH_MULTIPLE_FONT_GRADES: Set<string> = (() => {
  const countByVGrade = new Map<string, number>();
  for (const g of BOULDER_GRADES) {
    countByVGrade.set(g.v_grade, (countByVGrade.get(g.v_grade) ?? 0) + 1);
  }
  const result = new Set<string>();
  for (const [vGrade, count] of countByVGrade) {
    if (count > 1) result.add(vGrade);
  }
  return result;
})();

/**
 * Format a difficulty string to a V-grade display label.
 * When the Font grade has a "+" suffix AND the V-grade has multiple Font grade
 * mappings (e.g., "6c+/V5" where V5 maps from both 6c and 6c+), the result
 * includes "+" for disambiguation (e.g., "V5+").
 * When a V-grade has only one Font grade (e.g., V7 from 7a+), no "+" is added.
 * @param difficulty - Difficulty string (e.g., "6c+/V5", "7a+/V7", "V3")
 * @returns Formatted V-grade string (e.g., "V5+", "V7", "V3") or null if not found
 */
export function formatVGrade(difficulty: string | null | undefined): string | null {
  if (!difficulty) return null;
  const vGrade = extractVGrade(difficulty);
  if (!vGrade) return null;

  // Only add "+" when the Font grade has "+" AND the V-grade has multiple Font grades
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
 * Extract Font grade from a difficulty string (e.g., "6a/V3" -> "6A")
 * @param difficulty - Difficulty string that may contain Font grade
 * @returns Uppercase Font grade string for display (e.g., "6A", "7B+") or null if not found
 */
function extractFontGrade(difficulty: string | null | undefined): string | null {
  if (!difficulty) return null;
  // Try to extract from "6a/V3" format first
  const slashIndex = difficulty.indexOf('/');
  if (slashIndex > 0) {
    return difficulty.substring(0, slashIndex).toUpperCase();
  }
  // Fall back to regex match for standalone Font grade
  const fontGradeMatch = difficulty.match(/\d[abc]\+?/i);
  return fontGradeMatch ? fontGradeMatch[0].toUpperCase() : null;
}

/**
 * Format a difficulty string to a Font grade display label.
 * @param difficulty - Difficulty string (e.g., "6a/V3", "7b+/V8")
 * @returns Font grade string (e.g., "6a", "7b+") or null if not found
 */
export function formatFontGrade(difficulty: string | null | undefined): string | null {
  return extractFontGrade(difficulty);
}

export type GradeDisplayFormat = 'v-grade' | 'font';

/**
 * Format a difficulty string based on the specified format preference.
 * @param difficulty - Difficulty string (e.g., "6a/V3")
 * @param format - Display format: 'v-grade' or 'font'
 * @returns Formatted grade string based on the format, or null if not found
 */
export function formatGrade(difficulty: string | null | undefined, format: GradeDisplayFormat): string | null {
  if (format === 'font') {
    return formatFontGrade(difficulty);
  }
  return formatVGrade(difficulty);
}

/**
 * Get a softened grade color based on the display format.
 * @param difficulty - Difficulty string (e.g., "6a/V3")
 * @param format - Display format: 'v-grade' or 'font'
 * @param darkMode - Whether dark mode is active
 * @returns Softened color string suitable for text display
 */
export function getSoftGradeColorByFormat(
  difficulty: string | null | undefined,
  format: GradeDisplayFormat,
  darkMode?: boolean,
): string | undefined {
  if (format === 'font') {
    const fontGrade = extractFontGrade(difficulty);
    return getSoftFontGradeColor(fontGrade, darkMode);
  }
  const vGrade = extractVGrade(difficulty);
  return getSoftVGradeColor(vGrade, darkMode);
}

/**
 * Get a semi-transparent version of a grade color for backgrounds
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
 * Determine if a color is light or dark (for text contrast)
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
 * Get appropriate text color (black or white) for a grade color background
 * @param gradeColor - Hex color string of the background
 * @returns 'black' or 'white'
 */
export function getGradeTextColor(gradeColor: string | undefined): string {
  if (!gradeColor) return 'inherit';
  return isLightColor(gradeColor) ? '#000000' : '#FFFFFF';
}

/**
 * Convert a hex color to HSL components.
 * @returns Object with h (0-360), s (0-1), l (0-1)
 */
function hexToHSL(hex: string): { h: number; s: number; l: number } {
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
 * Create a softened version of a hex color for use as text color.
 * Preserves the hue with high saturation to stay close to the original color
 * while using controlled lightness for readability on bold/large text.
 * In dark mode, uses higher lightness for readability on dark backgrounds.
 */
function softenColor(hex: string, darkMode?: boolean): string {
  const { h } = hexToHSL(hex);
  if (darkMode) {
    return `hsl(${Math.round(h)}, 80%, 72%)`;
  }
  return `hsl(${Math.round(h)}, 72%, 44%)`;
}

/**
 * Get a softened color for a V-grade string (e.g., "V3", "V10").
 * Returns a muted version of the grade color suitable for large/bold text in list views.
 */
export function getSoftVGradeColor(vGrade: string | null | undefined, darkMode?: boolean): string | undefined {
  const color = getVGradeColor(vGrade);
  if (!color) return undefined;
  return softenColor(color, darkMode);
}

/**
 * Get a softened color for a Font grade string (e.g., "6a", "7b+").
 * Returns a muted version of the grade color suitable for large/bold text in list views.
 */
export function getSoftFontGradeColor(fontGrade: string | null | undefined, darkMode?: boolean): string | undefined {
  const color = getFontGradeColor(fontGrade);
  if (!color) return undefined;
  return softenColor(color, darkMode);
}

/**
 * Get a softened color for a difficulty string (e.g., "6a/V3", "V5").
 * Returns a muted version of the grade color suitable for large/bold text in list views.
 */
export function getSoftGradeColor(difficulty: string | null | undefined, darkMode?: boolean): string | undefined {
  const color = getGradeColor(difficulty);
  if (!color) return undefined;
  return softenColor(color, darkMode);
}

function hexToHue(hex: string): number {
  return hexToHSL(hex).h;
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

export function getActiveClimbTint(
  difficulty: string | null | undefined,
  darkMode: boolean,
  fallback: 'selected' | 'selected-light' = 'selected',
): string {
  const fallbackVar =
    fallback === 'selected-light' ? 'var(--semantic-selected-light)' : 'var(--semantic-selected)';
  return getGradeTintColor(difficulty, 'light', darkMode) ?? fallbackVar;
}
