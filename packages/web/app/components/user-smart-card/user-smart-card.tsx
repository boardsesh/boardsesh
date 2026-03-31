'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import MuiCard from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import MuiAvatar from '@mui/material/Avatar';
import Typography from '@mui/material/Typography';
import MuiTooltip from '@mui/material/Tooltip';
import Skeleton from '@mui/material/Skeleton';
import Box from '@mui/material/Box';
import { PersonOutlined } from '@mui/icons-material';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_USER_PROFILE_STATS,
  type GetUserProfileStatsQueryVariables,
  type GetUserProfileStatsQueryResponse,
} from '@/app/lib/graphql/operations';
import {
  getLayoutDisplayName,
  getLayoutColor,
} from '@/app/crusher/[user_id]/utils/profile-constants';
import { V_GRADE_COLORS } from '@/app/lib/grade-colors';
import styles from './user-smart-card.module.css';

interface UserProfileData {
  id: string;
  name: string | null;
  image: string | null;
  profile: {
    displayName: string | null;
    avatarUrl: string | null;
  } | null;
  followerCount: number;
  followingCount: number;
}

interface GradeDistribution {
  vGrade: string;
  count: number;
  color: string;
}

interface ProfileStats {
  totalDistinctClimbs: number;
  layoutStats: Array<{
    layoutKey: string;
    boardType: string;
    displayName: string;
    color: string;
    distinctClimbCount: number;
    percentage: number;
  }>;
  gradeDistribution: GradeDistribution[];
}

interface UserSmartCardProps {
  userId: string;
  /** Increment this to trigger a data refresh */
  refreshKey?: number;
}

