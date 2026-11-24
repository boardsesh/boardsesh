// The walls a gym already has (#8151), for the gym-first create flow's wall list
// and the builder's "already has" sheet.
//
// Lives in its own module rather than in the `hooks` barrel so it can be unit
// tested (the barrel statically reaches react-native's Flow source, see
// `use-gym-boards.ts`). Re-exported from the barrel so callers keep one path.

import { useQuery } from '@tanstack/react-query';
import type { ExistingWallCandidates, ExistingWallCandidatesInput } from '@boardsesh/shared-schema';
import {
  EXISTING_WALL_CANDIDATES,
  type ExistingWallCandidatesQueryResponse,
} from '@boardsesh/graphql/operations/boards';
import { getHttpClient } from '../client';

/**
 * A gym's walls change when somebody adds or links one, so a minute is fresh
 * enough for a screen a climber reads once. Short, because the answer decides
 * whether they add a board, and a stale "no walls yet" is the expensive mistake.
 */
const EXISTING_WALL_CANDIDATES_STALE_TIME_MS = 60 * 1000;

export const EXISTING_WALL_CANDIDATES_QUERY_KEY = ['existingWallCandidates'] as const;

export function existingWallCandidatesQueryKey(input: ExistingWallCandidatesInput | null) {
  return [...EXISTING_WALL_CANDIDATES_QUERY_KEY, input] as const;
}

/**
 * One lookup, outside a hook: the builder runs it from its submit handler after
 * `createBoard` refuses with BOARD_EXISTING_WALLS. Throws on failure: the
 * caller must never read a failed lookup as "no walls".
 */
export async function fetchExistingWallCandidates(input: ExistingWallCandidatesInput): Promise<ExistingWallCandidates> {
  const response = await getHttpClient().request<ExistingWallCandidatesQueryResponse>(EXISTING_WALL_CANDIDATES, {
    input,
  });
  return response.existingWallCandidates;
}

/**
 * The gym's walls of one board type, best match first (the server ranks them
 * with `compareWallCandidates`). Disabled until both a gym and a board type are
 * known. A failure stays a failure (`isError`): the screen shows Try again,
 * never an empty list.
 */
export function useExistingWallCandidates(input: ExistingWallCandidatesInput | null, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: existingWallCandidatesQueryKey(input),
    queryFn: () => {
      if (!input) throw new Error('existingWallCandidates needs a gym and a board type');
      return fetchExistingWallCandidates(input);
    },
    enabled: (options?.enabled ?? true) && input != null,
    staleTime: EXISTING_WALL_CANDIDATES_STALE_TIME_MS,
    // One retry: the rate limit is 20 a minute and a climber can tap Try again.
    retry: 1,
  });
}
