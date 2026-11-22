import React from 'react';
import Box from '@mui/material/Box';
import {
  DEFAULT_GRADE_COLOR,
  formatFontGrade,
  formatVGrade,
  getGradeColor,
  getGradeTextColor,
} from '@/app/lib/grade-colors';
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

const fontGradeSx = {
  marginTop: { xs: `${themeTokens.spacing[1]}px`, md: '6px' },
  fontSize: { xs: themeTokens.typography.fontSize.xs, md: themeTokens.typography.fontSize.sm },
  fontWeight: themeTokens.typography.fontWeight.semibold,
  lineHeight: 1,
  opacity: 0.72,
};

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
    <Box component="span" aria-hidden sx={{ ...tileSx, bgcolor: gradeColor, color: getGradeTextColor(gradeColor) }}>
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
