'use client';

import React, { useCallback, useState } from 'react';
import MuiAvatar from '@mui/material/Avatar';
import MuiCard from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import { PersonOutlined } from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import styles from '@/app/profile/[user_id]/profile-page.module.css';
import { useProfileData } from '@/app/profile/[user_id]/hooks/use-profile-data';
import StatsSummary from '@/app/profile/[user_id]/components/stats-summary';
import BoardStatsSection from '@/app/profile/[user_id]/components/board-stats-section';
import FollowerCount from '@/app/components/social/follower-count';
import { StatsFilterBridgeInjector } from '@/app/components/stats-filter-bridge/stats-filter-bridge-context';
import StatsFilterDrawer from '@/app/components/stats-filter-drawer/stats-filter-drawer';
import YouPageSkeleton from './you-page-skeleton';

export type YouProgressContentProps = {
  userId: string;
};

export default function YouProgressContent({ userId }: YouProgressContentProps) {
  const { t } = useTranslation('you');
  const { t: tProfile } = useTranslation('profile');
  const {
    loading,
    profile,
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
  } = useProfileData(userId, { initialIsOwnProfile: true });

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

  if (loading) {
    return <YouPageSkeleton />;
  }

  const displayName = profile?.displayName || tProfile('page.displayNameFallback');
  const avatarUrl = profile?.avatarUrl;

  return (
    <>
      {profile && (
        <MuiCard className={styles.profileCard}>
          <CardContent>
            <div className={styles.profileInfo}>
              <MuiAvatar sx={{ width: 80, height: 80 }} src={avatarUrl ?? undefined}>
                {!avatarUrl && <PersonOutlined />}
              </MuiAvatar>
              <div className={styles.profileDetails}>
                <Typography variant="h6" component="h1" className={styles.displayName}>
                  {displayName}
                </Typography>
                <FollowerCount
                  userId={profile.id}
                  followerCount={profile.followerCount}
                  followingCount={profile.followingCount}
                />
              </div>
            </div>
          </CardContent>
        </MuiCard>
      )}
      <StatsFilterBridgeInjector
        openDrawer={openDrawer}
        pageTitle={t('progress.title')}
        backUrl={null}
        hasActiveFilters={hasActiveFilters}
        isActive
      />
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
        isOwnProfile
      />
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
    </>
  );
}
