import { useGradeFormat } from '../../hooks/use-grade-format';
import { GradeTileView } from './session-stat-tile-views';
export { StatTile } from './session-stat-tile-views';
export function GradeTile({ grade, boardName }: { grade: string; boardName?: string | null }) {
  const { formatGrade } = useGradeFormat();
  return <GradeTileView grade={grade} displayGrade={formatGrade(grade, boardName) ?? grade} />;
}
