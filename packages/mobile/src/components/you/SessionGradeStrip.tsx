import { useGradeFormat } from '../../hooks/use-grade-format';
import { SessionGradeStripView, type SessionGradeStripViewProps } from './SessionGradeStripView';

export function SessionGradeStrip(props: Omit<SessionGradeStripViewProps, 'formatAnyBoardGrade'>) {
  const { formatGrade } = useGradeFormat();
  return <SessionGradeStripView {...props} formatAnyBoardGrade={formatGrade} />;
}
