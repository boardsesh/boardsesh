'use client';

import React, { useState, useMemo, useCallback } from 'react';
import MuiAvatar from '@mui/material/Avatar';
import MuiTooltip from '@mui/material/Tooltip';
import MuiCard from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import ToggleButton from '@mui/material/ToggleButton';
import CircularProgress from '@mui/material/CircularProgress';
import { PersonOutlined, Instagram } from '@mui/icons-material';
import FollowButton from '@/app/components/ui/follow-button';
import FollowerCount from '@/app/components/social/follower-count';
import { FOLLOW_USER, UNFOLLOW_USER } from '@/app/lib/graphql/operations';
import { CssBarChart, GroupedBarChart } from '@/app/components/charts/css-bar-chart';
import type { CssBarChartBar, BarSegment, GroupedBar } from '@/app/components/charts/css-bar-chart';
import { EmptyState } from '@/app/components/ui/empty-state';
import type { UserProfile } from '../utils/profile-constants';
import { type AggregatedTimeframeType, aggregatedTimeframeOptions } from '../utils/profile-constants';
import type { LayoutPercentage, LayoutLegendEntry } from '../utils/chart-data-builders';
import styles from '../profile-page.module.css';

interface ProfileHeaderProps {
  userId: string;
  profile: UserProfile;
  isOwnProfile: boolean;
  statisticsSummary: {
    totalAscents: number;
    layoutPercentages: LayoutPercentage[];
  };
  loadingProfileStats: boolean;
  onProfileUpdate: (updatedProfile: UserProfile) => void;
  aggregatedTimeframe: AggregatedTimeframeType;
  onAggregatedTimeframeChange: (value: AggregatedTimeframeType) => void;
  loadingAggregated: boolean;
  aggregatedStackedBars: { bars: CssBarChartBar[]; legendEntries: LayoutLegendEntry[] } | null;
  aggregatedFlashRedpointBars: GroupedBar[] | null;
}

