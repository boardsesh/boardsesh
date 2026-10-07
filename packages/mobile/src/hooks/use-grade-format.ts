import { useCallback, useMemo } from 'react';
import { formatGrade, formatGradeByDifficultyId } from '@boardsesh/play-view';
import { useGradeDisplayFormatPreference } from '../lib/grade-format-preference';

/**
 * Mobile counterpart to web's `useGradeFormat` hook. Returns the current
 * grade-display preference and a bound formatter so consumers can render
 * `climb.difficulty` according to the user's choice. Pass the climb's board
 * name as the second argument wherever it is known: MoonBoard converts Font to
 * V differently (6A is V2), which changes both the label and the "+" suffix.
 *
 * Backed by AsyncStorage on mobile. The hook signature stays close to web's so
 * shared grade display consumers can format by the active user preference.
 */
export function useGradeFormat() {
  const { gradeFormat, loaded, setGradeFormat } = useGradeDisplayFormatPreference();
  const formatGradeWithPreference = useCallback(
    (difficulty: string | null | undefined, boardName?: string | null): string | null =>
      formatGrade(difficulty, gradeFormat, boardName),
    [gradeFormat],
  );
  const formatDifficultyIdWithPreference = useCallback(
    (difficultyId: number | null | undefined, boardName?: string | null): string | null =>
      formatGradeByDifficultyId(difficultyId, gradeFormat, boardName),
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
