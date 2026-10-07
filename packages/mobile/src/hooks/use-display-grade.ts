import { useCallback, useMemo } from 'react';
import { useBoardseshGradeEnabled } from '../providers/feature-flags-provider';
import { useBoardseshGradesPreference } from '../lib/boardsesh-grades-preference';
import { useGradeFormat } from './use-grade-format';
import { resolveDisplayGrade, type BoardseshGradeFields, type DisplayGrade } from '../lib/boardsesh-grade-display';

/**
 * Whether a climb/tick should render its Boardsesh grade instead of the
 * legacy Aurora grade right now: the `boardsesh-grade` PostHog flag AND the
 * climber's own "Show Boardsesh grades" preference. The flag is a hard kill
 * switch — off wins even over a stale persisted `true` preference, so a
 * rollback instantly reverts everyone to the legacy grade with no local
 * migration needed.
 */
export function useBoardseshGradesActive(): boolean {
  const flagEnabled = useBoardseshGradeEnabled();
  const { enabled: preferenceEnabled } = useBoardseshGradesPreference();
  return flagEnabled && preferenceEnabled;
}

/**
 * The app-wide grade resolver for climb rows/headers: whether Boardsesh
 * grades are active, plus a stable `resolveGrade` callback that renders a
 * climb's label + colour per the current preference and grade-format
 * setting. Call this once per list/screen component (it's cheap, but
 * `resolveGrade` is meant to run per row, not be re-derived per row). Pass
 * the climb's board as `resolveGrade`'s second argument so MoonBoard climbs
 * read on MoonBoard's scale.
 */
export function useDisplayGrade(): {
  boardseshActive: boolean;
  resolveGrade: (
    climb: BoardseshGradeFields & { difficulty?: string | null },
    boardName?: string | null,
  ) => DisplayGrade;
} {
  const boardseshActive = useBoardseshGradesActive();
  const { gradeFormat } = useGradeFormat();

  const resolveGrade = useCallback(
    (climb: BoardseshGradeFields & { difficulty?: string | null }, boardName?: string | null): DisplayGrade =>
      resolveDisplayGrade(climb, { useBoardseshGrades: boardseshActive, gradeFormat, boardName }),
    [boardseshActive, gradeFormat],
  );

  return useMemo(() => ({ boardseshActive, resolveGrade }), [boardseshActive, resolveGrade]);
}
