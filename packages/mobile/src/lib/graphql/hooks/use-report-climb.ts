// One-tap climb report. The server decides whether the report opens a proposal,
// joins the open one, or is a no-op because this climber already reported it —
// `status` on the result says which, and `proposal` is always the live one.
//
// Errors are deliberately NOT toasted here: the report sheet renders the
// backend's message inline (a frozen climb, an already-hidden climb), where the
// climber can read it next to the form that produced it.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  REPORT_CLIMB,
  type ReportClimbResponse,
  type ReportClimbVariables,
} from '@boardsesh/graphql/operations/proposals';
import { getHttpClient } from '../client';
import { readMobileReleaseContext } from '../../release-context';
import { PROPOSALS_QUERY_KEY } from '../query-keys';
import { requestReport } from '../request-report';

export { PROPOSALS_QUERY_KEY } from '../query-keys';

/** Key `useClimb` writes under; a report can flip `is_hidden` on the climb. */
const CLIMB_QUERY_KEY = ['climb'] as const;

/** The climb lists a changed grade has to reach: the same keys a create-climb save refreshes. */
const CLIMB_LIST_QUERY_KEYS = [['searchClimbs'], ['infiniteSearchClimbs'], ['searchClimbsCount']] as const;

export function useReportClimb() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variables: ReportClimbVariables) => {
      const response = await requestReport(
        (requestVariables: ReportClimbVariables) =>
          getHttpClient().request<ReportClimbResponse, ReportClimbVariables>(REPORT_CLIMB, requestVariables),
        { ...variables, input: { ...variables.input, releaseContext: readMobileReleaseContext() } },
        'ReportClimbInput',
      );
      return response.reportClimb;
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: PROPOSALS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: CLIMB_QUERY_KEY });
      // An approved grade (a spray wall owner's, #5971) changed the climb's grade
      // on the server, so the lists showing the old one refetch.
      if (result.proposal.status === 'approved' && result.proposal.type === 'grade') {
        for (const queryKey of CLIMB_LIST_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}
