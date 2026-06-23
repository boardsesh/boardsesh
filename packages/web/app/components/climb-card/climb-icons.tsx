'use client';

import React from 'react';
import Typography from '@mui/material/Typography';
import CopyrightOutlined from '@mui/icons-material/CopyrightOutlined';
import DoNotTouchOutlined from '@mui/icons-material/DoNotTouchOutlined';
import { themeTokens } from '@/app/theme/theme-config';

type ClimbIconsProps = {
  benchmarkDifficulty?: string | number | null;
  isBenchmark?: boolean;
  isNoMatch?: boolean;
  /** Already-translated MoonBoard method label (e.g. "Footless"). Parent resolves via i18n. */
  methodLabel?: string | null;
};

const benchmarkIconSx = {
  marginLeft: '4px',
  fontSize: themeTokens.typography.fontSize.xs,
  color: themeTokens.colors.primary,
} as const;

const noMatchIconSx = {
  marginLeft: '4px',
  fontSize: themeTokens.typography.fontSize.xs,
  color: 'text.secondary',
} as const;

const methodLabelSx = {
  marginLeft: '6px',
  fontSize: themeTokens.typography.fontSize.xs,
  color: 'text.secondary',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.03em',
} as const;

/**
 * Unified icon cluster for climb labels.
 * Note: benchmark_difficulty > 0 represents benchmark/classic climbs in current data feeds.
 */
export default function ClimbIcons({
  benchmarkDifficulty,
  isBenchmark = false,
  isNoMatch = false,
  methodLabel = null,
}: ClimbIconsProps) {
  const benchmarkValue = benchmarkDifficulty != null ? Number(benchmarkDifficulty) : null;
  const isBenchmarkOrClassic =
    isBenchmark || (benchmarkValue !== null && benchmarkValue > 0 && !Number.isNaN(benchmarkValue));

  return (
    <>
      {isBenchmarkOrClassic && <CopyrightOutlined sx={benchmarkIconSx} />}
      {isNoMatch && <DoNotTouchOutlined sx={noMatchIconSx} />}
      {methodLabel && (
        <Typography component="span" sx={methodLabelSx}>
          {methodLabel}
        </Typography>
      )}
    </>
  );
}
