// The one slug → gym lookup every public gym surface uses, plus the
// viewability rule that goes with it.
//
// Extracted from `page.tsx` when `/gym/[gym_slug]/poster` landed (#4379): the
// poster is the same gym under a second URL, and the two must agree on what
// exists, what 404s, and what an owner can see before going public. A second
// copy of `isGymViewable` is how a private-preview rule drifts into a private
// gym leaking from one route and not the other.

import { cache } from 'react';
import type { Gym } from '@boardsesh/shared-schema';
import { GET_GYM_BY_SLUG, type GetGymBySlugQueryResponse } from '@boardsesh/graphql/operations';
import { executeAuthenticatedGraphQL } from '@/app/lib/graphql/server-graphql';

/**
 * Request-deduped: `generateMetadata` and the page body of the same route each
 * call it, and React's `cache()` collapses that into one round-trip.
 */
export const fetchGymBySlug = cache(async (slug: string, token: string | undefined): Promise<Gym | null> => {
  try {
    const response = await executeAuthenticatedGraphQL<GetGymBySlugQueryResponse>(GET_GYM_BY_SLUG, { slug }, token);
    return response.gymBySlug ?? null;
  } catch (error) {
    console.error('fetchGymBySlug failed:', error);
    return null;
  }
});

/**
 * A gym is viewable when it's public, or the viewer can edit it (private
 * preview) — an owner can lay out and print a poster before the listing goes
 * public.
 */
export function isGymViewable(gym: Gym | null): gym is Gym {
  return gym !== null && (gym.isPublic || gym.canEdit);
}
