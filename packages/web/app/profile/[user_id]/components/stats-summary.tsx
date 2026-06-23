'use client';

import React from 'react';
import MuiTooltip from '@mui/material/Tooltip';
import MuiCard from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';
import { useTranslation } from 'react-i18next';
import {
  CssBarChart,
  GroupedBarChart,
  type CssBarChartBar,
  type GroupedBar,
} from '@/app/components/charts/css-bar-chart';
import { EmptyState } from '@/app/components/ui/empty-state';
import { themeTokens } from '@/app/theme/theme-config';
import { AscentStatusIcon } from '@/app/components/ascent-status/ascent-status-icon';
import type { LayoutPercentage, LayoutLegendEntry, VPointsTimelineData } from '../utils/chart-data-builders';
import VPointsChart from './v-points-chart';
import styles from '../profile-page.module.css';

type GradeHighlight = {
  label: string;
  color: string;
  textColor: string;
  status: 'send' | 'flash';
};

export type StatsSummaryProps = {
  statisticsSummary: {
    totalAscents: number;
    layoutPercentages: LayoutPercentage[];
  };
  hardestSend?: GradeHighlight | null;
  hardestFlash?: GradeHighlight | null;
  loadingProfileStats: boolean;
  loadingAggregated: boolean;
  weeklyBars: CssBarChartBar[] | null;
  aggregatedStackedBars: { bars: CssBarChartBar[]; legendEntries: LayoutLegendEntry[] } | null;
  aggregatedFlashRedpointBars: GroupedBar[] | null;
  vPointsTimeline: VPointsTimelineData | null;
  percentile?: { totalDistinctClimbs: number; percentile: number; totalActiveUsers: number } | null;
};

