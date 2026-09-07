import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { View, RefreshControl, ScrollView, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { useYouProfileData } from '../../lib/graphql/hooks';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Card } from '../Card';
import { SectionHeader } from '../SectionHeader';
import { ActivityIndicator } from '../ActivityIndicator';
import { OfflineState } from '../OfflineState';
import { ProfileBetaShelf } from './ProfileBetaShelf';
import { StatsSummaryCard } from './StatsSummaryCard';
import { PeriodComparisonCard } from './PeriodComparisonCard';
import { StackedBarChart, GroupedBarChart, TotalAreaChart, type ChartLegendItem } from './YouCharts';
import { ActivityHeatmap } from './ActivityHeatmap';
import { LayoutShareDonut } from './LayoutShareDonut';
import { layoutChartColor, flashRedpointColor } from './profile-chart-colors';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { OnboardingTipBanner } from '../onboarding/OnboardingTipBanner';
import { BoardLinkPrompt } from './BoardLinkPrompt';
import { hasSeenTip, markTipSeen } from '../../lib/onboarding/onboarding-storage';
import { getCachedNumberFormat } from '../../lib/intl-formatter-cache';
import { ONBOARDING_TIP_RECORD_KEY } from '@boardsesh/key-value-storage';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

type YouData = ReturnType<typeof useYouProfileData>;

type ProgressTabProps = {
  data: YouData;
  /** Measured chrome height — the scroll content insets its top by this so the
   *  first card rests below the floating chrome and the rest scroll under it. */
  topInset: number;
  /** Climber whose beta-video shelf to show above the stats. Omit to hide it
   *  (e.g. before the viewer's own id resolves). */
  userId?: string;
  /**
   * Whether the viewer owns this profile. Mirrors `LogbookTab`, and defaults the
   * same way, because this tab renders on `users/[userId]` for other climbers too:
   * without it the empty state would offer to link *your* board account while you
   * are looking at a stranger's empty stats.
   */
  viewerIsOwner?: boolean;
};

