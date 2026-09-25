import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import { useBoardseshGradesActive } from '../../../hooks/use-display-grade';
import { useBoardseshGradesPreference } from '../../boardsesh-grades-preference';

/**
 * Point a climb search's grade-range filter (and its difficulty sort) at the
 * grade the list labels climbs with (issues #5643, #5752, #5753). With Boardsesh
 * grades on, a row shows its Boardsesh grade, so a V4 filter has to key on that
 * grade too, or it returns rows labelled V3.
 *
 * Off leaves the input untouched: an omitted `gradeSource` is UPSTREAM on the
 * server and on the device, so the query key and the search-cache key stay what
 * they were for every climber who has not opted in. On, the field is part of the
 * input and so of the React Query key, which is what refetches the list when the
 * climber flips the preference.
 *
 * Attached only when the search has a grade bound or sorts by difficulty — the
 * only two places the source reaches SQL — so an unfiltered browse keeps one
 * query key and one server cache key whatever the preference. A grade bound of
 * 0 is the "unset" value (the server collapses it the same way), so it does not
 * count. `mapSearchInputToParams` applies the same rule on the server.
 *
 * The output is normalised either way: when the source cannot matter, any
 * `gradeSource` the caller already put on the input is stripped, so two inputs
 * that search the same way always hash to the same key.
 */
export function withGradeSource<TInput extends ClimbSearchInput>(
  input: TInput,
  boardseshGradesActive: boolean,
): TInput {
  const gradeSourceMatters = !!input.minGrade || !!input.maxGrade || input.sortBy === 'difficulty';
  if (boardseshGradesActive && gradeSourceMatters) return { ...input, gradeSource: 'BOARDSESH' };
  if (input.gradeSource === undefined) return input;
  const { gradeSource: _ignoredGradeSource, ...inputWithoutGradeSource } = input;
  return inputWithoutGradeSource as TInput;
}

/**
 * Whether searches should send the Boardsesh grade source: `useBoardseshGradesActive`
 * (flag AND preference), and only once the stored preference has been read. Until
 * then the search goes out on the upstream grade, the default every climber starts
 * with, rather than guessing.
 */
export function useSearchGradeSourceActive(): boolean {
  const boardseshGradesActive = useBoardseshGradesActive();
  const { loaded } = useBoardseshGradesPreference();
  return boardseshGradesActive && loaded;
}

/** `withGradeSource` bound to `useSearchGradeSourceActive`. */
export function useGradeSourceSearchInput<TInput extends ClimbSearchInput>(input: TInput): TInput {
  return withGradeSource(input, useSearchGradeSourceActive());
}
