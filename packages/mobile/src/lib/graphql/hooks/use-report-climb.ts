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

/**
 * Root key for every proposal list — the moderation feed and the per-climb
 * proposal queries all key under it, so invalidating the prefix refreshes each
 * of them after a report lands. Exported so those hooks import the same array
 * rather than re-typing the string.
 */
export const PROPOSALS_QUERY_KEY = ['proposals'] as const;

/** Key `useClimb` writes under; a report can flip `is_hidden` on the climb. */
const CLIMB_QUERY_KEY = ['climb'] as const;

export function useReportClimb() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variables: ReportClimbVariables) => {
      const response = await getHttpClient().request<ReportClimbResponse, ReportClimbVariables>(
        REPORT_CLIMB,
        variables,
      );
      return response.reportClimb;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PROPOSALS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: CLIMB_QUERY_KEY });
    },
  });
}
