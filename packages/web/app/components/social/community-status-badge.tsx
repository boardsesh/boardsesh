'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import StarIcon from '@mui/icons-material/Star';
import LockIcon from '@mui/icons-material/Lock';
import EmojiEventsIcon from '@mui/icons-material/EmojiEvents';
import { themeTokens } from '@/app/theme/theme-config';

type CommunityStatusBadgeProps = {
  communityGrade?: string | null;
  isClassic?: boolean;
  isBenchmark?: boolean;
  isFrozen?: boolean;
  compact?: boolean;
};

export default function CommunityStatusBadge({
  communityGrade,
  isClassic,
  isBenchmark,
  isFrozen,
  compact,
}: CommunityStatusBadgeProps) {
  const badges: React.ReactNode[] = [];

  if (communityGrade) {
    badges.push(
      <Chip
        key="grade"
        label={communityGrade}
        size="small"
        sx={{
          bgcolor: 'var(--semantic-selected)',
          color: 'var(--color-primary)',
          fontWeight: 600,
          fontSize: compact ? 10 : 11,
          height: compact ? 20 : 24,
        }}
      />,
    );
  }

  if (isClassic) {
    badges.push(
      <Chip
        key="classic"
        icon={<StarIcon sx={{ fontSize: compact ? 12 : 14 }} />}
        label={compact ? undefined : 'Classic'}
        size="small"
        sx={{
          bgcolor: `${themeTokens.colors.amber}22`,
          color: 'var(--color-warning)',
          fontWeight: 600,
          fontSize: compact ? 10 : 11,
          height: compact ? 20 : 24,
          '& .MuiChip-icon': { color: themeTokens.colors.amber },
          ...(compact && { '& .MuiChip-label': { display: 'none' } }),
        }}
      />,
    );
  }

  if (isBenchmark) {
    badges.push(
      <Chip
        key="benchmark"
        icon={<EmojiEventsIcon sx={{ fontSize: compact ? 12 : 14 }} />}
        label={compact ? undefined : 'Benchmark'}
        size="small"
        sx={{
          bgcolor: `${themeTokens.colors.purple}14`,
          color: themeTokens.colors.purple,
          fontWeight: 600,
          fontSize: compact ? 10 : 11,
          height: compact ? 20 : 24,
          '& .MuiChip-icon': { color: themeTokens.colors.purple },
          ...(compact && { '& .MuiChip-label': { display: 'none' } }),
        }}
      />,
    );
  }

  if (isFrozen) {
    badges.push(
      <Chip
        key="frozen"
        icon={<LockIcon sx={{ fontSize: compact ? 12 : 14 }} />}
        label={compact ? undefined : 'Frozen'}
        size="small"
        sx={{
          bgcolor: 'var(--color-warning-bg)',
          color: 'var(--color-warning)',
          fontWeight: 600,
          fontSize: compact ? 10 : 11,
          height: compact ? 20 : 24,
          '& .MuiChip-icon': { color: 'var(--color-warning)' },
          ...(compact && { '& .MuiChip-label': { display: 'none' } }),
        }}
      />,
    );
  }

  if (badges.length === 0) return null;

  return <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', alignItems: 'center' }}>{badges}</Box>;
}
