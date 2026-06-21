import { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { SessionGradeDistributionItem } from '@boardsesh/shared-schema';
import { Card } from '../Card';
import { SectionHeader } from '../SectionHeader';
import { StackedBarChart } from '../you/YouCharts';
import { buildSessionGradeBars } from '../you/profile-chart-colors';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { spacing } from '../../theme/tokens';

/**
 * Per-session grade breakdown: a clean grade pyramid. Each bar is a single solid
 * segment in that grade's own vivid colour (height = ascent volume), so the chart
 * reads at a glance and the grade hue is the only colour key. Flash counts live in
 * the summary line and per-row glyphs; tapping a bar still surfaces its total.
 * Renders nothing when there's no data.
 */
export function SessionAnalyticsSection({ gradeDistribution }: { gradeDistribution: SessionGradeDistributionItem[] }) {
  const { t } = useTranslation('profile');
  // Match the grade format the Progress tab / useYouProfileData uses so a
  // session's chart reads identically to the profile's.
  const { formatGrade } = useGradeFormat();

  // No splitFlash → each grade bar is one solid `gradeBadgeColor` segment.
  const gradeBars = useMemo(
    () => buildSessionGradeBars(gradeDistribution, formatGrade),
    [gradeDistribution, formatGrade],
  );

  // `buildSessionGradeBars` returns null for an empty or all-zero distribution,
  // so this covers both the no-distribution and no-ascent cases.
  if (!gradeBars) return null;

  return (
    <View>
      <SectionHeader title={t('stats.gradeDistribution')} />
      <Card style={styles.chartCard}>
        <StackedBarChart bars={gradeBars} colorBy="grade" fitYAxisToData />
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  chartCard: { marginHorizontal: spacing[4] },
});
