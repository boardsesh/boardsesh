// Support / oppose on a community proposal.
//
// The button has to flip under the thumb — a moderation pass is a dozen taps in
// a row and a spinner per tap makes it unusable — so the vote is written into
// every proposal cache before the request leaves, rolled back on failure, and
// overwritten with the server's weighted numbers on success. The viewer's own
// weight (2 for a community leader, 3 for an admin) is only known server-side,
// so the optimistic step moves the totals by 1 and lets the response correct it.

import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import {
  VOTE_ON_PROPOSAL,
  type VoteOnProposalResponse,
  type VoteOnProposalVariables,
} from '@boardsesh/graphql/operations/proposals';
import { applyOptimisticVote, type ProposalVoteValue } from '../../../components/moderation/proposal-presenters';
import { getHttpClient } from '../client';
import { mapProposalCaches, writeProposalToCaches } from './use-browse-proposals';
import { PROPOSALS_QUERY_KEY } from './use-report-climb';

export type VoteOnProposalInput = {
  proposalUuid: string;
  /** Re-sending the value already on record clears the vote (backend semantics). */
  value: ProposalVoteValue;
};

/** Every proposal cache as it stood before the optimistic write, for rollback. */
type ProposalCacheSnapshot = { entries: Array<[QueryKey, unknown]> };

export function useVoteOnProposal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ proposalUuid, value }: VoteOnProposalInput) => {
      const variables: VoteOnProposalVariables = { input: { proposalUuid, value } };
      const response = await getHttpClient().request<VoteOnProposalResponse, VoteOnProposalVariables>(
        VOTE_ON_PROPOSAL,
        variables,
      );
      return response.voteOnProposal;
    },
    onMutate: async ({ proposalUuid, value }): Promise<ProposalCacheSnapshot> => {
      // An in-flight refetch landing after the optimistic write would paint the
      // pre-vote row back over it, so stop them first.
      await queryClient.cancelQueries({ queryKey: PROPOSALS_QUERY_KEY });
      const entries = queryClient.getQueriesData({ queryKey: PROPOSALS_QUERY_KEY });
      mapProposalCaches(queryClient, (proposal) =>
        proposal.uuid === proposalUuid ? applyOptimisticVote(proposal, value) : proposal,
      );
      return { entries };
    },
    onError: (_error, _variables, context) => {
      for (const [queryKey, data] of context?.entries ?? []) {
        queryClient.setQueryData(queryKey, data);
      }
    },
    // The server's weighted totals win: they account for the voter's role weight
    // and for every vote cast since this screen last refetched.
    onSuccess: (proposal) => writeProposalToCaches(queryClient, proposal),
  });
}
