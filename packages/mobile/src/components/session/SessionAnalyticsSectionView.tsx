import type { SessionGradeDistributionItem } from '@boardsesh/shared-schema';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { spacing } from '../../theme/tokens';
import { Card } from '../Card';
import { SectionHeader } from '../SectionHeader';
import { StackedBarChart } from '../you/YouCharts';
import { buildSessionGradeBars } from '../you/profile-chart-colors';

/**
 * Per-session grade breakdown: a clean grade pyramid. Each bar is a single solid
 * segment in that grade's own vivid colour (height = ascent volume), so the chart
 * reads at a glance and the grade hue is the only colour key. Flash counts live in
 * the summary line and per-row glyphs; tapping a bar still surfaces its total.
 * Renders nothing when there's no data.
 */
export function SessionAnalyticsSectionView({
  formatAnyBoardGrade,
  gradeDistribution,
  boardName,
}: {
  gradeDistribution: SessionGradeDistributionItem[];
  formatAnyBoardGrade: (grade: string | null | undefined, board?: string | null) => string | null;
  /** The session's only board, or null when it spans several. */
  boardName?: string | null;
}) {
  const { t } = useTranslation('profile');
  const { t: tSession } = useTranslation('session');
  // Match the grade format the Progress tab / useYouProfileData uses so a
  // session's chart reads identically to the profile's.
  const formatGrade = useCallback(
    (difficulty: string | null | undefined) => formatAnyBoardGrade(difficulty, boardName),
    [formatAnyBoardGrade, boardName],
  );

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
        <StackedBarChart
          testID="session-grade-chart"
          bars={gradeBars}
          colorBy="grade"
          gradeAxis
          height={112}
          fitYAxisToData
          accessibilityLabel={gradeBars
            .map(
              (bar) =>
                `${bar.label}: ${tSession('detail.sendsCount', { count: bar.segments.reduce((total, segment) => total + segment.value, 0) })}`,
            )
            .join(', ')}
        />
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  chartCard: { marginHorizontal: spacing[4] },
});
