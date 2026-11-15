import { memo, useMemo } from 'react';
import { useBoardseshGradesActive } from '../../hooks/use-display-grade';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useClimbMenu } from '../climb-actions/ClimbActionsMenu';
import { LogbookRowView, type LogbookRowViewProps } from './LogbookRowView';
type Props = Omit<LogbookRowViewProps, 'menu' | 'boardseshActive' | 'formatGrade' | 'formatGradeByDifficultyId'>;
export const LogbookRow = memo(function LogbookRow(props: Props) {
  const { formatGrade, formatGradeByDifficultyId } = useGradeFormat();
  const boardseshActive = useBoardseshGradesActive();
  const { ascent, onOpenActions } = props;
  const target = useMemo(() => onOpenActions?.(ascent) ?? null, [onOpenActions, ascent]);
  const menu = useClimbMenu(target);
  return (
    <LogbookRowView
      {...props}
      menu={menu}
      boardseshActive={boardseshActive}
      formatGrade={formatGrade}
      formatGradeByDifficultyId={formatGradeByDifficultyId}
    />
  );
});
