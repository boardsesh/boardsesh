import { useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  PROPOSAL_REPORT_RELEASE_CONTEXTS,
  type ProposalReportReleaseContextsQueryResponse,
} from '@boardsesh/graphql/operations';
import { useHttpQuery } from '../use-http-query';
import { useHttpQueryScope } from '../use-http-query-scope';
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
  const httpScope = useHttpQueryScope();
  const ownedQueryKey = useMemo(() => Object.freeze([...httpScope.key(queryKey)]), [httpScope, queryKey]);
  const canRead = enabled && !!authToken && httpScope.isReady();
  useEffect(() => {
    if (!canRead) {
      void queryClient.cancelQueries({ queryKey: ownedQueryKey, exact: true }).catch(() => {});
      queryClient.removeQueries({ queryKey: ownedQueryKey, exact: true });
    }
    return () => {
      void queryClient.cancelQueries({ queryKey: ownedQueryKey, exact: true }).catch(() => {});
      queryClient.removeQueries({ queryKey: ownedQueryKey, exact: true });
    };
  }, [canRead, queryClient, ownedQueryKey]);
  const query = useHttpQuery({
    queryKey,
    queryFn: async ({ signal }, operation) =>
      (
        await operation.request<ProposalReportReleaseContextsQueryResponse>({
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
