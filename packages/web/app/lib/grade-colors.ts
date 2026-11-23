// Grade color data, lookups, and display utilities are owned by shared
// packages. This file is a thin re-export layer for back-compat with web
// call sites that import from '@/app/lib/grade-colors'.
//
// Format helpers (`formatGrade`, `formatVGrade`, `formatFontGrade`), softening
// helpers (`softenColor`, `getSoft*`) and the `GradeDisplayFormat` type now
// live in `@boardsesh/play-view` so mobile can reuse them.

export {
  V_GRADE_COLORS,
  FONT_GRADE_COLORS,
  DEFAULT_GRADE_COLOR,
  getVGradeColor,
  getFontGradeColor,
  getGradeColor,
} from '@boardsesh/board-constants/grade-colors';

export {
  getGradeTintColor,
  getGradeColorWithOpacity,
  isLightColor,
  getGradeTextColor,
  formatGrade,
  formatVGrade,
  formatFontGrade,
  softenColor,
  getSoftGradeColor,
  getSoftVGradeColor,
  getSoftFontGradeColor,
  getSoftGradeColorByFormat,
  DEFAULT_GRADE_DISPLAY_FORMAT,
} from '@boardsesh/play-view';
export type { GradeDisplayFormat } from '@boardsesh/play-view';

const DARK_INK = '#000000';
const LIGHT_INK = '#FFFFFF';

/** WCAG 2 relative luminance of a `#RRGGBB` colour. */
function relativeLuminance(hexColor: string): number {
  const hex = hexColor.replace('#', '');
  const [red, green, blue] = [0, 2, 4].map((offset) => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** WCAG 2 contrast ratio between two `#RRGGBB` colours, 1 to 21. */
export function contrastRatio(firstColor: string, secondColor: string): number {
  const first = relativeLuminance(firstColor);
  const second = relativeLuminance(secondColor);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/**
 * Black or white ink for text on a grade colour: whichever has the higher WCAG
 * contrast. One of the two always clears 4.5:1, whatever the colour.
 *
 * Not `getGradeTextColor`. That helper (shared with mobile, so left as it is)
 * splits on a YIQ brightness of 0.5, which puts white on V5's #F03E3E at
 * 3.84:1, and on the 6c and 6c+ Font colours too.
 */
export function getReadableGradeInk(gradeColor: string): string {
  return contrastRatio(DARK_INK, gradeColor) >= contrastRatio(LIGHT_INK, gradeColor) ? DARK_INK : LIGHT_INK;
}