export default function UserSmartCard({ userId, refreshKey = 0 }: UserSmartCardProps) {
  const router = useRouter();
  const [profile, setProfile] = useState<UserProfileData | null>(null);
  const [stats, setStats] = useState<ProfileStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const graphqlClient = useMemo(() => createGraphQLHttpClient(null), []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [profileRes, statsData] = await Promise.all([
        fetch(`/api/internal/profile/${userId}`).then((r) => r.ok ? r.json() : null),
        (async () => {
          const variables: GetUserProfileStatsQueryVariables = { userId, gradeFormat: 'V_GRADE' };
          const response = await graphqlClient.request<GetUserProfileStatsQueryResponse>(
            GET_USER_PROFILE_STATS,
            variables,
          );
          return response.userProfileStats;
        })(),
      ]);

      if (!profileRes) {
        setError(true);
        return;
      }

      setProfile({
        id: profileRes.id,
        name: profileRes.name,
        image: profileRes.image,
        profile: profileRes.profile,
        followerCount: profileRes.followerCount ?? 0,
        followingCount: profileRes.followingCount ?? 0,
      });

      if (statsData) {
        const total = statsData.totalDistinctClimbs;
        const layoutStats = statsData.layoutStats
          .filter((s: { distinctClimbCount: number }) => s.distinctClimbCount > 0)
          .sort((a: { distinctClimbCount: number }, b: { distinctClimbCount: number }) => b.distinctClimbCount - a.distinctClimbCount)
          .map((s: { layoutKey: string; boardType: string; layoutId: number | null; distinctClimbCount: number }) => ({
            layoutKey: s.layoutKey,
            boardType: s.boardType,
            displayName: getLayoutDisplayName(s.boardType, s.layoutId),
            color: getLayoutColor(s.boardType, s.layoutId),
            distinctClimbCount: s.distinctClimbCount,
            percentage: total > 0 ? Math.round((s.distinctClimbCount / total) * 100) : 0,
          }));

        // Aggregate grade counts across all layouts (server returns V-grades)
        const vGradeCounts = new Map<string, number>();
        for (const layout of statsData.layoutStats) {
          for (const gc of layout.gradeCounts) {
            vGradeCounts.set(gc.grade, (vGradeCounts.get(gc.grade) ?? 0) + gc.count);
          }
        }

        // Sort by V-grade number and build distribution array
        const gradeDistribution: GradeDistribution[] = Array.from(vGradeCounts.entries())
          .sort((a, b) => {
            const numA = parseInt(a[0].slice(1), 10);
            const numB = parseInt(b[0].slice(1), 10);
            return numA - numB;
          })
          .map(([vGrade, count]) => ({
            vGrade,
            count,
            color: V_GRADE_COLORS[vGrade] ?? '#9CA3AF',
          }));

        setStats({ totalDistinctClimbs: total, layoutStats, gradeDistribution });
      }
    } catch (err) {
      console.error('Failed to load smart card data:', err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [userId, graphqlClient]);

  useEffect(() => {
    fetchData();
  }, [fetchData, refreshKey]);

  const displayName = profile?.profile?.displayName || profile?.name || 'Crusher';
  const avatarUrl = profile?.profile?.avatarUrl || profile?.image;

  if (loading) {
    return (
      <MuiCard className={styles.card}>
        <CardContent className={styles.cardContent}>
          <div className={styles.header}>
            <Skeleton variant="circular" width={56} height={56} />
            <div className={styles.headerText}>
              <Skeleton variant="text" width={120} height={24} />
              <Skeleton variant="text" width={80} height={18} />
            </div>
          </div>
          <Skeleton variant="rounded" width="100%" height={20} sx={{ mt: 2 }} />
        </CardContent>
      </MuiCard>
    );
  }

  if (error || !profile) {
    return (
      <MuiCard className={styles.card}>
        <CardContent className={styles.cardContent}>
          <Typography variant="body2" color="text.secondary">
            Couldn&apos;t load your profile. Try refreshing the page.
          </Typography>
        </CardContent>
      </MuiCard>
    );
  }

  return (
    <MuiCard className={styles.card}>
      <CardActionArea onClick={() => router.push(`/crusher/${userId}`)}>
        <CardContent className={styles.cardContent}>
          <div className={styles.header}>
            <MuiAvatar
              src={avatarUrl ?? undefined}
              sx={{ width: 56, height: 56 }}
            >
              {!avatarUrl && <PersonOutlined />}
            </MuiAvatar>
            <div className={styles.headerText}>
              <Typography variant="subtitle1" component="span" fontWeight={600}>
                {displayName}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {profile.followerCount} follower{profile.followerCount !== 1 ? 's' : ''}
                {' \u00B7 '}
                {profile.followingCount} following
              </Typography>
            </div>
          </div>

          {stats && stats.totalDistinctClimbs > 0 && (
            <div className={styles.statsSection}>
              <Typography variant="body2" color="text.secondary" className={styles.climbCount}>
                {stats.totalDistinctClimbs} distinct climb{stats.totalDistinctClimbs !== 1 ? 's' : ''}
              </Typography>

              <div className={styles.percentageBar}>
                {stats.layoutStats.map((layout) => (
                  <MuiTooltip
                    key={layout.layoutKey}
                    title={`${layout.displayName}: ${layout.distinctClimbCount} climbs (${layout.percentage}%)`}
                  >
                    <div
                      className={styles.percentageSegment}
                      style={{
                        width: `${layout.percentage}%`,
                        backgroundColor: layout.color,
                      }}
                    />
                  </MuiTooltip>
                ))}
              </div>

              <div className={styles.legend}>
                {stats.layoutStats.map((layout) => (
                  <div key={layout.layoutKey} className={styles.legendItem}>
                    <div
                      className={styles.legendDot}
                      style={{ backgroundColor: layout.color }}
                    />
                    <Typography variant="caption" color="text.secondary">
                      {layout.displayName}
                    </Typography>
                  </div>
                ))}
              </div>
            </div>
          )}

          {stats && stats.gradeDistribution.length > 0 && (() => {
            const maxCount = Math.max(...stats.gradeDistribution.map((g) => g.count));
            return (
              <div className={styles.gradeChart}>
                <div className={styles.gradeChartBars}>
                  {stats.gradeDistribution.map((g) => (
                    <MuiTooltip key={g.vGrade} title={`${g.vGrade}: ${g.count}`}>
                      <div className={styles.gradeChartColumn}>
                        <div
                          className={styles.gradeChartBar}
                          style={{
                            height: `${(g.count / maxCount) * 100}%`,
                            backgroundColor: g.color,
                          }}
                        />
                        <Typography variant="caption" className={styles.gradeChartLabel}>
                          {g.vGrade}
                        </Typography>
                      </div>
                    </MuiTooltip>
                  ))}
                </div>
              </div>
            );
          })()}

          {(!stats || stats.totalDistinctClimbs === 0) && (
            <Box sx={{ mt: 1.5 }}>
              <Typography variant="body2" color="text.secondary">
                No climbs logged yet. Import your data to see your stats here.
              </Typography>
            </Box>
          )}
        </CardContent>
      </CardActionArea>
    </MuiCard>
  );
}