export default function StatsSummary({
  statisticsSummary,
  hardestSend,
  hardestFlash,
  loadingProfileStats,
  loadingAggregated,
  weeklyBars,
  aggregatedStackedBars,
  aggregatedFlashRedpointBars,
  vPointsTimeline,
  percentile,
}: StatsSummaryProps) {
  const { t } = useTranslation('profile');
  if (loadingProfileStats || statisticsSummary.totalAscents === 0) {
    return null;
  }

  const renderHighlightCard = (statusTestId: string, subtitle: string, highlight: GradeHighlight) => (
    <Box
      sx={{
        flex: 1,
        position: 'relative',
        borderRadius: `${themeTokens.borderRadius.md}px`,
        bgcolor: highlight.color,
        color: highlight.textColor,
        p: 1.5,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0.125,
        textAlign: 'center',
        overflow: 'hidden',
      }}
    >
      <Typography variant="h5" component="span" fontWeight={700} sx={{ display: 'block', lineHeight: 1 }}>
        {highlight.label}
      </Typography>
      <Typography variant="caption" sx={{ display: 'block', lineHeight: 1, opacity: 0.8 }}>
        {subtitle}
      </Typography>
      <Box
        sx={{
          position: 'absolute',
          right: 8,
          top: 'calc(50% + 4px)',
          transform: 'translateY(-50%)',
          lineHeight: 0,
        }}
      >
        <AscentStatusIcon
          status={highlight.status}
          variant="badge"
          fontSize={12}
          badgeSize={20}
          testId={statusTestId}
        />
      </Box>
    </Box>
  );

  let gradeDistributionContent: React.ReactNode;
  if (loadingAggregated) {
    gradeDistributionContent = (
      <div className={styles.loadingStats}>
        <CircularProgress size={24} />
      </div>
    );
  } else if (aggregatedStackedBars?.bars) {
    gradeDistributionContent = (
      <CssBarChart
        bars={aggregatedStackedBars.bars}
        height={160}
        mobileHeight={120}
        showLegend={false}
        ariaLabel={t('stats.gradeDistributionAria')}
      />
    );
  } else {
    gradeDistributionContent = <EmptyState description={t('empty.noAscentData')} />;
  }

  return (
    <MuiCard className={styles.statsCard}>
      <CardContent>
        <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
          <Box
            sx={{
              flex: 1,
              borderRadius: `${themeTokens.borderRadius.md}px`,
              bgcolor: 'var(--neutral-100)',
              p: 1.5,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 0.125,
              textAlign: 'center',
            }}
          >
            <Typography variant="h5" component="span" fontWeight={700} sx={{ display: 'block', lineHeight: 1 }}>
              {statisticsSummary.totalAscents}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', lineHeight: 1, opacity: 0.8 }}>
              {t('stats.problems')}
            </Typography>
          </Box>
          {hardestSend && renderHighlightCard('hardest-send-status', t('stats.send'), hardestSend)}
          {hardestFlash && renderHighlightCard('hardest-flash-status', t('stats.flash'), hardestFlash)}
        </Box>

        {percentile && percentile.percentile > 0 && (
          <Box sx={{ mb: 2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
              <Typography variant="caption" color="text.secondary">
                {t('stats.percentile')}
              </Typography>
              <Typography variant="caption" fontWeight={600}>
                {t('stats.topPercent', {
                  value: Math.max(0.1, 100 - percentile.percentile).toFixed(percentile.percentile >= 99 ? 1 : 0),
                })}
              </Typography>
            </Box>
            <Box
              sx={{
                height: 8,
                borderRadius: 4,
                bgcolor: 'var(--neutral-100)',
                overflow: 'hidden',
              }}
            >
              <Box
                sx={{
                  height: '100%',
                  width: `${percentile.percentile}%`,
                  borderRadius: 4,
                  bgcolor: 'var(--color-primary-fill)',
                  transition: 'width 0.5s ease',
                }}
              />
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
              {t('stats.moreSentThan', { value: percentile.percentile.toFixed(0) })}
            </Typography>
          </Box>
        )}

        {statisticsSummary.layoutPercentages.length > 1 && (
          <div className={styles.percentageBarContainer}>
            <div className={styles.percentageBar}>
              {statisticsSummary.layoutPercentages.map((layout) => (
                <MuiTooltip
                  key={layout.layoutKey}
                  title={t('stats.layoutTooltip', {
                    name: layout.displayName,
                    count: layout.count,
                    percentage: layout.percentage,
                  })}
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
          </div>
        )}

        {weeklyBars && (
          <div className={styles.gradeDistributionSection}>
            <Typography variant="body2" component="span" fontWeight={600} className={styles.gradeDistributionTitle}>
              {t('stats.activity')}
            </Typography>
            <CssBarChart
              bars={weeklyBars}
              height={200}
              mobileHeight={150}
              gap={3}
              ariaLabel={t('stats.weeklyAttemptsAria')}
              maxLabels={12}
            />
          </div>
        )}

        <div className={weeklyBars ? styles.flashRedpointSection : styles.gradeDistributionSection}>
          <Typography variant="body2" component="span" fontWeight={600} className={styles.gradeDistributionTitle}>
            {t('stats.gradeDistribution')}
          </Typography>

          {gradeDistributionContent}
        </div>

        {aggregatedFlashRedpointBars && !loadingAggregated && (
          <div className={styles.flashRedpointSection}>
            <Typography variant="body2" component="span" fontWeight={600} className={styles.gradeDistributionTitle}>
              {t('stats.flashVsRedpoint')}
            </Typography>
            <GroupedBarChart
              bars={aggregatedFlashRedpointBars}
              height={140}
              mobileHeight={100}
              gap={2}
              showLegend={false}
              ariaLabel={t('stats.flashRedpointAria')}
            />
          </div>
        )}

        {vPointsTimeline && !loadingAggregated && (
          <div className={styles.flashRedpointSection}>
            <VPointsChart data={vPointsTimeline} />
          </div>
        )}
      </CardContent>
    </MuiCard>
  );
}
