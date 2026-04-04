'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import MuiCard from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import { EmptyState } from '@/app/components/ui/empty-state';
import Logo from '@/app/components/brand/logo';
import BackButton from '@/app/components/back-button';
import AscentsFeed from '@/app/components/activity-feed';
import SetterClimbList from '@/app/components/climb-list/setter-climb-list';
import styles from './profile-page.module.css';
import { useProfileData } from './hooks/use-profile-data';
import ProfileHeader from './components/profile-header';
import BoardStatsSection from './components/board-stats-section';

export default function ProfilePageContent({ userId }: { userId: string }) {
  const {
    loading,
    notFound,
    profile,
    setProfile,
    isOwnProfile,
    hasCredentials,
    authToken,
    selectedBoard,
    setSelectedBoard,
    loadingStats,
    filteredLogbook,
    timeframe,
    setTimeframe,
    fromDate,
    setFromDate,
    toDate,
    setToDate,
    weeklyBars,
    aggregatedFlashRedpointBars,
    weeklyFromDate,
    setWeeklyFromDate,
    weeklyToDate,
    setWeeklyToDate,
    aggregatedTimeframe,
    setAggregatedTimeframe,
    loadingAggregated,
    aggregatedStackedBars,
    loadingProfileStats,
    statisticsSummary,
    activeTab,
    setActiveTab,
  } = useProfileData(userId);

  if (loading) {
    return (
      <Box className={styles.layout}>
        <Box component="main" className={styles.loadingContent}>
          <CircularProgress size={48} />
        </Box>
      </Box>
    );
  }

  if (notFound) {
    return (
      <Box className={styles.layout}>
        <Box component="header" className={styles.header}>
          <BackButton fallbackUrl="/" />
          <Logo size="sm" showText={false} />
          <Typography variant="h6" component="h4" className={styles.headerTitle}>
            Profile
          </Typography>
        </Box>
        <Box component="main" className={styles.content}>
          <EmptyState description="User not found" />
        </Box>
      </Box>
    );
  }

  return (
    <Box className={styles.layout}>
      <Box component="header" className={styles.header}>
        <BackButton fallbackUrl="/" />
        <Logo size="sm" showText={false} />
        <Typography variant="h6" component="h4" className={styles.headerTitle}>
          Profile
        </Typography>
      </Box>

      <Box component="main" className={styles.content}>
        {profile && (
          <ProfileHeader
            userId={userId}
            profile={profile}
            isOwnProfile={isOwnProfile}
            statisticsSummary={statisticsSummary}
            loadingProfileStats={loadingProfileStats}
            onProfileUpdate={setProfile}
            aggregatedTimeframe={aggregatedTimeframe}
            onAggregatedTimeframeChange={setAggregatedTimeframe}
            loadingAggregated={loadingAggregated}
            aggregatedStackedBars={aggregatedStackedBars}
            aggregatedFlashRedpointBars={aggregatedFlashRedpointBars}
          />
        )}

        <BoardStatsSection
          selectedBoard={selectedBoard}
          onBoardChange={setSelectedBoard}
          timeframe={timeframe}
          onTimeframeChange={setTimeframe}
          fromDate={fromDate}
          onFromDateChange={setFromDate}
          toDate={toDate}
          onToDateChange={setToDate}
          loadingStats={loadingStats}
          filteredLogbook={filteredLogbook}
          weeklyBars={weeklyBars}
          isOwnProfile={isOwnProfile}
          weeklyFromDate={weeklyFromDate}
          onWeeklyFromDateChange={setWeeklyFromDate}
          weeklyToDate={weeklyToDate}
          onWeeklyToDateChange={setWeeklyToDate}
        />

        {hasCredentials && (
          <Tabs
            value={activeTab}
            onChange={(_, val) => setActiveTab(val)}
            variant="fullWidth"
            sx={{ mb: 2 }}
          >
            <Tab label="Activity" value="activity" />
            <Tab label="Created Climbs" value="createdClimbs" />
          </Tabs>
        )}

        {(!hasCredentials || activeTab === 'activity') && (
          <MuiCard className={styles.statsCard}>
            <CardContent>
              <Typography variant="h6" component="h5">
                Recent Activity
              </Typography>
              <Typography variant="body2" component="span" color="text.secondary" className={styles.chartDescription}>
                Latest ascents and attempts
              </Typography>
              <AscentsFeed userId={userId} pageSize={10} />
            </CardContent>
          </MuiCard>
        )}

        {activeTab === 'createdClimbs' &&
          profile?.credentials &&
          (() => {
            const uniqueSetters = Array.from(
              new Map(profile.credentials.map((c) => [c.auroraUsername, c])).values(),
            );
            return uniqueSetters.map((cred) => (
              <MuiCard key={cred.auroraUsername} className={styles.statsCard}>
                <CardContent>
                  <Typography variant="h6" component="h5">
                    Created Climbs
                  </Typography>
                  <Typography
                    variant="body2"
                    component="span"
                    color="text.secondary"
                    className={styles.chartDescription}
                  >
                    Climbs set by {cred.auroraUsername} on{' '}
                    {cred.boardType.charAt(0).toUpperCase() + cred.boardType.slice(1)}
                  </Typography>
                  <SetterClimbList username={cred.auroraUsername} authToken={authToken} />
                </CardContent>
              </MuiCard>
            ));
          })()}
      </Box>
    </Box>
  );
}
