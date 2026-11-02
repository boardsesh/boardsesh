// seedEndedSessionCaches (#6903): END_SESSION's summary must win over a
// GET_SESSION_SUMMARY that was already in flight when the session ended (Home
// pull-to-refresh, a focus refetch). Its queryFn ignores the abort signal, so
// only a cancel keeps its late, pre-end answer out of the cache.
import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { SessionSummary } from '@boardsesh/shared-schema';
import { seedEndedSessionCaches } from '../session-end-cache';
import { sessionSummaryQueryKey } from '../graphql/query-keys';

const freshSummary = { sessionId: 'session-1', totalSends: 4, totalAttempts: 7 } as unknown as SessionSummary;
const staleSummary = { sessionId: 'session-1', totalSends: 0, totalAttempts: 0 } as unknown as SessionSummary;

describe('seedEndedSessionCaches', () => {
  it('keeps the END_SESSION summary when an older summary fetch resolves after it', async () => {
    const queryClient = new QueryClient();
    let resolveStale: (value: { sessionSummary: SessionSummary }) => void = () => undefined;
    // A queryFn that, like the real one, never looks at the abort signal.
    const inFlight = queryClient
      .fetchQuery({
        queryKey: sessionSummaryQueryKey('session-1'),
        queryFn: () =>
          new Promise<{ sessionSummary: SessionSummary }>((resolve) => {
            resolveStale = resolve;
          }),
      })
      .catch(() => 'cancelled');

    await seedEndedSessionCaches(queryClient, freshSummary);
    resolveStale({ sessionSummary: staleSummary });
    await inFlight;

    expect(queryClient.getQueryData(sessionSummaryQueryKey('session-1'))).toEqual({ sessionSummary: freshSummary });
  });

  it('writes the raw response shape the hook selects from', async () => {
    const queryClient = new QueryClient();
    await seedEndedSessionCaches(queryClient, freshSummary);
    expect(queryClient.getQueryData(sessionSummaryQueryKey('session-1'))).toEqual({ sessionSummary: freshSummary });
  });
});
