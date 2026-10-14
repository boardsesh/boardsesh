import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PROPOSAL_REPORT_RELEASE_CONTEXTS,
  type ProposalReportReleaseContextsQueryResponse,
} from '@boardsesh/graphql/operations';
import { getHttpClient } from '../client';
import { useAuthToken } from '../use-auth-token';

let nextSessionScope = 0;

/** Private diagnostics stay in this expanded admin surface and this auth session. */
export function useProposalReportReleaseContexts(proposalUuid: string, enabled: boolean) {
  const { data: authToken } = useAuthToken();
  const sessionScope = useMemo(() => (authToken ? ++nextSessionScope : 0), [authToken]);
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => ['proposalReportReleaseContexts', proposalUuid, sessionScope] as const,
    [proposalUuid, sessionScope],
  );
  const canRead = enabled && !!authToken;
  useEffect(() => {
    if (!canRead) {
      void queryClient.cancelQueries({ queryKey });
      queryClient.removeQueries({ queryKey });
    }
    return () => {
      void queryClient.cancelQueries({ queryKey });
      queryClient.removeQueries({ queryKey });
    };
  }, [canRead, queryClient, queryKey]);
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) =>
      (
        await getHttpClient().request<ProposalReportReleaseContextsQueryResponse>({
          document: PROPOSAL_REPORT_RELEASE_CONTEXTS,
          variables: { proposalUuid },
          signal,
        })
      ).proposalReportReleaseContexts,
    enabled: canRead,
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  return canRead ? query.data : undefined;
}
