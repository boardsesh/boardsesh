'use client';

import React, { useState, useRef, useEffect } from 'react';
import MuiButton from '@mui/material/Button';
import MuiCard from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import { usePathname } from 'next/navigation';
import { track } from '@/app/lib/analytics';
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';
import { useQuery } from '@tanstack/react-query';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  CLIMB_STATS_FOR_ANGLES,
  type ClimbStatsForAnglesResponse,
} from '@boardsesh/graphql/operations/climb-stats-for-angles';
import { ANGLES } from '@/app/lib/board-data';
import type { BoardName, BoardDetails, Climb } from '@/app/lib/types';
import type { ClimbStatsForAngle } from '@/app/lib/data/queries';
import { themeTokens } from '@/app/theme/theme-config';
import { useIsDarkMode } from '@/app/hooks/use-is-dark-mode';
import DrawerClimbHeader from '../climb-card/drawer-climb-header';
import { useTranslation } from 'react-i18next';
import { usePersistentSession } from '../persistent-session';
import { replaceAngleInPathname } from '@/app/lib/url-utils';
import styles from './angle-selector.module.css';

type AngleSelectorProps = {
  boardName: BoardName;
  boardDetails: BoardDetails;
  currentAngle: number;
  currentClimb: Climb | null;
  isAngleAdjustable?: boolean;
  onAngleChange?: (angle: number) => void;
};

