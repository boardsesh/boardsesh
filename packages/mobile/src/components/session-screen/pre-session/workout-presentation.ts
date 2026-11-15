import { useMemo } from 'react';
import { useAuth } from '../../../providers/auth-provider';
import { useWorkoutTimedBlocksFlag } from '../../../providers/feature-flags-provider';
import { useGradeFormat } from '../../../hooks/use-grade-format';
import { timedWorkoutBlocksOffered } from './workout-blocks';
export type WorkoutPresentation = {
  isAuthenticated: boolean;
  timedBlocksOffered: boolean;
  formatGradeByDifficultyId: ReturnType<typeof useGradeFormat>['formatGradeByDifficultyId'];
};
export function useWorkoutPresentation(): WorkoutPresentation {
  const { isAuthenticated } = useAuth();
  const offered = timedWorkoutBlocksOffered(useWorkoutTimedBlocksFlag());
  const { formatGradeByDifficultyId } = useGradeFormat();
  return useMemo(
    () => ({ isAuthenticated, timedBlocksOffered: offered, formatGradeByDifficultyId }),
    [isAuthenticated, offered, formatGradeByDifficultyId],
  );
}
