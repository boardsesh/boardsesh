import { hashKey } from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  GET_CLIMB_LOST_HOLDS,
  type ClimbLostHold,
  type GetClimbLostHoldsQueryResponse,
  type GetClimbLostHoldsQueryVariables,
} from '@boardsesh/graphql/operations';
import { useHttpFiniteQuery } from '../use-http-finite-query';
import { useHttpQueryScope } from '../use-http-query-scope';

export const CLIMB_LOST_HOLDS_QUERY_KEY = ['climbLostHolds'] as const;

/** Where the lost holds stand: on their way, here, or not coming (no signal). */
export type ClimbLostHoldsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; lostHolds: readonly ClimbLostHold[] }
  | { status: 'unavailable' };

const IDLE: ClimbLostHoldsState = { status: 'idle' };
const LOADING: ClimbLostHoldsState = { status: 'loading' };
const UNAVAILABLE: ClimbLostHoldsState = { status: 'unavailable' };

// Restrictive observer provenance, never network authority or cached GraphQL shape.
type LostHoldsSelection = ClimbLostHold[] | Readonly<{ inputKey: string; rows: ClimbLostHold[] }>;

/**
 * Where the holds a spray climb lost used to be, for the remix editor's grey
 * rings.
 *
 * Network only, on purpose: the offline mirror keeps the count
 * (`missing_hold_count`) but not the hold history, so there is nothing local to
 * answer from. `networkMode: 'always'` makes a request with no signal fail at
 * once instead of pausing, and the editor then draws no rings rather than
 * waiting on them.
 *
 * `variables` null disables it: a catalogue board, an intact climb, a fresh climb.
 */
export function useClimbLostHolds(variables: GetClimbLostHoldsQueryVariables | null): ClimbLostHoldsState {
  const scope = useHttpQueryScope();
  const originalVariables = useMemo(
    () => (scope.scoped && variables ? Object.freeze({ ...variables }) : variables),
    [
      scope.scoped,
      variables,
      variables?.boardName,
      variables?.layoutId,
      variables?.sizeId,
      variables?.setIds,
      variables?.angle,
      variables?.climbUuid,
    ],
  );
  const inputKey = hashKey(scope.key([...CLIMB_LOST_HOLDS_QUERY_KEY, originalVariables]));
  const query = useHttpFiniteQuery<GetClimbLostHoldsQueryResponse, LostHoldsSelection>({
    queryKey: [...CLIMB_LOST_HOLDS_QUERY_KEY, originalVariables],
    queryFn: (operation) => operation.request<GetClimbLostHoldsQueryResponse>(GET_CLIMB_LOST_HOLDS, originalVariables!),
    select: scope.scoped
      ? (data) => Object.freeze({ inputKey, rows: data.climb?.lostHolds ?? [] })
      : (data) => data.climb?.lostHolds ?? [],
    enabled: variables !== null,
    networkMode: 'always',
    retry: 1,
    staleTime: 60 * 1000,
  });
  const disabled = variables === null;
  const { data: selection, isError, isFetching } = query;
  // QueryObserver can retain an old select result after a select error and a
  // key change. Only the original view AND complete original input may project it.
  const lostHolds = scope.scoped
    ? selection && !Array.isArray(selection) && selection.inputKey === inputKey
      ? selection.rows
      : undefined
    : (selection as ClimbLostHold[] | undefined);
  const retainedOtherInput = scope.scoped && selection && !Array.isArray(selection) && selection.inputKey !== inputKey;
  // One object per answer, so a consumer's memo keyed on it only re-runs when
  // the answer changes.
  return useMemo<ClimbLostHoldsState>(() => {
    if (disabled) return IDLE;
    if (retainedOtherInput && isFetching) return LOADING;
    if (lostHolds) return { status: 'ready', lostHolds };
    if (isError) return UNAVAILABLE;
    return LOADING;
  }, [disabled, lostHolds, isError, retainedOtherInput, isFetching]);
}
