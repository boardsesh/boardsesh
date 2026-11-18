import { useMemo } from 'react';
import { useAuth } from '../../../providers/auth-provider';
import { useGradeFormat } from '../../../hooks/use-grade-format';
export type WorkoutPresentation = {
  isAuthenticated: boolean;
  formatGradeByDifficultyId: ReturnType<typeof useGradeFormat>['formatGradeByDifficultyId'];
};
export function useWorkoutPresentation(): WorkoutPresentation {
  const { isAuthenticated } = useAuth();
  const { formatGradeByDifficultyId } = useGradeFormat();
  return useMemo(() => ({ isAuthenticated, formatGradeByDifficultyId }), [isAuthenticated, formatGradeByDifficultyId]);
}
