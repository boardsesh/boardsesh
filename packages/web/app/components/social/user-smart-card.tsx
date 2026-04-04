'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import MuiCard from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import MuiAvatar from '@mui/material/Avatar';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Skeleton from '@mui/material/Skeleton';
import Box from '@mui/material/Box';
import { PersonOutlined, ArrowForwardIos } from '@mui/icons-material';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_USER_PROFILE_STATS,
  type GetUserProfileStatsQueryVariables,
  type GetUserProfileStatsQueryResponse,
} from '@/app/lib/graphql/operations';
import { difficultyMapping } from '@/app/crusher/[user_id]/utils/profile-constants';
import { V_GRADE_COLORS, getGradeColorWithOpacity } from '@/app/lib/grade-colors';
import styles from './user-smart-card.module.css';

interface UserSmartCardProps {
  userId: string;
  refreshKey?: number;
}

interface ProfileData {
  id: string;
  name: string | null;
  image: string | null;
  profile: {
    displayName: string | null;
    avatarUrl: string | null;
  } | null;
  credentials?: Array<{
    boardType: string;
    auroraUsername: string;
  }>;
  followerCount: number;
  followingCount: number;
}

interface GradeBar {
  grade: string;
  count: number;
  color: string;
}

const GRADE_ORDER = [...new Set(Object.values(difficultyMapping))];
const CHIP_SX = { height: 20, fontSize: '0.7rem' } as const;

export default function UserSmartCard({ userId, refreshKey = 0 }: UserSmartCardProps) {
  const router = useRouter();
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [totalClimbs, setTotalClimbs] = useState(0);
  const [gradeBars, setGradeBars] = useState<GradeBar[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [profileRes, statsData] = await Promise.all([
        fetch(`/api/internal/profile/${userId}`).then((r) => (r.ok ? r.json() : null)),
        (async () => {
          try {
            const client = createGraphQLHttpClient(null);
            const res = await client.request<GetUserProfileStatsQueryResponse, GetUserProfileStatsQueryVariables>(
              GET_USER_PROFILE_STATS,
              { userId },
            );
            return res.userProfileStats;
          } catch {
            return null;
          }
        })(),
      ]);

      if (profileRes) {
        setProfile(profileRes);
      }

      if (statsData) {
        setTotalClimbs(statsData.totalDistinctClimbs);

        // Aggregate grade counts across all layouts, grouped by V-grade
        const gradeAgg: Record<string, number> = {};
        for (const layout of statsData.layoutStats) {
          for (const gc of layout.gradeCounts) {
            const num = parseInt(gc.grade, 10);
            if (isNaN(num)) continue;
            const grade = difficultyMapping[num];
            if (!grade) continue;
            gradeAgg[grade] = (gradeAgg[grade] || 0) + gc.count;
          }
        }

        // Convert to sorted bars
        const bars: GradeBar[] = Object.entries(gradeAgg)
          .map(([grade, count]) => {
            const hex = V_GRADE_COLORS[grade];
            const color = hex ? getGradeColorWithOpacity(hex, 0.4) : 'rgba(200, 200, 200, 0.4)';
            return { grade, count, color };
          })
          .sort((a: GradeBar, b: GradeBar) => GRADE_ORDER.indexOf(a.grade) - GRADE_ORDER.indexOf(b.grade));

        setGradeBars(bars);
      }
    } catch {
      // Silently fail — card is a nice-to-have
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchData();
  }, [fetchData, refreshKey]);

  const maxCount = useMemo(() => Math.max(...gradeBars.map((b: GradeBar) => b.count), 1), [gradeBars]);

  const displayName = profile?.profile?.displayName || profile?.name || 'Crusher';
  const avatarUrl = profile?.profile?.avatarUrl || profile?.image;

  if (loading) {
    return (
      <MuiCard variant="outlined" className={styles.card}>
        <CardContent>
          <div className={styles.skeletonRow}>
            <Skeleton variant="circular" width={48} height={48} />
            <div className={styles.skeletonInfo}>
              <Skeleton variant="text" width="60%" height={24} />
              <Skeleton variant="text" width="40%" height={16} />
              <Skeleton variant="rectangular" width="100%" height={32} sx={{ borderRadius: 0.5, mt: 1 }} />
            </div>
          </div>
        </CardContent>
      </MuiCard>
    );
  }

  if (!profile) return null;

  return (
    <MuiCard variant="outlined" className={styles.card}>
      <CardActionArea onClick={() => router.push(`/crusher/${userId}`)}>
        <CardContent>
          <div className={styles.cardInner}>
            <MuiAvatar src={avatarUrl ?? undefined} sx={{ width: 48, height: 48 }}>
              {!avatarUrl && <PersonOutlined />}
            </MuiAvatar>

            <div className={styles.infoSection}>
              <div className={styles.nameRow}>
                <Typography variant="subtitle1" component="span" fontWeight={600} noWrap>
                  {displayName}
                </Typography>
              </div>

              <Typography variant="caption" component="span" color="text.secondary">
                {profile.followerCount} follower{profile.followerCount !== 1 ? 's' : ''}
                {' · '}
                {profile.followingCount} following
              </Typography>

              {profile.credentials && profile.credentials.length > 0 && (
                <div className={styles.chips}>
                  {profile.credentials.map((cred: { boardType: string; auroraUsername: string }) => (
                    <Chip
                      key={cred.boardType}
                      label={cred.boardType.charAt(0).toUpperCase() + cred.boardType.slice(1)}
                      size="small"
                      variant="outlined"
                      sx={CHIP_SX}
                    />
                  ))}
                </div>
              )}
            </div>

            <ArrowForwardIos className={styles.arrowIcon} fontSize="small" />
          </div>

          {gradeBars.length > 0 && (
            <div className={styles.chartSection}>
              <Typography variant="caption" component="span" color="text.secondary" className={styles.chartLabel}>
                {totalClimbs} distinct climb{totalClimbs !== 1 ? 's' : ''}
              </Typography>

              <div className={styles.gradeBarContainer}>
                {gradeBars.map((bar: GradeBar) => (
                  <Box
                    key={bar.grade}
                    className={styles.gradeBar}
                    sx={{
                      height: `${Math.max((bar.count / maxCount) * 100, 8)}%`,
                      backgroundColor: bar.color,
                    }}
                    title={`${bar.grade}: ${bar.count}`}
                  />
                ))}
              </div>
              <div className={styles.gradeLegend}>
                {gradeBars.map((bar: GradeBar) => (
                  <span key={bar.grade} className={styles.gradeLegendLabel}>
                    {bar.grade}
                  </span>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </CardActionArea>
    </MuiCard>
  );
}
