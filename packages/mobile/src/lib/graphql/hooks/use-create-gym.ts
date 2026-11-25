// Adding a gym from the app (the add-a-board wizard's "Add your gym"): the
// gyms already listed that look like the one being added, and the create
// itself. The server refuses a create that matches a listed gym the climber
// hasn't said is a different one (`GYM_SIMILAR_EXISTS`, read with
// `readSimilarGymsError`), and one past the per-account gym cap
// (`GYM_LIMIT_REACHED`, `isGymLimitError`).
//
// Its own module, not the `hooks` barrel, so the screen and its tests import
// it without reaching react-native's Flow source (see `use-gym-boards.ts`).

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateGymInput, FindSimilarGymsInput } from '@boardsesh/shared-schema';
import {
  CREATE_GYM,
  FIND_SIMILAR_GYMS,
  type CreateGymMutationResponse,
  type FindSimilarGymsQueryResponse,
} from '@boardsesh/graphql/operations/gyms';
import { getHttpClient } from '../client';

export const SIMILAR_GYMS_QUERY_KEY = ['similarGyms'] as const;

/**
 * The listed gyms that look like the one being added: the same name within
 * 5 km, a similar name within 1 km, anything within 150 m (the server's tiers,
 * at most five, nearest first). Null input (no name yet) runs nothing. The
 * last answer stays on screen while a changed name or pin refetches, so the
 * rows don't blink on every keystroke.
 */
export function useSimilarGyms(input: FindSimilarGymsInput | null, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...SIMILAR_GYMS_QUERY_KEY, input],
    queryFn: async ({ signal }) => {
      if (!input) throw new Error('findSimilarGyms needs a name');
      const response = await getHttpClient().request<FindSimilarGymsQueryResponse>({
        document: FIND_SIMILAR_GYMS,
        variables: { input },
        signal,
      });
      return response.findSimilarGyms;
    },
    enabled: (options?.enabled ?? true) && input !== null,
    placeholderData: keepPreviousData,
    // A hint, not a gate: Save is checked by the server either way.
    retry: false,
  });
}

/**
 * Create a gym the climber owns. A new gym shows up in the gym finders and the
 * climber's own gym lists, so those refetch; the similar-gyms answers do too,
 * since the new gym is now one of them.
 */
export function useCreateGym() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateGymInput) => {
      const response = await getHttpClient().request<CreateGymMutationResponse>(CREATE_GYM, { input });
      return response.createGym;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['nearbyGyms'] });
      void queryClient.invalidateQueries({ queryKey: ['myGyms'] });
      void queryClient.invalidateQueries({ queryKey: SIMILAR_GYMS_QUERY_KEY });
    },
  });
}
