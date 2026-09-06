// Approve / reject a proposal — the moderator action, gated server-side to
// admins and community leaders.
//
// Unlike a vote there is no optimistic step: resolving APPLIES the change (an
// approved hide flips `is_hidden`, an approved grade rewrites the community
// grade), so the row the server hands back is the only honest one to render. It
// is written straight into every proposal cache, then the proposal lists and the
// climb query are invalidated so a hidden climb disappears from the lists that
// still hold it.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  RESOLVE_PROPOSAL_FEED,
  type ResolveProposalFeedResponse,
  type ResolveProposalFeedVariables,
} from '@boardsesh/graphql/operations/proposals';
import { getHttpClient } from '../client';
import { writeProposalToCaches } from './use-browse-proposals';
import { PROPOSALS_QUERY_KEY } from './use-report-climb';

/** The key `useClimb` writes under; an approved hide flips `is_hidden` on it. */
const CLIMB_QUERY_KEY = ['climb'] as const;

export type ResolveProposalInput = {
  proposalUuid: string;
  status: 'approved' | 'rejected';
};

export function useResolveProposal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ proposalUuid, status }: ResolveProposalInput) => {
      const variables: ResolveProposalFeedVariables = { input: { proposalUuid, status } };
      const response = await getHttpClient().request<ResolveProposalFeedResponse, ResolveProposalFeedVariables>(
        RESOLVE_PROPOSAL_FEED,
        variables,
      );
      return response.resolveProposal;
    },
    onSuccess: (proposal) => {
      // Write first, invalidate second: the card keeps its resolved chip through
      // the refetch instead of flashing back to an open one.
      writeProposalToCaches(queryClient, proposal);
      void queryClient.invalidateQueries({ queryKey: PROPOSALS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: CLIMB_QUERY_KEY });
    },
  });
}
