import { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { deriveProfileViewModel } from '@boardsesh/profile-stats';
import type { SessionDetailTick } from '@boardsesh/shared-schema';
import { Card } from '../Card';
import { SectionHeader } from '../SectionHeader';
import { StackedBarChart, GroupedBarChart, type ChartLegendItem } from '../you/YouCharts';
import { layoutChartColor, flashRedpointColor } from '../you/profile-chart-colors';
import { sessionTicksToLogbook } from '../../lib/session-tick-mapping';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { spacing } from '../../theme/tokens';

/**
 * Rich per-session breakdown: maps the session's ticks into the shared
 * `deriveProfileViewModel` aggregation (timeframe 'all', all boards) and renders
 * the grade-distribution + flash-vs-redpoint charts, mirroring the Progress tab.
 * Renders nothing when there are no ticks.
 */
export function SessionAnalyticsSection({ ticks }: { ticks: SessionDetailTick[] }) {
  const { t } = useTranslation('profile');
  // Match the grade format the Progress tab / useYouProfileData uses so a
  // session's charts read identically to the profile's.
  const { gradeFormat } = useGradeFormat();

  const viewModel = useMemo(() => {
    if (ticks.length === 0) return null;
    return deriveProfileViewModel({
      allBoardsTicks: sessionTicksToLogbook(ticks),
      selectedBoard: 'all',
      timeframe: 'all',
      fromDate: '',
      toDate: '',
      gradeFormat,
      profileStats: null,
    });
  }, [ticks, gradeFormat]);

  const gradeDistLegend = useMemo<ChartLegendItem[] | undefined>(
    () => viewModel?.aggregatedStackedBars?.legend.map((entry) => ({ label: entry.label, color: layoutChartColor(entry.key) })),
    [viewModel],
  );
  const flashRedpointLegend = useMemo<ChartLegendItem[] | undefined>(
    () =>
      viewModel?.aggregatedFlashRedpointBars?.[0]?.values.map((value) => ({
        label: value.label,
        color: flashRedpointColor(value.key),
      })),
    [viewModel],
  );

  if (!viewModel) return null;

  return (
    <View>
      <SectionHeader title={t('stats.gradeDistribution')} />
      <Card style={styles.chartCard}>
        <StackedBarChart bars={viewModel.aggregatedStackedBars?.bars ?? null} colorBy="layout" legend={gradeDistLegend} />
      </Card>

      {viewModel.aggregatedFlashRedpointBars && (
        <>
          <SectionHeader title={t('stats.flashVsRedpoint')} />
          <Card style={styles.chartCard}>
            <GroupedBarChart bars={viewModel.aggregatedFlashRedpointBars} legend={flashRedpointLegend} />
          </Card>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  chartCard: { marginHorizontal: spacing[4] },
});
