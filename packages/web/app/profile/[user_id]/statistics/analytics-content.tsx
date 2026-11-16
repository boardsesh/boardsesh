'use client';

import React, { useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import { useTranslation } from 'react-i18next';
import type {
  GetUserClimbPercentileQueryResponse,
  GetUserProfileStatsQueryResponse,
} from '@boardsesh/graphql/operations/ticks';
import StatsSummary from '../components/stats-summary';
import BoardStatsSection from '../components/board-stats-section';
import { useProfileData } from '../hooks/use-profile-data';
import type { LogbookEntry } from '../utils/profile-constants';
import { StatsFilterBridgeInjector } from '@/app/components/stats-filter-bridge/stats-filter-bridge-context';
import StatsFilterDrawer from '@/app/components/stats-filter-drawer/stats-filter-drawer';
import styles from '../profile-page.module.css';

type AnalyticsContentProps = {
  userId: string;
  initialProfileStats?: GetUserProfileStatsQueryResponse['userProfileStats'] | null;
  initialPercentile?: GetUserClimbPercentileQueryResponse['userClimbPercentile'] | null;
  initialAllBoardsTicks?: Record<string, LogbookEntry[]>;
  initialLogbook?: LogbookEntry[];
  initialIsOwnProfile?: boolean;
};

export default function AnalyticsContent({
  userId,
  initialProfileStats,
  initialPercentile,
  initialAllBoardsTicks,
  initialLogbook,
  initialIsOwnProfile,
}: AnalyticsContentProps) {
  const { t } = useTranslation('profile');
  const {
    isOwnProfile,
    selectedBoard,
    setSelectedBoard,
    filteredLogbook,
    unifiedTimeframe,
    setUnifiedTimeframe,
    fromDate,
    setFromDate,
    toDate,
    setToDate,
    weeklyBars,
    aggregatedFlashRedpointBars,
    vPointsTimeline,
    loadingAggregated,
    aggregatedStackedBars,
    loadingProfileStats,
    statisticsSummary,
    hardestSend,
    hardestFlash,
    percentile,
  } = useProfileData(userId, {
    initialProfileStats: initialProfileStats ?? undefined,
    initialPercentile,
    initialAllBoardsTicks,
    initialLogbook,
    initialIsOwnProfile,
  });

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerRendered, setDrawerRendered] = useState(false);

  const openDrawer = useCallback(() => {
    setDrawerRendered(true);
    setDrawerOpen(true);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
  }, []);

  const handleDrawerTransitionEnd = useCallback((open: boolean) => {
    if (!open) setDrawerRendered(false);
  }, []);

  const hasActiveFilters = unifiedTimeframe !== 'all' || selectedBoard !== 'all';

  return (
    <Box className={styles.layout}>
      <StatsFilterBridgeInjector
        openDrawer={openDrawer}
        pageTitle={t('filter.pageTitle')}
        backUrl={`/profile/${userId}`}
        hasActiveFilters={hasActiveFilters}
        isActive
      />
      <Box component="main" className={styles.content}>
        <StatsSummary
          statisticsSummary={statisticsSummary}
          hardestSend={hardestSend}
          hardestFlash={hardestFlash}
          loadingProfileStats={loadingProfileStats}
          loadingAggregated={loadingAggregated}
          weeklyBars={weeklyBars}
          aggregatedStackedBars={aggregatedStackedBars}
          aggregatedFlashRedpointBars={aggregatedFlashRedpointBars}
          vPointsTimeline={vPointsTimeline}
          percentile={percentile}
        />
        <BoardStatsSection
          selectedBoard={selectedBoard}
          loading={loadingAggregated}
          filteredLogbook={filteredLogbook}
          isOwnProfile={isOwnProfile}
        />
      </Box>
      {drawerRendered && (
        <StatsFilterDrawer
          open={drawerOpen}
          onClose={closeDrawer}
          selectedBoard={selectedBoard}
          onBoardChange={setSelectedBoard}
          timeframe={unifiedTimeframe}
          onTimeframeChange={setUnifiedTimeframe}
          fromDate={fromDate}
          onFromDateChange={setFromDate}
          toDate={toDate}
          onToDateChange={setToDate}
          onTransitionEnd={handleDrawerTransitionEnd}
        />
      )}
    </Box>
  );
}
