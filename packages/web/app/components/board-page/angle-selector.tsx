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
import { ANGLES } from '@/app/lib/board-data';
import type { BoardName, BoardDetails, Climb } from '@/app/lib/types';
import type { ClimbStatsForAngle } from '@/app/lib/data/queries';
import { themeTokens } from '@/app/theme/theme-config';
import { useIsDarkMode } from '@/app/hooks/use-is-dark-mode';
import DrawerClimbHeader from '../climb-card/drawer-climb-header';
import { useTranslation } from 'react-i18next';
import { useEffectiveClimbStats } from '@/app/hooks/use-climb-stats-live';
import styles from './angle-selector.module.css';

/**
 * One card in the per-angle stats grid. Reads from the live-stats cache
 * written by the page-level WS subscriber in BoardProvider; no per-row
 * subscription. The drawer's own 5-min REST query supplies the base values.
 */
function AngleCard({
  boardName,
  climbUuid,
  angle,
  stats,
  hasStats,
  currentClimb,
  isLoading,
  isSelected,
  onClick,
  cardRef,
  t,
}: {
  boardName: BoardName;
  climbUuid: string | undefined;
  angle: number;
  stats: ClimbStatsForAngle | undefined;
  hasStats: boolean;
  currentClimb: Climb | null;
  isLoading: boolean;
  isSelected: boolean;
  onClick: () => void;
  cardRef: React.Ref<HTMLDivElement> | null;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const effective = useEffectiveClimbStats(boardName, climbUuid, angle, {
    ascensionist_count: stats?.ascensionist_count == null ? 0 : Number(stats.ascensionist_count),
    quality_average: stats?.quality_average == null ? null : String(stats.quality_average),
    difficulty: stats?.difficulty ?? null,
  });

  return (
    <div ref={cardRef}>
      <MuiCard
        onClick={onClick}
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
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px', alignItems: 'center', marginTop: '4px' }}>
              {effective.difficulty && (
                <Typography variant="body2" component="span" sx={{ fontSize: 12, fontWeight: 500 }}>
                  {effective.difficulty}
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
                {effective.qualityAverage !== null && Number(effective.qualityAverage) > 0 && (
                  <Typography variant="body2" component="span" sx={{ fontSize: 11, color: themeTokens.colors.warning }}>
                    ★{Number(effective.qualityAverage).toFixed(1)}
                  </Typography>
                )}
                <Typography variant="body2" component="span" color="text.secondary" sx={{ fontSize: 10 }}>
                  {t('angleSelector.sends', { count: effective.ascensionistCount })}
                </Typography>
              </Box>
            </Box>
          )}
          {currentClimb && !hasStats && !isLoading && (
            <Typography variant="body2" component="span" color="text.secondary" sx={{ fontSize: 10, marginTop: '4px' }}>
              {t('angleSelector.noData')}
            </Typography>
          )}
        </CardContent>
      </MuiCard>
    </div>
  );
}

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

  // Fetch climb stats for all angles when there's a current climb
  const { data: climbStats, isLoading } = useQuery<ClimbStatsForAngle[]>({
    queryKey: ['climbStats', boardName, currentClimb?.uuid],
    queryFn: () => fetch(`/api/v1/${boardName}/climb-stats/${currentClimb!.uuid}`).then((res) => res.json()),
    enabled: !!currentClimb && isDrawerOpen,
    staleTime: 5 * 60 * 1000,
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
      // Replace the current angle in the URL with the new one
      const pathSegments = pathname.split('/');
      const angleIndex = pathSegments.findIndex((segment) => segment === currentAngle.toString());

      if (angleIndex !== -1) {
        pathSegments[angleIndex] = newAngle.toString();
        let newPath = pathSegments.join('/');
        // Read live query string from window.location — QueueContext mirrors
        // filter state via history.replaceState, which Next.js's
        // useSearchParams() does not observe, so it would otherwise be stale.
        const queryString = window.location.search.slice(1);
        if (queryString) {
          newPath = `${newPath}?${queryString}`;
        }
        router.push(newPath);
      }
    }

    setIsDrawerOpen(false);
  };

  const renderAngleCard = (angle: number) => {
    const stats = statsMap.get(angle);
    const isSelected = angle === currentAngle;
    const hasStats = Boolean(currentClimb && stats);

    return (
      <AngleCard
        key={angle}
        boardName={boardName}
        climbUuid={currentClimb?.uuid}
        angle={angle}
        stats={stats}
        hasStats={hasStats}
        currentClimb={currentClimb}
        isLoading={isLoading}
        isSelected={isSelected}
        onClick={() => handleAngleChange(angle)}
        cardRef={isSelected ? currentAngleRef : null}
        t={t}
      />
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
