// Support / oppose on a community proposal.
//
// The button has to flip under the thumb — a moderation pass is a dozen taps in
// a row and a spinner per tap makes it unusable — so the vote is written into
// every proposal cache before the request leaves, rolled back on failure, and
// overwritten with the server's weighted numbers on success. The viewer's own
// weight (2 for a community leader, 3 for an admin) is only known server-side,
// so the optimistic step moves the totals by 1 and lets the response correct it.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  VOTE_ON_PROPOSAL,
  type VoteOnProposalResponse,
  type VoteOnProposalVariables,
} from '@boardsesh/graphql/operations/proposals';
import type { Proposal } from '@boardsesh/shared-schema';
import { applyOptimisticVote, type ProposalVoteValue } from '../../../components/moderation/proposal-presenters';
import { getHttpClient } from '../client';
import { mapProposalCaches, writeProposalToCaches } from './use-browse-proposals';
import { invalidateAppliedProposalCaches } from './proposal-cache';
import { PROPOSALS_QUERY_KEY } from './use-report-climb';

export type VoteOnProposalInput = {
  proposalUuid: string;
  /** Re-sending the value already on record clears the vote (backend semantics). */
  value: ProposalVoteValue;
};

/**
 * The failed proposal as it stood before the optimistic write — that ONE row,
 * not a snapshot of every proposal cache.
 *
 * A whole-cache snapshot is the wrong unit here. Two cards can be voted on
 * inside the same second (that is what a moderation pass looks like), and
 * restoring the entries this mutation happened to read would put the sibling's
 * pre-vote row back over the vote that just succeeded on it. Undefined when the
 * proposal wasn't in any cache — nothing was optimistically written, so nothing
 * needs putting back.
 */
type ProposalVoteRollback = { preVote: Proposal | undefined };

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
    onMutate: async ({ proposalUuid, value }): Promise<ProposalVoteRollback> => {
      // An in-flight refetch landing after the optimistic write would paint the
      // pre-vote row back over it, so stop them first.
      await queryClient.cancelQueries({ queryKey: PROPOSALS_QUERY_KEY });
      let preVote: Proposal | undefined;
      mapProposalCaches(queryClient, (proposal) => {
        if (proposal.uuid !== proposalUuid) return proposal;
        // The same proposal sits in several caches; the first copy seen is the
        // pre-image for all of them.
        preVote ??= proposal;
        return applyOptimisticVote(proposal, value);
      });
      return { preVote };
    },
    onError: (_error, _variables, context) => {
      // Put back only the row this vote touched, then let the server settle it:
      // the pre-image is one screen's idea of the proposal and other people have
      // been voting on it since, so it is a placeholder until the refetch lands,
      // not the truth.
      const { preVote } = context ?? {};
      if (preVote) writeProposalToCaches(queryClient, preVote);
      void queryClient.invalidateQueries({ queryKey: PROPOSALS_QUERY_KEY });
    },
    // The server's weighted totals win: they account for the voter's role weight
    // and for every vote cast since this screen last refetched.
    onSuccess: (proposal) => {
      writeProposalToCaches(queryClient, proposal);
      // A vote can be the one that carries the proposal: the backend applies the
      // effect (the hide flips `is_hidden`, the grade change lands) and returns
      // it already resolved. From here that is indistinguishable from a
      // moderator's verdict, so it busts exactly the same caches — otherwise the
      // climb the crew just hid stays in the list behind the card.
      if (proposal.status !== 'open') invalidateAppliedProposalCaches(queryClient);
    },
  });
}
