import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { View, RefreshControl, ScrollView, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { useYouProfileData } from '../../lib/graphql/hooks';
import { Text } from '../Text';
import { ScreenTitle } from '../ScreenTitle';
import { Icon } from '../Icon';
import { Card } from '../Card';
import { SectionHeader } from '../SectionHeader';
import { ActivityIndicator } from '../ActivityIndicator';
import { ProfileBetaShelf } from './ProfileBetaShelf';
import { StatsSummaryCard } from './StatsSummaryCard';
import { StackedBarChart, GroupedBarChart, TotalAreaChart, type ChartLegendItem } from './YouCharts';
import { ActivityHeatmap } from './ActivityHeatmap';
import { LayoutShareDonut } from './LayoutShareDonut';
import { layoutChartColor, flashRedpointColor } from './profile-chart-colors';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { OnboardingTipBanner } from '../onboarding/OnboardingTipBanner';
import { hasSeenTip, markTipSeen } from '../../lib/onboarding/onboarding-storage';
import { ONBOARDING_TIP_RECORD_KEY } from '@boardsesh/key-value-storage';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

type YouData = ReturnType<typeof useYouProfileData>;

type ProgressTabProps = {
  data: YouData;
  /** Measured chrome height — the scroll content insets its top by this so the
   *  first card rests below the floating chrome and the rest scroll under it. */
  topInset: number;
  /** In-body identity title (the own "You" tab passes "You"). Omitted on another
   *  climber's profile, where the name lives in the public-profile header. */
  screenTitle?: string;
  /** Climber whose beta-video shelf to show above the stats. Omit to hide it
   *  (e.g. before the viewer's own id resolves). */
  userId?: string;
};

export const ProgressTab = memo(function ProgressTab({ data, topInset, screenTitle, userId }: ProgressTabProps) {
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
      {/* The screen's identity (when supplied), in-body under the floating chrome —
          collapses into the header capsule as it scrolls up behind the glass.
          ScreenTitle hides itself on Material (the M3 app bar owns the title).
          Omitted on another climber's profile, where the name lives in the header. */}
      {screenTitle ? <ScreenTitle style={styles.screenTitle}>{screenTitle}</ScreenTitle> : null}

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
        <View style={styles.empty}>
          <Icon name="chart.bar" size={48} color={systemColors.tertiaryLabel} />
          <Text variant="headline" style={styles.emptyTitle}>
            {tYou('mobile.progress.empty')}
          </Text>
        </View>
      ) : (
        <>
          <SectionHeader title={t('stats.summary')} />
          <StatsSummaryCard
            statisticsSummary={data.statisticsSummary}
            hardestSend={data.hardestSend}
            hardestFlash={data.hardestFlash}
            percentile={data.percentile}
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
                  {t('stats.vPointsTotal', { value: data.vPointsTimeline.totalPoints.toLocaleString() })}
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
  screenTitle: {
    paddingHorizontal: spacing[4],
    paddingTop: 0,
    paddingBottom: spacing[2],
  },
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
