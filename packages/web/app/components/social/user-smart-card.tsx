'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';
import MuiCard from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import MuiAvatar from '@mui/material/Avatar';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Skeleton from '@mui/material/Skeleton';
import { PersonOutlined, ArrowForwardIos } from '@mui/icons-material';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_USER_PROFILE_STATS,
  type GetUserProfileStatsQueryVariables,
  type GetUserProfileStatsQueryResponse,
} from '@boardsesh/graphql/operations';
import { getDifficultyMapping, sortGrades } from '@/app/profile/[user_id]/utils/profile-constants';
import { V_GRADE_COLORS, FONT_GRADE_COLORS, getGradeColorWithOpacity } from '@/app/lib/grade-colors';
import { useGradeFormat } from '@/app/hooks/use-grade-format';
import styles from './user-smart-card.module.css';

type UserSmartCardProps = {
  userId: string;
  refreshKey?: number;
};

type ProfileData = {
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
};

type GradeBar = {
  grade: string;
  count: number;
  color: string;
};

type DonutSegment = {
  grade: string;
  count: number;
  color: string;
  /** length of the visible arc, in user units along the ring circumference */
  dash: number;
  /** offset from the 12-o'clock start, in user units */
  offset: number;
};

const CHIP_SX = { height: 20, fontSize: '0.7rem' } as const;

// Donut geometry (SVG user units). Outer ø 104, ~14px ring like the native arc.
const DONUT_SIZE = 104;
const DONUT_RADIUS = 45;
const DONUT_STROKE = 14;
const DONUT_CENTER = DONUT_SIZE / 2;
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;
// Hairline seam between segments; only applied when there is more than one grade.
const DONUT_SEGMENT_GAP = 3;

export default function UserSmartCard({ userId, refreshKey = 0 }: UserSmartCardProps) {
  const { t } = useTranslation('feed');
  const router = useLocaleRouter();
  const { gradeFormat, loaded: gradeFormatLoaded } = useGradeFormat();
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [totalClimbs, setTotalClimbs] = useState(0);
  const [rawStats, setRawStats] = useState<GetUserProfileStatsQueryResponse['userProfileStats'] | null>(null);
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
        setRawStats(statsData);
      }
    } catch {
      // Silently fail — card is a nice-to-have
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void fetchData();
  }, [fetchData, refreshKey]);

  const gradeBars = useMemo(() => {
    if (!rawStats) return [];
    const mapping = getDifficultyMapping(gradeFormat);
    const gradeAgg: Record<string, number> = {};
    for (const layout of rawStats.layoutStats) {
      for (const gc of layout.gradeCounts) {
        const num = parseInt(gc.grade, 10);
        if (isNaN(num)) continue;
        const grade = mapping[num];
        if (!grade) continue;
        gradeAgg[grade] = (gradeAgg[grade] || 0) + gc.count;
      }
    }
    const sortedGradeKeys = sortGrades(Object.keys(gradeAgg), gradeFormat);
    return sortedGradeKeys.map((grade) => {
      const count = gradeAgg[grade];
      const hex = V_GRADE_COLORS[grade] ?? FONT_GRADE_COLORS[grade.toLowerCase()];
      const color = hex ? getGradeColorWithOpacity(hex, 0.4) : 'rgba(200, 200, 200, 0.4)';
      return { grade, count, color };
    });
  }, [rawStats, gradeFormat]);

  const donut = useMemo(() => {
    const total = gradeBars.reduce((sum: number, bar: GradeBar) => sum + bar.count, 0);
    if (total <= 0) return { total: 0, segments: [] as DonutSegment[] };
    const multipleGrades = gradeBars.length > 1;
    const gap = multipleGrades ? DONUT_SEGMENT_GAP : 0;
    let cursor = 0;
    const segments: DonutSegment[] = gradeBars.map((bar: GradeBar) => {
      const fullLength = (bar.count / total) * DONUT_CIRCUMFERENCE;
      // Carve the seam out of the segment so the ring stays gap-free overall.
      const dash = Math.max(fullLength - gap, multipleGrades ? 0.5 : fullLength);
      const segment: DonutSegment = {
        grade: bar.grade,
        count: bar.count,
        color: bar.color,
        dash,
        offset: cursor,
      };
      cursor += fullLength;
      return segment;
    });
    return { total, segments };
  }, [gradeBars]);

  const displayName = profile?.profile?.displayName || profile?.name || 'Climber';
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
      <CardActionArea onClick={() => router.push(`/profile/${userId}`)}>
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
                {t('userSmartCard.follower', { count: profile.followerCount })}
                {' · '}
                {t('userSmartCard.following', { count: profile.followingCount })}
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
              <div className={styles.donutRow}>
                <div className={styles.donutGraphic}>
                  <svg
                    className={styles.donut}
                    viewBox={`0 0 ${DONUT_SIZE} ${DONUT_SIZE}`}
                    width={DONUT_SIZE}
                    height={DONUT_SIZE}
                    role="img"
                    aria-label={t('userSmartCard.distinctClimb', { count: totalClimbs })}
                  >
                    {/* Track sits under the segments so single-grade rings still read as a ring. */}
                    <circle
                      className={styles.donutTrack}
                      cx={DONUT_CENTER}
                      cy={DONUT_CENTER}
                      r={DONUT_RADIUS}
                      fill="none"
                      strokeWidth={DONUT_STROKE}
                    />
                    {/* Rotate -90° so segments begin at 12 o'clock. */}
                    <g transform={`rotate(-90 ${DONUT_CENTER} ${DONUT_CENTER})`}>
                      {donut.segments.map((segment: DonutSegment) => (
                        <circle
                          key={segment.grade}
                          cx={DONUT_CENTER}
                          cy={DONUT_CENTER}
                          r={DONUT_RADIUS}
                          fill="none"
                          stroke={segment.color}
                          strokeWidth={DONUT_STROKE}
                          strokeDasharray={`${segment.dash} ${DONUT_CIRCUMFERENCE - segment.dash}`}
                          strokeDashoffset={-segment.offset}
                        >
                          <title>{`${segment.grade}: ${segment.count}`}</title>
                        </circle>
                      ))}
                    </g>
                  </svg>

                  <div className={styles.donutCenter} aria-hidden="true">
                    <Typography variant="h6" component="span" fontWeight={700} color="text.primary" lineHeight={1}>
                      {totalClimbs}
                    </Typography>
                  </div>
                </div>

                <div className={styles.donutSide}>
                  <Typography variant="caption" component="span" color="text.secondary" className={styles.chartLabel}>
                    {t('userSmartCard.distinctClimb', { count: totalClimbs })}
                  </Typography>

                  <div className={styles.gradeLegend}>
                    {gradeBars.map((bar: GradeBar) => (
                      <span key={bar.grade} className={styles.gradeLegendItem}>
                        <span
                          className={styles.gradeLegendDot}
                          style={{ backgroundColor: bar.color }}
                          aria-hidden="true"
                        />
                        <Typography variant="caption" component="span" color="text.secondary">
                          {gradeFormatLoaded ? (
                            bar.grade
                          ) : (
                            <Skeleton variant="text" width={18} sx={{ display: 'inline-block', fontSize: 'inherit' }} />
                          )}
                        </Typography>
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </CardActionArea>
    </MuiCard>
  );
}
