import { memo, useMemo } from 'react';
import { View, ScrollView, RefreshControl, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { useYouProfileData } from '../../lib/graphql/hooks';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Card } from '../Card';
import { SectionHeader } from '../SectionHeader';
import { ActivityIndicator } from '../ActivityIndicator';
import { StatsSummaryCard } from './StatsSummaryCard';
import { StackedBarChart, GroupedBarChart, TotalAreaChart, type ChartLegendItem } from './YouCharts';
import { layoutChartColor, flashRedpointColor } from './profile-chart-colors';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

type YouData = ReturnType<typeof useYouProfileData>;

export const ProgressTab = memo(function ProgressTab({ data }: { data: YouData }) {
  const { t } = useTranslation('profile');
  const { t: tYou } = useTranslation('you');
  const { systemColors, colorScheme, brandColors } = useTheme();
  const bottomChrome = useBottomChromeMetrics();
  const paddingBottom = bottomChrome.scrollBottomPadding + spacing[6];

  const totalAscents = data.statisticsSummary.totalAscents;
  const noAscentData = t('empty.noAscentData');

  // Legends so the layout-colored grade-distribution bars and the
  // flash-vs-redpoint pairs can be decoded (charts are color-only otherwise).
  const gradeDistLegend = useMemo<ChartLegendItem[] | undefined>(
    () =>
      data.aggregatedStackedBars?.legend.map((entry) => ({ label: entry.label, color: layoutChartColor(entry.key) })),
    [data.aggregatedStackedBars],
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
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.flex}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom }}
      refreshControl={
        <RefreshControl refreshing={data.refreshing} onRefresh={data.refetch} tintColor={brandColors.primary} />
      }
    >
      {totalAscents === 0 ? (
        <View style={styles.empty}>
          <Icon name="chart.bar" size={48} color={systemColors.tertiaryLabel} />
          <Text variant="headline" style={styles.emptyTitle}>
            {tYou('mobile.progress.empty')}
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.topGap} />
          <StatsSummaryCard
            statisticsSummary={data.statisticsSummary}
            hardestSend={data.hardestSend}
            hardestFlash={data.hardestFlash}
            percentile={data.percentile}
          />

          <SectionHeader title={t('stats.activity')} />
          <Card style={styles.chartCard}>
            {/* Weekly labels ("W23 '24") are wide, so cap to ~6 evenly-spaced
                markers — horizontal labels stay readable instead of colliding. */}
            <StackedBarChart bars={data.weeklyBars} colorBy="grade" emptyLabel={noAscentData} maxXLabels={6} />
          </Card>

          <SectionHeader title={t('stats.gradeDistribution')} />
          <Card style={styles.chartCard}>
            <StackedBarChart
              bars={data.aggregatedStackedBars?.bars ?? null}
              colorBy="layout"
              emptyLabel={noAscentData}
              legend={gradeDistLegend}
            />
          </Card>

          {data.aggregatedFlashRedpointBars && (
            <>
              <SectionHeader title={t('stats.flashVsRedpoint')} />
              <Card style={styles.chartCard}>
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
  topGap: { height: spacing[4] },
  chartCard: { marginHorizontal: spacing[4] },
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
