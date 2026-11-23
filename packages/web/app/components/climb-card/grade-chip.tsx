import React from 'react';
import Box from '@mui/material/Box';
import { getGradeColor, getReadableGradeInk } from '@/app/lib/grade-colors';
import { themeTokens } from '@/app/theme/theme-config';

type GradeChipProps = {
  /** The grade as the reader sees it: `"V5"`, `"V5+"`, `"6C"` or `"V5 / 6C"`. */
  label: string;
};

const chipSx = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  minWidth: 40,
  height: 26,
  paddingInline: `${themeTokens.spacing[2]}px`,
  borderRadius: `${themeTokens.borderRadius.md}px`,
  // The system face, not the display one: Geist's bold zero reads as the
  // letter O, so "V0" would read "VO".
  fontFamily: themeTokens.typography.fontFamily,
  fontSize: themeTokens.typography.fontSize.sm,
  fontWeight: themeTokens.typography.fontWeight.bold,
  lineHeight: 1,
  fontVariantNumeric: 'tabular-nums',
  // A V-grade is never cut: the chip keeps its whole label and the row around
  // it gives way instead.
  whiteSpace: 'nowrap',
} as const;

/** No colour for this grade: a quiet chip rather than a guessed one. */
const unknownGradeSx = {
  backgroundColor: 'var(--semantic-surface-elevated)',
  color: 'var(--neutral-900)',
} as const;

/**
 * A grade on its grade colour, the way the app draws it.
 *
 * Plain markup with no hooks, so a server component (the setter page's art
 * cards) and a client one (`ClimbTitle`) can both draw it. The colour comes from
 * the label itself, so a V label gets its V colour and a Font label its Font
 * colour without the caller saying which format it formatted to.
 */
export default function GradeChip({ label }: GradeChipProps) {
  const background = getGradeColor(label);
  const colourSx = background
    ? { backgroundColor: background, color: getReadableGradeInk(background) }
    : unknownGradeSx;

  return (
    <Box component="span" sx={{ ...chipSx, ...colourSx }}>
      {label}
    </Box>
  );
}
