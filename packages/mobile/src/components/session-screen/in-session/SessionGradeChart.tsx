import { useMemo } from 'react';
import type { SessionGradeDistributionItem } from '@boardsesh/shared-schema';
import { StackedBarChart } from '../../you/YouCharts';
import { buildSessionGradeBars } from '../../you/profile-chart-colors';
import { useGradeFormat } from '../../../hooks/use-grade-format';

type SessionGradeChartProps = {
  distribution: SessionGradeDistributionItem[];
};

/**
 * Grade distribution for the live in-session view. Reuses the same vivid
 * grade-coloured bars as the activity feed (SessionFeedCard): each grade bar is
 * the total ascents for that grade drawn in the grade's own colour, so the
 * chart reads as a colourful grade pyramid. Returns null when there's nothing
 * logged yet.
 */
export function SessionGradeChart({ distribution }: SessionGradeChartProps) {
  const { formatGrade } = useGradeFormat();
  const bars = useMemo(() => buildSessionGradeBars(distribution, formatGrade), [distribution, formatGrade]);

  if (!bars) return null;

  return <StackedBarChart bars={bars} colorBy="grade" height={120} fitYAxisToData />;
}
