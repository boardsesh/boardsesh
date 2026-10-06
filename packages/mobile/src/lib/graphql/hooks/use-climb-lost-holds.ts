import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  GET_CLIMB_LOST_HOLDS,
  type ClimbLostHold,
  type GetClimbLostHoldsQueryResponse,
  type GetClimbLostHoldsQueryVariables,
} from '@boardsesh/graphql/operations';
import { getHttpClient } from '../client';

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

/**
 * The geometry of the holds a spray climb lost to a reset (#5493).
 *
 * Network only, on purpose: the offline mirror keeps the count
 * (`missing_hold_count`) but not the hold history, so there is nothing local to
 * answer from. `networkMode: 'always'` makes a request with no signal fail at
 * once instead of pausing, and the editor then says the rings need a connection
 * rather than spinning.
 *
 * `variables` null disables it — a catalogue board, an intact climb, a fresh climb.
 */
export function useClimbLostHolds(variables: GetClimbLostHoldsQueryVariables | null): ClimbLostHoldsState {
  const query = useQuery({
    queryKey: [...CLIMB_LOST_HOLDS_QUERY_KEY, variables],
    queryFn: () => getHttpClient().request<GetClimbLostHoldsQueryResponse>(GET_CLIMB_LOST_HOLDS, variables!),
    select: (data) => data.climb?.lostHolds ?? [],
    enabled: variables !== null,
    networkMode: 'always',
    retry: 1,
    staleTime: 60 * 1000,
  });
  const disabled = variables === null;
  const { data: lostHolds, isError } = query;
  // One object per answer, so a consumer's memo keyed on it only re-runs when
  // the answer changes.
  return useMemo<ClimbLostHoldsState>(() => {
    if (disabled) return IDLE;
    if (lostHolds) return { status: 'ready', lostHolds };
    if (isError) return UNAVAILABLE;
    return LOADING;
  }, [disabled, lostHolds, isError]);
}
