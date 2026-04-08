'use client';

import React from 'react';
import CopyrightOutlined from '@mui/icons-material/CopyrightOutlined';
import DoNotTouchOutlined from '@mui/icons-material/DoNotTouchOutlined';
import { themeTokens } from '@/app/theme/theme-config';

type ClimbIconsProps = {
  benchmarkDifficulty?: string | number | null;
  isNoMatch?: boolean;
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

/**
 * Unified icon cluster for climb labels.
 * Note: benchmark_difficulty > 0 represents benchmark/classic climbs in current data feeds.
 */
export default function ClimbIcons({ benchmarkDifficulty, isNoMatch = false }: ClimbIconsProps) {
  const benchmarkValue = benchmarkDifficulty != null ? Number(benchmarkDifficulty) : null;
  const isBenchmarkOrClassic = benchmarkValue !== null && benchmarkValue > 0 && !Number.isNaN(benchmarkValue);

  return (
    <>
      {isBenchmarkOrClassic && <CopyrightOutlined sx={benchmarkIconSx} />}
      {isNoMatch && <DoNotTouchOutlined sx={noMatchIconSx} />}
    </>
  );
}
