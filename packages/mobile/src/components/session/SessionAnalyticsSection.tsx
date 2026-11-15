import type { ComponentProps } from 'react';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { SessionAnalyticsSectionView } from './SessionAnalyticsSectionView';
export function SessionAnalyticsSection(
  props: Omit<ComponentProps<typeof SessionAnalyticsSectionView>, 'formatAnyBoardGrade'>,
) {
  const { formatGrade } = useGradeFormat();
  return <SessionAnalyticsSectionView {...props} formatAnyBoardGrade={formatGrade} />;
}
