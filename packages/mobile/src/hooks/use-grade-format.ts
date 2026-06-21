import { useCallback, useMemo } from 'react';
import { formatGrade, formatGradeByDifficultyId } from '@boardsesh/play-view';
import { useGradeDisplayFormatPreference } from '../lib/grade-format-preference';

/**
 * Mobile counterpart to web's `useGradeFormat` hook. Returns the current
 * grade-display preference and a bound formatter so consumers can render
 * `climb.difficulty` according to the user's choice.
 *
 * Backed by AsyncStorage on mobile. The hook signature stays close to web's so
 * shared grade display consumers can format by the active user preference.
 */
export function useGradeFormat() {
  const { gradeFormat, loaded, setGradeFormat } = useGradeDisplayFormatPreference();
  const formatGradeWithPreference = useCallback(
    (difficulty: string | null | undefined): string | null => formatGrade(difficulty, gradeFormat),
    [gradeFormat],
  );
  const formatDifficultyIdWithPreference = useCallback(
    (difficultyId: number | null | undefined): string | null => formatGradeByDifficultyId(difficultyId, gradeFormat),
    [gradeFormat],
  );

  return useMemo(
    () => ({
      gradeFormat,
      setGradeFormat,
      loaded,
      formatGrade: formatGradeWithPreference,
      formatGradeByDifficultyId: formatDifficultyIdWithPreference,
    }),
    [gradeFormat, setGradeFormat, loaded, formatGradeWithPreference, formatDifficultyIdWithPreference],
  );
}