export default function AngleSelector({
  boardName,
  boardDetails,
  currentAngle,
  currentClimb,
  isAngleAdjustable = true,
  onAngleChange: onAngleChangeProp,
}: AngleSelectorProps) {
  const { t } = useTranslation('climbs');
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const router = useLocaleRouter();
  const pathname = usePathname();
  const currentAngleRef = useRef<HTMLDivElement>(null);
  const isDark = useIsDarkMode();
  const { activeSession, setSessionBoardPath } = usePersistentSession();

  // Fetch climb stats for all angles when there's a current climb.
  // Runs through the GraphQL backend (graphql-request HTTP) rather than a
  // Next.js API route, so it doesn't burn a serverless invocation per open.
  const { data: climbStats, isLoading } = useQuery<ClimbStatsForAngle[]>({
    queryKey: ['climbStats', boardName, currentClimb?.uuid],
    queryFn: async () => {
      const client = createGraphQLHttpClient();
      const { climbStatsForAngles } = await client.request<
        ClimbStatsForAnglesResponse,
        { boardName: BoardName; climbUuid: string }
      >(CLIMB_STATS_FOR_ANGLES, { boardName, climbUuid: currentClimb!.uuid });
      // Map camelCase GraphQL fields to the snake_case shape the cards render.
      return climbStatsForAngles.map((stat) => ({
        angle: stat.angle,
        ascensionist_count: String(stat.ascensionistCount ?? 0),
        quality_average: stat.qualityAverage == null ? null : String(stat.qualityAverage),
        difficulty_average: stat.difficultyAverage,
        display_difficulty: stat.displayDifficulty,
        difficulty: stat.difficulty,
        fa_username: stat.faUsername,
        fa_at: stat.faAt,
      }));
    },
    enabled: !!currentClimb && isDrawerOpen,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // Create a map for easy lookup of stats by angle
  const statsMap = React.useMemo(() => {
    if (!climbStats) return new Map();
    return new Map(climbStats.map((stat) => [stat.angle, stat]));
  }, [climbStats]);

  // Scroll to current angle when drawer opens
  useEffect(() => {
    if (isDrawerOpen && currentAngleRef.current) {
      // Small delay to ensure drawer is fully rendered
      const timeoutId = setTimeout(() => {
        currentAngleRef.current?.scrollIntoView({
          behavior: 'instant',
          block: 'center',
        });
      }, 50);
      return () => clearTimeout(timeoutId);
    }
  }, [isDrawerOpen]);

  const handleAngleChange = (newAngle: number) => {
    if (!isAngleAdjustable) return;

    track('Angle Changed', {
      angle: newAngle,
    });

    if (onAngleChangeProp) {
      onAngleChangeProp(newAngle);
    } else {
      // Replace the angle segment by *position*, not by string match.
      // Previous `findIndex(s => s === currentAngle.toString())` would hit
      // the layout id when it happened to equal the angle string (e.g.
      // /kilter/1/10/1/40/list with currentAngle=1 found the layout slot
      // before the angle slot). `replaceAngleInPathname` indexes the path
      // by its known shape and preserves any /es/ or /fr/ locale prefix.
      const newPathWithoutQuery = replaceAngleInPathname(pathname, newAngle);
      if (newPathWithoutQuery !== null) {
        // Read live query string from window.location — QueueContext mirrors
        // filter state via history.replaceState, which Next.js's
        // useSearchParams() does not observe, so it would otherwise be stale.
        const queryString = window.location.search.slice(1);
        const newPath = queryString ? `${newPathWithoutQuery}?${queryString}` : newPathWithoutQuery;
        // Optimistic local URL push for instant feedback.
        router.push(newPath);
        // In party mode, broadcast the boardPath so every member's URL follows
        // (group-session feedback fix — angle is now truly session-shared).
        // No-op in solo: setSessionBoardPath bails when there's no active
        // session. Strip the query string for the broadcast — the boardPath
        // canonically describes the board, not filter state.
        if (activeSession) {
          void setSessionBoardPath(newPathWithoutQuery);
        }
      }
    }

    setIsDrawerOpen(false);
  };

  const renderAngleCard = (angle: number) => {
    const stats = statsMap.get(angle);
    const isSelected = angle === currentAngle;
    const hasStats = currentClimb && stats;

    return (
      <div key={angle} ref={isSelected ? currentAngleRef : null}>
        <MuiCard
          onClick={() => handleAngleChange(angle)}
          sx={{
            cursor: 'pointer',
            '&:hover': { boxShadow: 3 },
            backgroundColor: isSelected ? 'var(--semantic-selected)' : undefined,
            borderColor: isSelected ? themeTokens.colors.primary : undefined,
            borderWidth: isSelected ? 2 : 1,
            borderStyle: 'solid',
          }}
        >
          <CardContent
            sx={{
              p: '12px 8px',
              minHeight: 80,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              '&:last-child': { pb: '12px' },
            }}
          >
            <Typography variant="body2" component="span" fontWeight={600} sx={{ fontSize: 20, lineHeight: 1.2 }}>
              {angle}°
            </Typography>
            {hasStats && (
              <Box
                sx={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '2px',
                  alignItems: 'center',
                  marginTop: '4px',
                }}
              >
                {stats.difficulty && (
                  <Typography variant="body2" component="span" sx={{ fontSize: 12, fontWeight: 500 }}>
                    {stats.difficulty}
                  </Typography>
                )}
                <Box
                  sx={{
                    display: 'flex',
                    gap: '4px',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexWrap: 'wrap',
                  }}
                >
                  {stats.quality_average !== null && Number(stats.quality_average) > 0 && (
                    <Typography
                      variant="body2"
                      component="span"
                      sx={{ fontSize: 11, color: themeTokens.colors.warning }}
                    >
                      ★{Number(stats.quality_average).toFixed(1)}
                    </Typography>
                  )}
                  <Typography variant="body2" component="span" color="text.secondary" sx={{ fontSize: 10 }}>
                    {t('angleSelector.sends', { count: Number(stats.ascensionist_count ?? 0) })}
                  </Typography>
                </Box>
              </Box>
            )}
            {currentClimb && !hasStats && !isLoading && (
              <Typography
                variant="body2"
                component="span"
                color="text.secondary"
                sx={{ fontSize: 10, marginTop: '4px' }}
              >
                {t('angleSelector.noData')}
              </Typography>
            )}
          </CardContent>
        </MuiCard>
      </div>
    );
  };

  return (
    <>
      <MuiButton
        variant="text"
        className={styles.anglePill}
        onClick={() => setIsDrawerOpen(true)}
        sx={{
          textTransform: 'none',
          minWidth: '38px',
          padding: '4px 6px',
          color: isDark ? '#ffffff' : 'primary.main',
        }}
      >
        {currentAngle}°
      </MuiButton>

      <SwipeableDrawer
        title={t('angleSelector.selectAngle')}
        placement="right"
        onClose={() => setIsDrawerOpen(false)}
        open={isDrawerOpen}
        styles={{ wrapper: { width: '90%' }, body: { padding: 12 } }}
      >
        {currentClimb && (
          <Box sx={{ mb: 2, pb: 2, borderBottom: 1, borderColor: 'divider' }}>
            <DrawerClimbHeader climb={currentClimb} boardDetails={boardDetails} />
          </Box>
        )}
        {currentClimb && isLoading && (
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, mb: 2 }}>
            <CircularProgress size={20} />
            <Typography variant="body2" component="span" color="text.secondary" sx={{ fontSize: 12 }}>
              {t('angleSelector.loadingStats')}
            </Typography>
          </Box>
        )}
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: {
              xs: 'repeat(3, 1fr)',
              sm: 'repeat(4, 1fr)',
              md: 'repeat(6, 1fr)',
            },
            gap: 1,
          }}
        >
          {ANGLES[boardName].map(renderAngleCard)}
        </Box>
      </SwipeableDrawer>
    </>
  );
}