export const ProgressTab = memo(function ProgressTab({
  data,
  topInset,
  userId,
  viewerIsOwner = true,
}: ProgressTabProps) {
  const { t } = useTranslation('profile');
  const { t: tYou } = useTranslation('you');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, colorScheme, brandColors } = useTheme();
  const bottomChrome = useBottomChromeMetrics();
  const paddingBottom = bottomChrome.scrollBottomPadding + spacing[6];

  const totalAscents = data.statisticsSummary.totalAscents;
  const noAscentData = t('empty.noAscentData');

  // One-time record/tracking tip, shown once the user actually has sends to
  // chart (so "your sends chart out here" is true). Fires once, then never again.
  const [recordTipVisible, setRecordTipVisible] = useState(false);
  const hasAscents = totalAscents > 0;
  useEffect(() => {
    if (!hasAscents) return;
    let cancelled = false;
    void hasSeenTip(ONBOARDING_TIP_RECORD_KEY).then((seen) => {
      if (!cancelled && !seen) setRecordTipVisible(true);
    });
    return () => {
      cancelled = true;
    };
  }, [hasAscents]);
  const dismissRecordTip = useCallback(() => {
    setRecordTipVisible(false);
    void markTipSeen(ONBOARDING_TIP_RECORD_KEY);
  }, []);

  // Legends so the layout-colored grade-distribution bars and the
  // flash-vs-redpoint pairs can be decoded (charts are color-only otherwise).
  const gradeDistLegend = useMemo<ChartLegendItem[] | undefined>(
    () =>
      data.aggregatedStackedBars?.legend.map((entry) => ({
        label: entry.label,
        color: layoutChartColor(entry.key, colorScheme),
      })),
    [colorScheme, data.aggregatedStackedBars],
  );
  const flashRedpointLegend = useMemo<ChartLegendItem[] | undefined>(
    () =>
      data.aggregatedFlashRedpointBars?.[0]?.values.map((value) => ({
        label: value.label,
        color: flashRedpointColor(value.key, colorScheme),
      })),
    [data.aggregatedFlashRedpointBars, colorScheme],
  );

  // Offline (or a hard fetch failure) with nothing cached: say so rather than
  // spin forever on a paused query or chart an empty climber.
  if (data.offline.isBlocked && data.offline.reason) {
    return (
      <View style={[styles.centered, { paddingTop: topInset }]}>
        <OfflineState reason={data.offline.reason} onRetry={data.refetch} />
      </View>
    );
  }

  if (data.loading) {
    return (
      <View style={[styles.centered, { paddingTop: topInset }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.flex}
      contentInsetAdjustmentBehavior="never"
      contentContainerStyle={{ paddingTop: topInset, paddingBottom }}
      scrollIndicatorInsets={{ top: topInset }}
      refreshControl={
        <RefreshControl refreshing={data.refreshing} onRefresh={data.refetch} tintColor={brandColors.primary} />
      }
    >
      {recordTipVisible ? (
        <View style={styles.tipInset}>
          <OnboardingTipBanner
            text={tCommon('mobile.onboarding.tips.record')}
            dismissLabel={tCommon('actions.close')}
            onDismiss={dismissRecordTip}
            icon="chart.bar"
          />
        </View>
      ) : null}

      {totalAscents === 0 ? (
        <>
          {/* Above the placard, not inside it: the placard explains the empty
              chart, this explains why the history they already have is missing. */}
          <BoardLinkPrompt viewerIsOwner={viewerIsOwner} hasNoSends />
          <View style={styles.empty}>
            <Icon name="chart.bar" size={48} color={systemColors.tertiaryLabel} />
            <Text variant="headline" style={styles.emptyTitle}>
              {tYou('mobile.progress.empty')}
            </Text>
          </View>
        </>
      ) : (
        <>
          <SectionHeader title={t('stats.summary')} />
          <StatsSummaryCard
            statisticsSummary={data.statisticsSummary}
            hardestSend={data.hardestSend}
            hardestFlash={data.hardestFlash}
            percentile={data.percentile}
          />

          <PeriodComparisonCard
            periodComparison={data.periodComparison}
            comparisonMode={data.comparisonMode}
            onComparisonModeChange={data.setComparisonMode}
          />

          {/* Recent beta videos shelf — sits below the stats summary, hidden when
              the climber has shared none (or has no stats yet). */}
          {userId ? <ProfileBetaShelf userId={userId} /> : null}

          {data.activityHeatmap && (
            <>
              <SectionHeader title={t('stats.calendar')} />
              <Card style={styles.chartCard}>
                <ActivityHeatmap heatmap={data.activityHeatmap} />
              </Card>
            </>
          )}

          {data.statisticsSummary.layoutPercentages.length > 1 && (
            <>
              <SectionHeader title={t('stats.boards')} />
              <Card style={styles.chartCard}>
                <LayoutShareDonut
                  layoutPercentages={data.statisticsSummary.layoutPercentages}
                  totalAscents={data.statisticsSummary.totalAscents}
                />
              </Card>
            </>
          )}

          <SectionHeader title={t('stats.activity')} />
          <Card style={styles.chartCard}>
            {/* Weekly labels ("W23 '24") are wide, so cap to ~6 evenly-spaced
                markers — horizontal labels stay readable instead of colliding. */}
            <StackedBarChart
              bars={data.weeklyBars}
              colorBy="grade"
              emptyLabel={noAscentData}
              maxXLabels={6}
              showYAxisScale
              accessibilityLabel={t('stats.weeklyAttemptsAria')}
            />
          </Card>

          <SectionHeader title={t('stats.gradeDistribution')} />
          <Card style={styles.chartCard}>
            <StackedBarChart
              bars={data.aggregatedStackedBars?.bars ?? null}
              colorBy="layout"
              emptyLabel={noAscentData}
              legend={gradeDistLegend}
              showYAxisScale
              accessibilityLabel={t('stats.gradeDistributionAria')}
            />
          </Card>

          {data.aggregatedFlashRedpointBars && (
            <>
              <SectionHeader title={t('stats.flashVsRedpoint')} />
              <Card style={styles.chartCard} accessibilityLabel={t('stats.flashRedpointAria')}>
                <GroupedBarChart
                  bars={data.aggregatedFlashRedpointBars}
                  emptyLabel={noAscentData}
                  legend={flashRedpointLegend}
                />
              </Card>
            </>
          )}

          {data.vPointsTimeline && (
            <>
              <SectionHeader title={t('stats.vPoints')} />
              <Card style={styles.chartCard}>
                <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.vpTotal}>
                  {t('stats.vPointsTotal', {
                    value: getCachedNumberFormat(undefined).format(data.vPointsTimeline.totalPoints),
                  })}
                </Text>
                <TotalAreaChart timeline={data.vPointsTimeline} color={brandColors.primary} emptyLabel={noAscentData} />
              </Card>
            </>
          )}
        </>
      )}
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  chartCard: { marginHorizontal: spacing[4] },
  tipInset: { marginHorizontal: spacing[4], marginBottom: spacing[3] },
  vpTotal: { marginBottom: spacing[2] },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 120,
    paddingHorizontal: spacing[8],
    gap: spacing[2],
  },
  emptyTitle: { opacity: 0.6, marginTop: spacing[3], textAlign: 'center' },
});
