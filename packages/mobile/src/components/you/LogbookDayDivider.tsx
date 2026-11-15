import { memo } from 'react';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useToday } from '../../hooks/use-today';
import { LogbookDayDividerView, type LogbookDayDividerViewProps } from './LogbookDayDividerView';
export { LogbookWallSubDivider } from './LogbookDayDividerView';
export const LogbookDayDivider = memo(function LogbookDayDivider(
  props: Omit<LogbookDayDividerViewProps, 'now' | 'formatGrade'>,
) {
  const { formatGrade } = useGradeFormat();
  const now = useToday().getTime();
  return <LogbookDayDividerView {...props} now={now} formatGrade={formatGrade} />;
});