export default function ProfileHeader({
  userId,
  profile,
  isOwnProfile,
  statisticsSummary,
  loadingProfileStats,
  onProfileUpdate,
  aggregatedTimeframe,
  onAggregatedTimeframeChange,
  loadingAggregated,
  aggregatedStackedBars,
  aggregatedFlashRedpointBars,
}: ProfileHeaderProps) {
  const displayName = profile.profile?.displayName || profile.name || 'Crusher';
  const avatarUrl = profile.profile?.avatarUrl || profile.image;
  const instagramUrl = profile.profile?.instagramUrl;

  // Legend click-to-filter: track which layouts are hidden
  const [hiddenLayouts, setHiddenLayouts] = useState<Set<string>>(new Set());

  const toggleLayout = useCallback((label: string) => {
    setHiddenLayouts((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  }, []);

  // Filter bars by zeroing out hidden layout segments
  const filteredBars = useMemo(() => {
    if (!aggregatedStackedBars || hiddenLayouts.size === 0) return aggregatedStackedBars?.bars ?? null;
    return aggregatedStackedBars.bars.map((bar) => ({
      ...bar,
      segments: bar.segments.map((seg: BarSegment) =>
        seg.label && hiddenLayouts.has(seg.label) ? { ...seg, value: 0 } : seg,
      ),
    }));
  }, [aggregatedStackedBars, hiddenLayouts]);

  return (
    <>
      {/* Profile Card */}
      <MuiCard className={styles.profileCard}><CardContent>
        <div className={styles.profileInfo}>
          <MuiAvatar sx={{ width: 80, height: 80 }} src={avatarUrl ?? undefined}>
            {!avatarUrl && <PersonOutlined />}
          </MuiAvatar>
          <div className={styles.profileDetails}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography variant="h6" component="h4" className={styles.displayName}>
                {displayName}
              </Typography>
              {!isOwnProfile && (
                <FollowButton
                  entityId={userId}
                  initialIsFollowing={profile.isFollowedByMe}
                  followMutation={FOLLOW_USER}
                  unfollowMutation={UNFOLLOW_USER}
                  entityLabel="user"
                  getFollowVariables={(id) => ({ input: { userId: id } })}
                  onFollowChange={(isFollowing) => {
                    onProfileUpdate({
                      ...profile,
                      followerCount: profile.followerCount + (isFollowing ? 1 : -1),
                      isFollowedByMe: isFollowing,
                    });
                  }}
                />
              )}
            </Box>
            <FollowerCount
              userId={userId}
              followerCount={profile.followerCount}
              followingCount={profile.followingCount}
            />
            {isOwnProfile && (
              <Typography variant="body2" component="span" color="text.secondary">{profile.email}</Typography>
            )}
            {instagramUrl && (
              <a
                href={instagramUrl.startsWith('http') ? instagramUrl : `https://${instagramUrl}`}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.instagramLink}
              >
                <Instagram className={styles.instagramIcon} />
                <span>{instagramUrl.replace(/^https?:\/\/(www\.)?instagram\.com\//, '@').replace(/\/$/, '')}</span>
              </a>
            )}
          </div>
        </div>
      </CardContent></MuiCard>

      {/* Statistics Summary Card */}
      {!loadingProfileStats && statisticsSummary.totalAscents > 0 && (
        <MuiCard className={styles.statsCard}><CardContent>
          <div className={styles.statsSummaryHeader}>
            <div className={styles.totalAscentsContainer}>
              <Typography variant="body2" component="span" className={styles.totalAscentsLabel}>Distinct Climbs</Typography>
              <Typography variant="h4" component="h2" className={styles.totalAscentsValue}>
                {statisticsSummary.totalAscents}
              </Typography>
            </div>
          </div>

          {statisticsSummary.layoutPercentages.length > 1 && (
            <div className={styles.percentageBarContainer}>
              <div className={styles.percentageBar}>
                {statisticsSummary.layoutPercentages.map((layout) => (
                  <MuiTooltip
                    key={layout.layoutKey}
                    title={`${layout.displayName}: ${layout.count} distinct climbs (${layout.percentage}%)`}
                  >
                    <div
                      className={styles.percentageSegment}
                      style={{ width: `${layout.percentage}%`, backgroundColor: layout.color }}
                    >
                      {layout.percentage >= 15 && (
                        <span className={styles.percentageLabel}>
                          {layout.displayName.split(' ').slice(-1)[0]} {layout.percentage}%
                        </span>
                      )}
                    </div>
                  </MuiTooltip>
                ))}
              </div>
              <div className={styles.percentageLegend}>
                {statisticsSummary.layoutPercentages.map((layout) => (
                  <div key={layout.layoutKey} className={styles.legendItem}>
                    <div className={styles.legendColor} style={{ backgroundColor: layout.color }} />
                    <Typography variant="body2" component="span" className={styles.legendText}>
                      {layout.displayName} ({layout.percentage}%)
                    </Typography>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Grade Distribution Chart */}
          <div className={styles.gradeDistributionSection}>
            <div className={styles.gradeDistributionHeader}>
              <Typography variant="body2" component="span" fontWeight={600} className={styles.gradeDistributionTitle}>
                Grade Distribution
              </Typography>
              <ToggleButtonGroup
                exclusive
                size="small"
                value={aggregatedTimeframe}
                onChange={(_, val) => { if (val) onAggregatedTimeframeChange(val as AggregatedTimeframeType); }}
                className={styles.gradeDistributionToggle}
              >
                {aggregatedTimeframeOptions.map((opt) => (
                  <ToggleButton key={opt.value} value={opt.value}>{opt.label}</ToggleButton>
                ))}
              </ToggleButtonGroup>
            </div>

            {loadingAggregated ? (
              <div className={styles.loadingStats}>
                <CircularProgress size={24} />
              </div>
            ) : filteredBars ? (
              <>
                <CssBarChart
                  bars={filteredBars}
                  height={160}
                  mobileHeight={120}
                  ariaLabel="Grade distribution across boards"
                />
                {aggregatedStackedBars && aggregatedStackedBars.legendEntries.length > 1 && (
                  <div className={styles.stackedChartLegend}>
                    {aggregatedStackedBars.legendEntries.map((entry) => {
                      const isHidden = hiddenLayouts.has(entry.label);
                      return (
                        <button
                          key={entry.label}
                          type="button"
                          className={styles.legendButton}
                          onClick={() => toggleLayout(entry.label)}
                          aria-pressed={!isHidden}
                        >
                          <div
                            className={styles.legendColor}
                            style={{
                              backgroundColor: entry.color,
                              opacity: isHidden ? 0.3 : 1,
                            }}
                          />
                          <Typography
                            variant="body2"
                            component="span"
                            className={styles.legendText}
                            style={{
                              opacity: isHidden ? 0.4 : 1,
                              textDecoration: isHidden ? 'line-through' : 'none',
                            }}
                          >
                            {entry.label}
                          </Typography>
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            ) : (
              <EmptyState description="No ascent data for this period" />
            )}
          </div>

          {/* Flash vs Redpoint */}
          {aggregatedFlashRedpointBars && !loadingAggregated && (
            <div className={styles.flashRedpointSection}>
              <Typography variant="body2" component="span" fontWeight={600} className={styles.gradeDistributionTitle}>
                Flash vs Redpoint
              </Typography>
              <GroupedBarChart
                bars={aggregatedFlashRedpointBars}
                height={140}
                mobileHeight={100}
                gap={2}
                ariaLabel="Flash vs redpoint by grade"
              />
            </div>
          )}
        </CardContent></MuiCard>
      )}
    </>
  );
}
