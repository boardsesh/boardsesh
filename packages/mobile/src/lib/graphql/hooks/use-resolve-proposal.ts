// Approve / reject a proposal — the moderator action, gated server-side to
// admins and community leaders.
//
// Unlike a vote there is no optimistic step: resolving APPLIES the change (an
// approved hide flips `is_hidden`, an approved grade rewrites the community
// grade), so the row the server hands back is the only honest one to render. It
// is written straight into every proposal cache, then the proposal lists AND the
// climb reads are invalidated so a hidden climb disappears from the lists that
// still hold it — the search lists included, not just the open detail.
//
// Failure handling lives HERE, not at the call site. A `mutate(vars, { onError })`
// callback is dropped when the calling component unmounts before the request
// settles (a moderator can dismiss the feed right after tapping Approve), and a
// caller that forgets the option would swallow the error outright. The hook
// toasts and re-fetches the proposal caches itself, so a card never sits on a
// verdict the server rejected.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  RESOLVE_PROPOSAL_FEED,
  type ResolveProposalFeedResponse,
  type ResolveProposalFeedVariables,
} from '@boardsesh/graphql/operations/proposals';
import { getHttpClient } from '../client';
import { useToast } from '../../../providers/toast-provider';
import { writeProposalToCaches } from './use-browse-proposals';
import { invalidateAppliedProposalCaches } from './proposal-cache';
import { PROPOSALS_QUERY_KEY } from './use-report-climb';

export type ResolveProposalInput = {
  proposalUuid: string;
  status: 'approved' | 'rejected';
};

export function useResolveProposal() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useTranslation('climbs');

  return useMutation({
    mutationFn: async ({ proposalUuid, status }: ResolveProposalInput) => {
      const variables: ResolveProposalFeedVariables = { input: { proposalUuid, status } };
      const response = await getHttpClient().request<ResolveProposalFeedResponse, ResolveProposalFeedVariables>(
        RESOLVE_PROPOSAL_FEED,
        variables,
      );
      return response.resolveProposal;
    },
    onError: () => {
      showToast(t('mobile.moderation.resolveError'), 'error');
      // Nothing optimistic went in, so there is nothing to roll back — but a
      // rejection usually means the row moved under the moderator (someone else
      // resolved it, or a vote carried it), so pull the current one rather than
      // leaving the card on a stale open proposal.
      void queryClient.invalidateQueries({ queryKey: PROPOSALS_QUERY_KEY });
    },
    onSuccess: (proposal) => {
      // Write first, invalidate second: the card keeps its resolved chip through
      // the refetch instead of flashing back to an open one.
      writeProposalToCaches(queryClient, proposal);
      invalidateAppliedProposalCaches(queryClient);
    },
  });
}
