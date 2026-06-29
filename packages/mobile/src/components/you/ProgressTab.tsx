import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { View, RefreshControl, ScrollView, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { useYouProfileData } from '../../lib/graphql/hooks';
import { Text } from '../Text';
import { ScreenTitle } from '../ScreenTitle';
import { Icon } from '../Icon';
import { Card } from '../Card';
import { SectionHeader } from '../SectionHeader';
import { CollapsibleSection } from '../CollapsibleSection';
import { ActivityIndicator } from '../ActivityIndicator';
import { ProfileBetaShelf } from './ProfileBetaShelf';
import { HeroCeilingCard } from './HeroCeilingCard';
import { ProgressControlBar } from './ProgressControlBar';
import { ProgressGlanceGrid } from './ProgressGlanceGrid';
import {
  StackedBarChart,
  GroupedBarChart,
  TotalAreaChart,
  RunningMaxLineChart,
  type ChartLegendItem,
} from './YouCharts';
import { ActivityHeatmap } from './ActivityHeatmap';
import { ProjectingCard } from './ProjectingCard';
import { AngleBreakdownChart } from './AngleBreakdownChart';
import { WallRhythmGrid } from './WallRhythmGrid';
import { GradeMilestonesTimeline } from './GradeMilestonesTimeline';
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
  /** Whether the viewer is looking at their OWN profile. Drives second-person
   *  hero copy ("your last send", "welcome back"); a stranger's profile gets the
   *  neutral wording. Defaults to true (the own-profile tab). */
  isSelf?: boolean;
};

export const ProgressTab = memo(function ProgressTab({
  data,
  topInset,
  screenTitle,
  userId,
  isSelf = true,
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

  // Inline control-bar reset → back to all-time / all-boards (the setters are
  // stable useState updaters, so this stays referentially stable).
  const { setTimeframe, setSelectedBoard } = data;
  const handleResetFilters = useCallback(() => {
    setTimeframe('all');
    setSelectedBoard('all');
  }, [setTimeframe, setSelectedBoard]);

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
          {/* Grade-tinted hero: the climber's ceiling, streak, and where they
              stand — the screenshot-worthy top of the page. */}
          <HeroCeilingCard
            hardestSend={data.hardestSend}
            streaks={data.streaks}
            lastSendGap={data.lastSendGap}
            totalAscents={totalAscents}
            layoutPercentages={data.statisticsSummary.layoutPercentages}
            isSelf={isSelf}
          />

          {/* Inline timeframe (+ board) filter — scopes every section below. */}
          <View style={styles.controlBar}>
            <ProgressControlBar
              timeframe={data.timeframe}
              onSelectTimeframe={setTimeframe}
              selectedBoard={data.selectedBoard}
              onSelectBoard={setSelectedBoard}
              hasActiveFilters={data.hasActiveFilters}
              onReset={handleResetFilters}
              layoutPercentages={data.statisticsSummary.layoutPercentages}
            />
          </View>

          {/* 2×2 trophy grid: streak · biggest fight · benchmarks · this month. */}
          <View style={styles.glanceGrid}>
            <ProgressGlanceGrid
              streaks={data.streaks}
              projectingStats={data.projectingStats}
              benchmarkSummary={data.benchmarkSummary}
              activeDaysDelta={data.activeDaysDelta}
              totalAscents={totalAscents}
            />
          </View>

          {/* Recent beta videos shelf — proven the most-tapped profile content,
              so it sits right under the glance grid. Hidden when none shared. */}
          {userId ? <ProfileBetaShelf userId={userId} /> : null}

          {/* Your biggest fights — the tries-to-send histogram + biggest project.
              Hidden until a hard-won send (≥4 tries) is worth featuring. */}
          {data.projectingStats.unlocked && (
            <>
              <SectionHeader title={t('sections.biggestFights')} />
              <Card style={styles.chartCard}>
                <ProjectingCard projectingStats={data.projectingStats} />
              </Card>
            </>
          )}

          {/* Grade pyramid — the existing grade × layout distribution, with a
              "next project" nudge toward the thin grade above the modal grade. */}
          <SectionHeader title={t('sections.gradePyramid')} />
          <Card style={styles.chartCard}>
            {data.nextProjectGrade ? (
              <Text variant="footnote" color={brandColors.primary} style={styles.nextProject}>
                {t('charts.nextProject', { grade: data.nextProjectGrade.label })}
              </Text>
            ) : null}
            <StackedBarChart
              bars={data.aggregatedStackedBars?.bars ?? null}
              colorBy="layout"
              emptyLabel={noAscentData}
              legend={gradeDistLegend}
              showYAxisScale
              accessibilityLabel={t('stats.gradeDistributionAria')}
            />
          </Card>

          {data.angleBreakdown && (
            <>
              <SectionHeader title={t('sections.yourAngle')} />
              <Card style={styles.chartCard}>
                <AngleBreakdownChart breakdown={data.angleBreakdown} />
              </Card>
            </>
          )}

          {data.wallRhythm && (
            <>
              <SectionHeader title={t('sections.wallRhythm')} />
              <Card style={styles.chartCard}>
                <WallRhythmGrid rhythm={data.wallRhythm} />
              </Card>
            </>
          )}

          {data.activityHeatmap && (
            <>
              <SectionHeader title={t('stats.calendar')} />
              <Card style={styles.chartCard}>
                <ActivityHeatmap heatmap={data.activityHeatmap} streak={data.streaks} />
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

          {data.runningMaxCeiling && (
            <>
              <SectionHeader title={t('sections.ceilingOverTime')} />
              <Card
                style={styles.chartCard}
                accessibilityLabel={t('charts.ceilingA11y', { grade: data.runningMaxCeiling.currentLabel })}
              >
                <RunningMaxLineChart
                  ceiling={data.runningMaxCeiling}
                  color={brandColors.primary}
                  emptyLabel={noAscentData}
                />
              </Card>
            </>
          )}

          {data.gradeMilestones.length > 0 && (
            <>
              <SectionHeader title={t('sections.gradeMilestones')} />
              <Card style={styles.chartCard}>
                <GradeMilestonesTimeline milestones={data.gradeMilestones} />
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

          {/* Supporting curves — demoted into collapsed sections near the bottom;
              the progression story is carried by the ceiling chart above. */}
          {data.vPointsTimeline && (
            <View style={styles.collapsible}>
              <CollapsibleSection title={t('stats.vPoints')} defaultExpanded={false}>
                <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.vpTotal}>
                  {t('stats.vPointsTotal', { value: data.vPointsTimeline.totalPoints.toLocaleString() })}
                </Text>
                <TotalAreaChart timeline={data.vPointsTimeline} color={brandColors.primary} emptyLabel={noAscentData} />
              </CollapsibleSection>
            </View>
          )}

          {data.aggregatedFlashRedpointBars && (
            <View style={styles.collapsible}>
              <CollapsibleSection title={t('stats.flashVsRedpoint')} defaultExpanded={false}>
                <GroupedBarChart
                  bars={data.aggregatedFlashRedpointBars}
                  emptyLabel={noAscentData}
                  legend={flashRedpointLegend}
                />
              </CollapsibleSection>
            </View>
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
  controlBar: { marginTop: spacing[4] },
  glanceGrid: { marginTop: spacing[4] },
  collapsible: { marginHorizontal: spacing[4], marginTop: spacing[6] },
  nextProject: { marginBottom: spacing[3], fontWeight: '600' },
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
