import React from 'react';
import Box from '@mui/material/Box';
import { DEFAULT_GRADE_COLOR, formatFontGrade, formatVGrade, getGradeColor } from '@/app/lib/grade-colors';
import { themeTokens } from '@/app/theme/theme-config';

type GradeTileProps = {
  /** The climb's difficulty string as stored, e.g. `"6a/V3"` or `"V5"`. */
  difficulty: string | null | undefined;
  /** Picks the board's V-grade "+" rule; see `formatVGrade`. */
  boardName: string;
};

// The tile grows with its grade rather than clipping it: `minWidth`, not
// `width`, and no overflow rule, so "V14" or "V10+" widens the tile instead of
// losing a digit (the "A V-grade is never cut" rule in the design guidelines).
const tileSx = {
  flex: 'none',
  display: 'inline-flex',
  flexDirection: 'column' as const,
  alignItems: 'center',
  justifyContent: 'center',
  boxSizing: 'border-box' as const,
  minWidth: { xs: 64, md: 84 },
  height: { xs: 64, md: 84 },
  paddingInline: { xs: `${themeTokens.spacing[2]}px`, md: `${themeTokens.spacing[3]}px` },
  borderRadius: { xs: `${themeTokens.borderRadius.lg}px`, md: `${themeTokens.borderRadius.xl}px` },
  whiteSpace: 'nowrap' as const,
};

const vGradeSx = {
  fontSize: { xs: themeTokens.typography.fontSize['3xl'], md: 40 },
  fontWeight: themeTokens.typography.fontWeight.bold,
  lineHeight: 1,
  letterSpacing: '-0.03em',
};

// Full ink, no opacity: the Font grade is small text on a saturated fill, and
// fading it took V5-V7 under 3.5:1.
const fontGradeSx = {
  marginTop: `${themeTokens.spacing[1]}px`,
  fontSize: { xs: themeTokens.typography.fontSize.xs, md: themeTokens.typography.fontSize.sm },
  fontWeight: themeTokens.typography.fontWeight.semibold,
  lineHeight: 1,
};

/** The two inks a tile can print in: the brand's dark ink and white. */
const TILE_INKS = [themeTokens.colors.onAccent, themeTokens.colors.onPrimary] as const;

function linearChannel(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2 relative luminance of a `#RRGGBB` colour. */
function relativeLuminance(hexColor: string): number {
  const hex = hexColor.replace('#', '');
  const [red, green, blue] = [0, 2, 4].map((offset) => linearChannel(parseInt(hex.slice(offset, offset + 2), 16)));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** WCAG 2 contrast ratio between two `#RRGGBB` colours, 1 to 21. */
export function contrastRatio(firstColor: string, secondColor: string): number {
  const [lighter, darker] = [relativeLuminance(firstColor), relativeLuminance(secondColor)].sort(
    (first, second) => second - first,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The ink with the higher WCAG contrast on a grade colour.
 *
 * Not the shared `getGradeTextColor`, whose brightness (YIQ) cut-off mobile
 * also uses: on V5's red it picks white at 3.84:1. Measured contrast picks the
 * brand's dark ink there (4.82:1), and every V-grade colour gets an ink at
 * 4.5:1 or better.
 */
export function gradeTileInk(gradeColor: string): string {
  return TILE_INKS.reduce((bestInk, ink) =>
    contrastRatio(ink, gradeColor) > contrastRatio(bestInk, gradeColor) ? ink : bestInk,
  );
}

/**
 * The grade as a coloured tile beside the climb name, in the same grade
 * colours the app uses: V-grade large, Font grade under it.
 *
 * `aria-hidden` because the `<h1>` already says the grade in words (a visually
 * hidden ", V5 (6c)"), so a screen reader hears it once. Renders nothing for a
 * climb with no V-grade — a draft, or a grade string the scale doesn't know —
 * rather than an empty grey square.
 */
export default function GradeTile({ difficulty, boardName }: GradeTileProps) {
  const vGrade = formatVGrade(difficulty, boardName);
  if (!vGrade) return null;

  const fontGrade = formatFontGrade(difficulty);
  const gradeColor = getGradeColor(difficulty) ?? DEFAULT_GRADE_COLOR;

  return (
    <Box component="span" aria-hidden sx={{ ...tileSx, bgcolor: gradeColor, color: gradeTileInk(gradeColor) }}>
      <Box component="span" sx={vGradeSx}>
        {vGrade}
      </Box>
      {fontGrade ? (
        <Box component="span" sx={fontGradeSx}>
          {fontGrade}
        </Box>
      ) : null}
    </Box>
  );
}
