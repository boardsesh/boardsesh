import type { QueryClient } from '@tanstack/react-query';
import type { SessionSummary } from '@boardsesh/shared-schema';
import { sessionSummaryQueryKey } from './graphql/query-keys';

/**
 * Put END_SESSION's own summary into the cache the summary screen reads (#6903).
 *
 * The in-session screen keeps `useSessionSummary` mounted all session, so the
 * cache holds the summary from the session's first minutes (often 0 ticks), and
 * within the 5-minute staleTime the summary screen would render that copy and
 * never refetch. END_SESSION already returns the fresh one. The hook uses
 * `select`, so the cache holds the raw response shape, `{ sessionSummary }`.
 *
 * Also refreshes the session detail and the grouped feed, which now carry an
 * ended session.
 */
export function seedEndedSessionCaches(queryClient: QueryClient, summary: SessionSummary): void {
  queryClient.setQueryData(sessionSummaryQueryKey(summary.sessionId), { sessionSummary: summary });
  void queryClient.invalidateQueries({ queryKey: ['sessionDetail', summary.sessionId] });
  void queryClient.invalidateQueries({ queryKey: ['sessionGroupedFeed'] });
}
