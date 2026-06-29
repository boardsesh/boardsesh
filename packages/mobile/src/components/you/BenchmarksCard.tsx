import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { RawBenchmarkSummary } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Card } from '../Card';
import { StackedBarChart } from './YouCharts';
import type { ColoredBar } from './profile-chart-colors';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

type BenchmarksCardProps = {
  summary: RawBenchmarkSummary;
  /** Benchmark-only grade distribution (single grade segment per bar), or null. */
  gradeBars: ColoredBar[] | null;
};

/**
 * Benchmarks (test-pieces) sent — count + hardest, with a benchmark-only grade
 * distribution reusing the grade-coloured StackedBarChart. Hidden by the parent
 * when the count is 0. Neutral copy (renders on any climber's profile).
 */
export function BenchmarksCard({ summary, gradeBars }: BenchmarksCardProps) {
  const { t } = useTranslation('profile');
  const { systemColors, brandColors } = useTheme();

  return (
    <Card style={styles.card}>
      <View style={styles.header}>
        <Icon name="benchmark" size={16} color={brandColors.accent} />
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {summary.hardestLabel
            ? t('charts.benchmarksSummary', { count: summary.count, grade: summary.hardestLabel })
            : t('charts.benchmarksCount', { count: summary.count })}
        </Text>
      </View>
      {gradeBars && gradeBars.length > 0 ? (
        <StackedBarChart
          bars={gradeBars}
          colorBy="grade"
          height={140}
          interactive={false}
          zoomable={false}
          accessibilityLabel={t('charts.benchmarksCardA11y', { count: summary.count })}
        />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing[4],
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    marginBottom: spacing[2],
  },
});
