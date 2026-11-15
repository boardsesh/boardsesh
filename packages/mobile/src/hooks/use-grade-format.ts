import { createContext, createElement, useContext, useCallback, useMemo, type ReactNode } from 'react';
import { formatGrade, formatGradeByDifficultyId, type GradeDisplayFormat } from '@boardsesh/play-view';
import { useGradeDisplayFormatPreference } from '../lib/grade-format-preference';

const GradeFormatContext = createContext<GradeDisplayFormat | null>(null);
/** Bind a presentation subtree to a grade format without reading or writing saved preferences. */
export function GradeFormatProvider({
  gradeFormat,
  children,
}: {
  gradeFormat: GradeDisplayFormat;
  children: ReactNode;
}) {
  return createElement(GradeFormatContext.Provider, { value: gradeFormat }, children);
}
const keepInjectedGradeFormat = (_format: GradeDisplayFormat) => {};

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
  const injectedFormat = useContext(GradeFormatContext);
  const saved = useGradeDisplayFormatPreference(injectedFormat === null);
  const gradeFormat = injectedFormat ?? saved.gradeFormat;
  const loaded = injectedFormat !== null || saved.loaded;
  const setGradeFormat = injectedFormat === null ? saved.setGradeFormat : keepInjectedGradeFormat;
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
