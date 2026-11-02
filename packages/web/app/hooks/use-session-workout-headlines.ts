'use client';

import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_SESSION_WORKOUT_HEADLINES,
  MAX_SESSION_WORKOUT_HEADLINE_IDS,
  type GetSessionWorkoutHeadlinesQueryResponse,
  type SessionWorkoutHeadlineResult,
} from '@boardsesh/graphql/operations/session-workouts';

/** Daily feed groups ("daily:<user>:<day>") are not sessions and never hold a workout. */
const isWorkoutCapable = (sessionId: string) => !sessionId.startsWith('daily:');

/**
 * The workout line of each session on a feed (#6903), one request per loaded
 * page (`sessionWorkoutHeadlines`, ≤ 50 ids), so a new page never refetches the
 * ones before it. Keyed by session id; when several climbers followed a
 * workout in one session, the first one stored wins.
 */
export function useSessionWorkoutHeadlines({
  pages,
  token,
  enabled,
}: {
  /** Each loaded page's session ids, in feed order. */
  pages: ReadonlyArray<ReadonlyArray<string>>;
  token: string | null;
  enabled: boolean;
}): ReadonlyMap<string, SessionWorkoutHeadlineResult> {
  const batches = useMemo(
    () =>
      pages
        .map((sessionIds) => sessionIds.filter(isWorkoutCapable).slice(0, MAX_SESSION_WORKOUT_HEADLINE_IDS))
        .filter((sessionIds) => sessionIds.length > 0),
    [pages],
  );

  return useQueries({
    queries: batches.map((sessionIds) => ({
      queryKey: ['sessionWorkoutHeadlines', token ? 'signed-in' : 'signed-out', ...sessionIds] as const,
      queryFn: async () => {
        const client = createGraphQLHttpClient(token);
        const data = await client.request<GetSessionWorkoutHeadlinesQueryResponse>(GET_SESSION_WORKOUT_HEADLINES, {
          sessionIds,
        });
        return data.sessionWorkoutHeadlines;
      },
      enabled,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    })),
    combine: headlinesBySession,
  });
}

/** Module-level, so React Query re-runs it only when a batch's data changes. */
function headlinesBySession(
  results: ReadonlyArray<{ data?: SessionWorkoutHeadlineResult[] }>,
): ReadonlyMap<string, SessionWorkoutHeadlineResult> {
  const bySession = new Map<string, SessionWorkoutHeadlineResult>();
  for (const result of results) {
    for (const headline of result.data ?? []) {
      if (!bySession.has(headline.sessionId)) bySession.set(headline.sessionId, headline);
    }
  }
  return bySession;
}
