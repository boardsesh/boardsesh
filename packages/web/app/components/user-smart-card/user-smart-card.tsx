'use client';

import React, { useState, useEffect, useCallback } from 'react';
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

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [profileRes, statsData] = await Promise.all([
        fetch(`/api/internal/profile/${userId}`).then((r) => r.ok ? r.json() : null),
        (async () => {
          const client = createGraphQLHttpClient(null);
          const variables: GetUserProfileStatsQueryVariables = { userId };
          const response = await client.request<GetUserProfileStatsQueryResponse>(
            GET_USER_PROFILE_STATS,
            variables,
          );
          return response.userProfileStats;
        })(),
      ]);

      if (profileRes) {
        setProfile({
          id: profileRes.id,
          name: profileRes.name,
          image: profileRes.image,
          profile: profileRes.profile,
          followerCount: profileRes.followerCount ?? 0,
          followingCount: profileRes.followingCount ?? 0,
        });
      }

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
        setStats({ totalDistinctClimbs: total, layoutStats });
      }
    } catch (error) {
      console.error('Failed to load smart card data:', error);
    } finally {
      setLoading(false);
    }
  }, [userId]);

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

  if (!profile) return null;

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
