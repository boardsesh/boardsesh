import { useQuery } from '@tanstack/react-query';
import {
  GET_CLIMB_PROPOSALS,
  type GetClimbProposalsResponse,
  type GetClimbProposalsVariables,
} from '@boardsesh/graphql/operations/proposals';
import type { Proposal } from '@boardsesh/shared-schema';
import { getHttpClient } from '../client';
import { PROPOSALS_PAGE_SIZE, climbProposalsKey } from './use-browse-proposals';

/** Long enough that swiping back and forth through the queue doesn't re-fetch. */
const CLIMB_PROPOSALS_STALE_TIME_MS = 60 * 1000;

/**
 * Hoisted, not inline: React Query re-runs `select` whenever its identity
 * changes, and an inline arrow changes every render — which would hand the
 * Community section a fresh array each time and re-run its status reduction for
 * nothing.
 */
function selectProposals(response: GetClimbProposalsResponse): Proposal[] {
  return response.climbProposals.proposals;
}

type UseClimbProposalsArgs = {
  climbUuid: string;
  boardType: string;
  /** Off for surfaces that don't show moderation (the kill flag, mainly). */
  enabled?: boolean;
};

/**
 * Every proposal on one climb — what the play drawer's Community section reads
 * to say "hidden by the community", "reported by N climbers", or "grade change
 * proposed".
 *
 * Deliberately NOT gated on an auth token: a hidden climb reads as hidden to a
 * signed-out climber too, and the resolver serves the feed unauthenticated
 * (`userVote` just comes back 0).
 *
 * Shares its key, page size and CACHED SHAPE with `useClimbProposalsPinned` in
 * `use-browse-proposals.ts` — the moderation feed's copy of the same read. That
 * is not incidental: both cache the raw `{ climbProposals }` document, so
 * `mapCachedProposals` rewrites this entry too when someone votes in the feed,
 * and neither hook can overwrite the other with a shape it can't parse. The
 * array this hook hands back is a `select` view, not the cached value.
 */
export function useClimbProposals({ climbUuid, boardType, enabled = true }: UseClimbProposalsArgs) {
  return useQuery({
    queryKey: climbProposalsKey(climbUuid),
    queryFn: async () => {
      const variables: GetClimbProposalsVariables = {
        input: { climbUuid, boardType, limit: PROPOSALS_PAGE_SIZE },
      };
      return getHttpClient().request<GetClimbProposalsResponse, GetClimbProposalsVariables>(
        GET_CLIMB_PROPOSALS,
        variables,
      );
    },
    select: selectProposals,
    enabled: enabled && !!climbUuid && !!boardType,
    staleTime: CLIMB_PROPOSALS_STALE_TIME_MS,
  });
}
