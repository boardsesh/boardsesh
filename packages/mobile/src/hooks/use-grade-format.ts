import { useMemo } from 'react';
import { formatGrade, type GradeDisplayFormat, DEFAULT_GRADE_DISPLAY_FORMAT } from '@boardsesh/play-view';

/**
 * Mobile counterpart to web's `useGradeFormat` hook. Returns the current
 * grade-display preference and a bound formatter so consumers can render
 * `climb.difficulty` according to the user's choice.
 *
 * Today the preference is hardcoded to V-grade — there's no settings UI on
 * mobile yet. The hook signature matches web's so a future PR adding the UI
 * + AsyncStorage backing just needs to flip the source of `gradeFormat`.
 */
export function useGradeFormat() {
  // TODO: persist via AsyncStorage and surface a toggle in More tab.
  const gradeFormat: GradeDisplayFormat = DEFAULT_GRADE_DISPLAY_FORMAT;
  // Empty deps: gradeFormat is a module-stable constant today, so the memoized
  // object never needs to rebuild. When AsyncStorage backing lands, replace
  // with [gradeFormat] and flip `loaded` to the actual hydration flag.
  return useMemo(
    () => ({
      gradeFormat,
      loaded: true,
      formatGrade: (difficulty: string | null | undefined) => formatGrade(difficulty, gradeFormat),
    }),
    [],
  );
}
