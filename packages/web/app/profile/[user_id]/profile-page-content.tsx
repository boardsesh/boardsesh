'use client';

import React, { useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import MuiCard from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TimelineOutlined from '@mui/icons-material/TimelineOutlined';
import FitnessCenterOutlined from '@mui/icons-material/FitnessCenterOutlined';
import ShowChartOutlined from '@mui/icons-material/ShowChartOutlined';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/app/components/ui/empty-state';
import { ProfileHeaderShareInjector } from '@/app/components/profile-header-bridge/profile-header-bridge-context';
import { CssBarChart } from '@/app/components/charts/css-bar-chart';
import { useGradeFormat } from '@/app/hooks/use-grade-format';
import type {
  GetUserClimbPercentileQueryResponse,
  GetUserProfileStatsQueryResponse,
} from '@boardsesh/graphql/operations/ticks';
import styles from './profile-page.module.css';
import { useProfileData } from './hooks/use-profile-data';
import { buildWeeklyBars } from './utils/chart-data-builders';
import UserCard from './components/user-card';
import ProfileNavCard from './components/profile-nav-card';
import ProfileBetaSection from './components/profile-beta-section';
import type { UserProfile, LogbookEntry } from './utils/profile-constants';
import type { RecentBetaLinkRow } from '@/app/lib/server-recent-beta-links';

type ProfilePageContentProps = {
  userId: string;
  initialProfile?: UserProfile | null;
  initialProfileStats?: GetUserProfileStatsQueryResponse['userProfileStats'] | null;
  initialPercentile?: GetUserClimbPercentileQueryResponse['userClimbPercentile'] | null;
  initialAllBoardsTicks?: Record<string, LogbookEntry[]>;
  initialLogbook?: LogbookEntry[];
  initialIsOwnProfile?: boolean;
  initialNotFound?: boolean;
  initialUserBeta?: RecentBetaLinkRow[];
};

export default function ProfilePageContent({
  userId,
  initialProfile,
  initialProfileStats,
  initialPercentile,
  initialAllBoardsTicks,
  initialLogbook,
  initialIsOwnProfile,
  initialNotFound,
  initialUserBeta = [],
}: ProfilePageContentProps) {
  const { gradeFormat } = useGradeFormat();
  const { t } = useTranslation('profile');

  const { loading, notFound, profile, setProfile, isOwnProfile, statisticsSummary, allBoardsTicks } = useProfileData(
    userId,
    {
      initialProfile: initialProfile ?? undefined,
      initialProfileStats: initialProfileStats ?? undefined,
      initialPercentile,
      initialAllBoardsTicks,
      initialLogbook,
      initialIsOwnProfile,
      initialNotFound,
    },
  );

  // Build overview bars from the live cache rather than the SSR-only prop, so
  // the chart updates after a tick mutation invalidates ['userTicks', ...].
  const overviewBars = useMemo(() => {
    const allTicks = Object.values(allBoardsTicks).flat();
    if (allTicks.length === 0) return null;
    const now = new Date();
    const threeMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
    const fromDate = threeMonthsAgo.toISOString().split('T')[0];
    const toDate = now.toISOString().split('T')[0];
    return buildWeeklyBars(allTicks, fromDate, toDate, gradeFormat);
  }, [allBoardsTicks, gradeFormat]);

  const sharedDisplayName = useMemo(() => profile?.displayName || null, [profile]);

  if (loading) {
    return (
      <Box className={styles.layout}>
        <ProfileHeaderShareInjector displayName={null} isActive={false} />
        <Box component="main" className={styles.loadingContent}>
          <CircularProgress size={48} />
        </Box>
      </Box>
    );
  }

  if (notFound) {
    return (
      <Box className={styles.layout}>
        <ProfileHeaderShareInjector displayName={null} isActive={false} />
        <Box component="main" className={styles.content}>
          <EmptyState description={t('empty.userNotFound')} />
        </Box>
      </Box>
    );
  }

  return (
    <Box className={styles.layout}>
      <ProfileHeaderShareInjector displayName={sharedDisplayName} isActive={Boolean(profile)} />
      <Box component="main" className={styles.content}>
        {profile && (
          <UserCard userId={userId} profile={profile} isOwnProfile={isOwnProfile} onProfileUpdate={setProfile} />
        )}

        {/* Overview: last 3 months activity */}
        {overviewBars && overviewBars.length > 0 && (
          <MuiCard className={styles.statsCard}>
            <CardContent>
              <Typography variant="body2" component="span" fontWeight={600} sx={{ mb: 1, display: 'block' }}>
                {t('page.lastThreeMonths')}
              </Typography>
              <CssBarChart
                bars={overviewBars}
                height={100}
                mobileHeight={80}
                showLegend={false}
                ariaLabel={t('page.activityChartLabel')}
              />
            </CardContent>
          </MuiCard>
        )}

        {/* Beta videos contributed by this user */}
        <ProfileBetaSection userId={userId} initialBeta={initialUserBeta} />

        {/* Navigation cards */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <ProfileNavCard
            title={t('nav.statistics.title')}
            subtitle={
              statisticsSummary.totalAscents > 0
                ? t('nav.statistics.subtitleSent', { count: statisticsSummary.totalAscents })
                : t('nav.statistics.subtitleEmpty')
            }
            href={`/profile/${userId}/statistics`}
            icon={<ShowChartOutlined />}
          />
          <ProfileNavCard
            title={t('nav.sessions.title')}
            subtitle={t('nav.sessions.subtitle')}
            href={`/profile/${userId}/sessions`}
            icon={<TimelineOutlined />}
          />
          <ProfileNavCard
            title={t('nav.createdClimbs.title')}
            subtitle={isOwnProfile ? t('nav.createdClimbs.subtitleOwn') : t('nav.createdClimbs.subtitleOther')}
            href={`/profile/${userId}/climbs`}
            icon={<FitnessCenterOutlined />}
          />
        </Box>
      </Box>
    </Box>
  );
}
