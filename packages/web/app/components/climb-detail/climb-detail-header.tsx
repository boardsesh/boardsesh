'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Skeleton from '@mui/material/Skeleton';
import ClimbIcons from '@/app/components/climb-card/climb-icons';
import MarqueeText from '@/app/components/climb-card/marquee-text';
import { themeTokens } from '@/app/theme/theme-config';
import { useGradeFormat } from '@/app/hooks/use-grade-format';
import { formatSends } from '@/app/lib/format-climb-stats';
import { useIsDarkMode } from '@/app/hooks/use-is-dark-mode';
import { useEffectiveClimbStats } from '@/app/hooks/use-climb-stats-live';
import { useSubscribeClimbStatsUpdates } from '@/app/hooks/use-subscribe-climb-stats-updates';
import { asBoardName } from '@/app/lib/board-name';
import type { Climb } from '@/app/lib/types';

type ClimbDetailHeaderProps = {
  climb: Climb;
  /** Community-voted grade override, fetched separately from climb_community_status table */
  communityGrade?: string | null;
  /** Board name. Falls back to climb.boardType when not provided. Required for live stat subscription. */
  boardName?: string;
};

/**
 * Header component for climb detail view.
 * Layout: Grade (left) | Name + details (center) | Spacer (right, balances grade)
 */
export default function ClimbDetailHeader({ climb, communityGrade, boardName }: ClimbDetailHeaderProps) {
  const { t } = useTranslation('climbs');
  const isDark = useIsDarkMode();
  const { formatGrade, getGradeColor, loaded: gradeFormatLoaded } = useGradeFormat();

  const subscriptionBoard = asBoardName(boardName ?? climb.boardType);
  useSubscribeClimbStatsUpdates(subscriptionBoard, climb.uuid, climb.angle);
  const effectiveStats = useEffectiveClimbStats(subscriptionBoard, climb.uuid, climb.angle, {
    ascensionist_count: climb.ascensionist_count,
    quality_average: climb.quality_average,
  });

  // Use community grade when available, otherwise fall back to original difficulty
  const displayDifficulty = communityGrade || climb.difficulty;
  const formattedGrade = formatGrade(displayDifficulty);
  const gradeColor = formattedGrade ? getGradeColor(displayDifficulty, isDark) : undefined;

  const hasQuality = effectiveStats.qualityAverage && effectiveStats.qualityAverage !== '0';

  const renderGradeContent = () => {
    if (!gradeFormatLoaded && displayDifficulty) {
      return <Skeleton variant="rounded" width={48} height={themeTokens.typography.fontSize['2xl']} />;
    }
    if (formattedGrade) {
      return (
        <Typography
          variant="h5"
          component="span"
          sx={{
            fontSize: themeTokens.typography.fontSize['2xl'],
            fontWeight: themeTokens.typography.fontWeight.bold,
            lineHeight: 1,
            color: gradeColor ?? 'text.primary',
          }}
        >
          {formattedGrade}
        </Typography>
      );
    }
    if (displayDifficulty) {
      return (
        <Typography
          variant="h5"
          component="span"
          sx={{
            fontSize: themeTokens.typography.fontSize.xl,
            fontWeight: themeTokens.typography.fontWeight.semibold,
            lineHeight: 1,
            color: 'text.secondary',
          }}
        >
          {displayDifficulty}
        </Typography>
      );
    }
    return (
      <Typography variant="body2" component="span" sx={{ fontStyle: 'italic', color: 'text.secondary' }}>
        {t('card.detailHeader.project')}
      </Typography>
    );
  };

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        padding: `${themeTokens.spacing[3]}px ${themeTokens.spacing[4]}px`,
        gap: `${themeTokens.spacing[3]}px`,
        minHeight: 56,
      }}
    >
      {/* Left: Grade */}
      <Box sx={{ flexShrink: 0, minWidth: 48 }}>{renderGradeContent()}</Box>

      {/* Center: Name + details */}
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '2px',
        }}
      >
        {/* Name row */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '4px', maxWidth: '100%', minWidth: 0 }}>
          <MarqueeText active>
            <Typography
              variant="body1"
              component="span"
              sx={{
                fontSize: themeTokens.typography.fontSize.lg,
                fontWeight: themeTokens.typography.fontWeight.bold,
              }}
            >
              {climb.name}
              <ClimbIcons benchmarkDifficulty={climb.benchmark_difficulty} isNoMatch={!!climb.is_no_match} />
            </Typography>
          </MarqueeText>
        </Box>

        {/* Details row: quality + setter */}
        <Typography
          variant="body2"
          component="span"
          color="text.secondary"
          sx={{
            fontSize: themeTokens.typography.fontSize.xs,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {[
            hasQuality ? `${effectiveStats.qualityAverage}★` : null,
            effectiveStats.ascensionistCount ? formatSends(effectiveStats.ascensionistCount) : null,
            climb.setter_username,
          ]
            .filter(Boolean)
            .join(' · ') || 'Unknown setter'}
        </Typography>
      </Box>

      {/* Right: Spacer to balance the grade column so the centered name is truly centered */}
      <Box sx={{ flexShrink: 0, minWidth: 48 }} />
    </Box>
  );
}
