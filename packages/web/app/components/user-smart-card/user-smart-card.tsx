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

// Layout color mapping (subset from profile-constants)
const layoutColors: Record<string, string> = {
  'kilter-1': 'rgba(6, 182, 212, 0.85)',
  'kilter-8': 'rgba(57, 255, 20, 0.85)',
  'tension-9': 'rgba(239, 68, 68, 0.85)',
  'tension-10': 'rgba(249, 115, 22, 0.85)',
  'tension-11': 'rgba(234, 179, 8, 0.85)',
  'moonboard-1': 'rgba(255, 215, 0, 0.85)',
  'moonboard-2': 'rgba(255, 165, 0, 0.85)',
  'moonboard-3': 'rgba(255, 140, 0, 0.85)',
  'moonboard-4': 'rgba(255, 193, 7, 0.85)',
  'moonboard-5': 'rgba(255, 152, 0, 0.85)',
};

const layoutNames: Record<string, string> = {
  'kilter-1': 'Kilter Original',
  'kilter-8': 'Kilter Homewall',
  'tension-9': 'Tension Classic',
  'tension-10': 'Tension 2 Mirror',
  'tension-11': 'Tension 2 Spray',
  'moonboard-1': 'MoonBoard 2010',
  'moonboard-2': 'MoonBoard 2016',
  'moonboard-3': 'MoonBoard 2024',
  'moonboard-4': 'MoonBoard Masters 2017',
  'moonboard-5': 'MoonBoard Masters 2019',
};

function getLayoutDisplayName(key: string): string {
  return layoutNames[key] || key;
}

function getLayoutColor(key: string): string {
  return layoutColors[key] || 'rgba(150, 150, 150, 0.7)';
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
          .map((s: { layoutKey: string; boardType: string; distinctClimbCount: number }) => ({
            layoutKey: s.layoutKey,
            boardType: s.boardType,
            displayName: getLayoutDisplayName(s.layoutKey),
            color: getLayoutColor(s.layoutKey),
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
