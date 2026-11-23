// The gym page's own reads and its one write (follow).
//
// Its own module, not the `hooks` barrel: the barrel can't be imported under
// Vitest (see the note above `fetchAllMyBoards`), and these have tests through
// the screen. The board list is the shared `useGymBoards` (the gym map's and
// the picker's roster), so the three surfaces share one cache entry.
//
// All online-only (docs/data/offline-reads.md, bucket 3): a gym's listing has
// no table on the phone. With no connection the screen shows the honest
// placard, never a stale copy dressed as current.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FOLLOW_GYM,
  GET_GYM,
  GET_GYM_BY_SLUG,
  GET_GYM_PENDING_CLAIM,
  UNFOLLOW_GYM,
  type FollowGymMutationResponse,
  type GetGymBySlugQueryResponse,
  type GetGymPendingClaimQueryResponse,
  type GetGymQueryResponse,
  type UnfollowGymMutationResponse,
} from '@boardsesh/graphql/operations/gyms';
import type { MyGymClaim } from '@boardsesh/shared-schema';
import { getHttpClient } from '../../lib/graphql/client';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The route takes a gym uuid (every in-app entry point) or a slug (a link someone pasted). */
export function isGymUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * The gym behind the route's param. A uuid reads under the same `['gym', uuid]`
 * key and raw shape as `useGym` (the edit screen), so the mutations that already
 * invalidate that key (a claim that came through, a board taken off the gym)
 * refresh this page too. A merged twin's old uuid or slug answers with the
 * surviving gym.
 */
export function useGymPageGym(param: string | null) {
  const gymUuid = param !== null && isGymUuid(param) ? param : null;
  const slug = param !== null && gymUuid === null ? param.toLowerCase() : null;
  const byUuid = useQuery({
    queryKey: ['gym', gymUuid],
    queryFn: () => getHttpClient().request<GetGymQueryResponse>(GET_GYM, { gymUuid }),
    select: (data) => data.gym,
    enabled: gymUuid !== null,
  });
  const bySlug = useQuery({
    queryKey: ['gymBySlug', slug],
    queryFn: () => getHttpClient().request<GetGymBySlugQueryResponse>(GET_GYM_BY_SLUG, { slug }),
    select: (data) => data.gymBySlug,
    enabled: slug !== null,
  });
  return gymUuid !== null ? byUuid : bySlug;
}

export const gymPendingClaimQueryKey = (slug: string | null) => ['gymPendingClaim', slug] as const;

/**
 * The viewer's own claim on this gym that our team hasn't decided yet. Its own
 * document, as on the web: `myPendingClaim` stays out of GYM_FIELDS so a
 * backend that doesn't answer it can never take the whole gym query down with
 * it. Any failure reads as "no pending claim", which only shows the claim card
 * again; the server still refuses a second claim.
 */
export function useGymPendingClaim(slug: string | null, enabled: boolean) {
  return useQuery({
    queryKey: gymPendingClaimQueryKey(slug),
    queryFn: async (): Promise<MyGymClaim | null> => {
      try {
        const data = await getHttpClient().request<GetGymPendingClaimQueryResponse>(GET_GYM_PENDING_CLAIM, { slug });
        return data.gymBySlug?.myPendingClaim ?? null;
      } catch {
        return null;
      }
    },
    enabled: enabled && slug !== null,
  });
}

/**
 * Follow or unfollow the gym. Refreshes the gym's own reads (the follow state
 * and follower count) and the climber's gym lists.
 */
export function useToggleGymFollow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ gymUuid, follow }: { gymUuid: string; follow: boolean }) => {
      if (follow) {
        const response = await getHttpClient().request<FollowGymMutationResponse>(FOLLOW_GYM, { input: { gymUuid } });
        return response.followGym;
      }
      const response = await getHttpClient().request<UnfollowGymMutationResponse>(UNFOLLOW_GYM, {
        input: { gymUuid },
      });
      return response.unfollowGym;
    },
    onSuccess: (_result, { gymUuid }) => {
      void queryClient.invalidateQueries({ queryKey: ['gym', gymUuid] });
      void queryClient.invalidateQueries({ queryKey: ['gymBySlug'] });
      void queryClient.invalidateQueries({ queryKey: ['myGyms'] });
    },
  });
}
