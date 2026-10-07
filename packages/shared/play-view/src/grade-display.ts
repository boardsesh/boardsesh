import { getGradeColor, getVGradeColor, getFontGradeColor } from '@boardsesh/board-constants/grade-colors';
// Import via the narrow `/boulder-grade-mapping` deep-path so we don't pull
// the whole @boardsesh/board-config module graph (board image dimensions,
// set IDs, moonboard config) into anything that touches the grade helpers.
import { getBoulderGradesForBoard, type BoulderGrade } from '@boardsesh/board-constants/boulder-grade-mapping';

// Re-export for convenience
export { getGradeColor };

type GradeScale = {
  /**
   * V-grades that map from multiple Font grades on this board. Only these need
   * "+" disambiguation when the source difficulty's Font part ends with "+".
   */
  vGradesWithMultipleFontGrades: ReadonlySet<string>;
  gradeByDifficultyId: ReadonlyMap<number, BoulderGrade>;
};

// Keyed by the grade table itself, so every board sharing the default table
// shares one entry and the cache can hold at most one per distinct table.
const GRADE_SCALE_BY_TABLE = new Map<readonly BoulderGrade[], GradeScale>();

function getGradeScale(boardName: string | null | undefined): GradeScale {
  const grades = getBoulderGradesForBoard(boardName);
  const cached = GRADE_SCALE_BY_TABLE.get(grades);
  if (cached) return cached;
  const countByVGrade = new Map<string, number>();
  for (const grade of grades) {
    countByVGrade.set(grade.v_grade, (countByVGrade.get(grade.v_grade) ?? 0) + 1);
  }
  const vGradesWithMultipleFontGrades = new Set<string>();
  for (const [vGrade, count] of countByVGrade) {
    if (count > 1) vGradesWithMultipleFontGrades.add(vGrade);
  }
  const scale: GradeScale = {
    vGradesWithMultipleFontGrades,
    gradeByDifficultyId: new Map(grades.map((grade) => [grade.difficulty_id, grade])),
  };
  GRADE_SCALE_BY_TABLE.set(grades, scale);
  return scale;
}

function extractVGrade(difficulty: string | null | undefined): string | null {
  if (!difficulty) return null;
  const vGradeMatch = difficulty.match(/V\d+\+?/i);
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
 * grade mappings on the climb's board (e.g., "6c+/V5" → "V5+" because V5 maps
 * from both 6c and 6c+). V-grades with a single Font mapping (e.g., "7a+/V7")
 * never get a "+". Pass `boardName` so a board with its own conversion gets its
 * own rule: MoonBoard's 6A is V2, so its "6a+/V3" is the only V3 and reads "V3".
 */
export function formatVGrade(difficulty: string | null | undefined, boardName?: string | null): string | null {
  if (!difficulty) return null;
  const vGrade = extractVGrade(difficulty);
  if (!vGrade) return null;
  const slashIndex = difficulty.indexOf('/');
  if (slashIndex > 0) {
    const fontPart = difficulty.substring(0, slashIndex);
    if (fontPart.endsWith('+') && getGradeScale(boardName).vGradesWithMultipleFontGrades.has(vGrade)) {
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

export type GradeDisplayFormat = 'v-grade' | 'font' | 'both';
export const DEFAULT_GRADE_DISPLAY_FORMAT: GradeDisplayFormat = 'v-grade';

/** What `'both'` joins its two grades with (`"V5 / 6C"`). */
const BOTH_FORMAT_SEPARATOR = ' / ';

/**
 * Format a difficulty string according to the user's preference.
 * `'v-grade'` → V-style label (`"V5"`, `"V5+"`). `'font'` → Font label
 * (`"6A"`). `'both'` → V then Font (`"V5+ / 6C+"`). `boardName` picks the
 * board's V-grade "+" rule; see {@link formatVGrade}.
 */
export function formatGrade(
  difficulty: string | null | undefined,
  format: GradeDisplayFormat,
  boardName?: string | null,
): string | null {
  if (format === 'font') return formatFontGrade(difficulty);
  if (format === 'both') {
    const vGrade = formatVGrade(difficulty, boardName);
    const fontGrade = formatFontGrade(difficulty);
    if (vGrade && fontGrade) return `${vGrade}${BOTH_FORMAT_SEPARATOR}${fontGrade}`;
    return vGrade ?? fontGrade;
  }
  return formatVGrade(difficulty, boardName);
}

/**
 * A grade label broken back into the pieces `formatGrade` joined: `"V5 / 6C"`
 * → `["V5", "6C"]`, any single-format label → a one-entry array. Lets a
 * cramped surface (a chart's bar-top label, a narrow badge) stack the two
 * grades on separate lines instead of clipping the joined string, without
 * every caller hardcoding the separator.
 */
export function splitGradeLabel(label: string | null | undefined): string[] {
  if (!label) return [];
  return label.split(BOTH_FORMAT_SEPARATOR);
}

/**
 * Format a numeric Aurora difficulty id according to the user's preference.
 * This keeps mobile feed/logbook rows from depending on whatever preformatted
 * grade label the backend sent alongside the id. `boardName` picks the board's
 * labels (MoonBoard's 6A is V2).
 */
export function formatGradeByDifficultyId(
  difficultyId: number | null | undefined,
  format: GradeDisplayFormat,
  boardName?: string | null,
): string | null {
  if (difficultyId == null) return null;
  const grade = getGradeScale(boardName).gradeByDifficultyId.get(difficultyId);
  if (!grade) return null;
  return formatGrade(grade.difficulty_name, format, boardName);
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

/**
 * Is this a project: a published climb nobody has graded yet (#5971)?
 *
 * On a spray wall a climb publishes with no grade and its first ascent grades
 * it, so "no grade" is a real state a climber sees, not a missing value. It
 * reads the same on every board: a user-set Kilter climb nobody has sent is a
 * project too.
 *
 * Takes the grade label the surface is ABOUT to show (after the Boardsesh grade
 * and your own grade have had their say), so a climb you graded yourself, or one
 * the Boardsesh model has a grade for, never reads as a project. A draft is never
 * one: it carries its own chip.
 */
export function isProjectClimb({
  gradeLabel,
  isDraft,
}: {
  gradeLabel: string | null | undefined;
  isDraft?: boolean | null;
}): boolean {
  if (isDraft === true) return false;
  return (gradeLabel ?? '').trim() === '';
}
