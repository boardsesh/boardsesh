import { useQuery } from '@tanstack/react-query';
import {
  RUNNING_COSTS,
  type RunningCostsQueryResponse,
  type RunningCostsQueryVariables,
} from '@boardsesh/graphql/operations';
import type { RunningCostsReport } from '@boardsesh/shared-schema';
import { getHttpClient } from '../client';

// The running-cost report changes at most a few times a month (a new bill lands),
// so a generous stale window keeps the transparency screen from re-fetching on
// every focus. Public query — no auth token or user id is involved.
const RUNNING_COSTS_STALE_TIME_MS = 5 * 60 * 1000;

/**
 * Public running-cost report for the transparency screen (`/costs`). Rolls up
 * every recurring + incidental cost entry into an ascending list of monthly
 * totals plus the latest month's total. No `enabled`/user gate: the underlying
 * `runningCosts` query is public, so it runs for signed-out visitors too.
 */
export function useRunningCosts(months = 12) {
  return useQuery({
    queryKey: ['runningCosts', months],
    queryFn: async (): Promise<RunningCostsReport> => {
      const response = await getHttpClient().request<RunningCostsQueryResponse, RunningCostsQueryVariables>(
        RUNNING_COSTS,
        { months },
      );
      return response.runningCosts;
    },
    staleTime: RUNNING_COSTS_STALE_TIME_MS,
  });
}
