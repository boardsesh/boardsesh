// @vitest-environment jsdom
//
// endSession and the post-session summary cache (#6903). The in-session screen
// keeps useSessionSummary mounted all session, so without a write the summary
// screen renders the copy cached at the start ("0 attempts"). endSession must
// seed the cache with END_SESSION's own summary in the raw `{ sessionSummary }`
// shape the hook's `select` reads.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionSummary } from '@boardsesh/shared-schema';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock('../../../lib/active-board-store', () => ({ getStoredActiveBoard: () => Promise.resolve(null) }));
vi.mock('../../../lib/graphql/use-active-board', () => ({ getActiveBoardWriteGeneration: () => 0 }));
vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: mocks.request }) }));
vi.mock('../../../lib/graphql/ws-client', () => ({ getWsClient: () => ({}) }));
vi.mock('../../../lib/graphql/operations', () => ({ CREATE_SESSION: 'CreateSession', END_SESSION: 'EndSession' }));
vi.mock('../../../lib/graphql/extract-error-message', () => ({
  extractGraphqlMessage: () => null,
  isGraphqlRateLimitedError: () => false,
}));
vi.mock('../../../lib/session-store', () => ({
  clearStoredCreatedSessionId: () => Promise.resolve(),
  clearStoredSessionId: () => Promise.resolve(),
  setStoredCreatedSessionId: () => Promise.resolve(),
  setStoredSessionId: () => Promise.resolve(),
  setStoredSessionVisibility: () => Promise.resolve(),
}));
vi.mock('../../../lib/queue-snapshot-store', () => ({ clearStoredQueueSnapshot: () => Promise.resolve() }));
vi.mock('../../../lib/device-timezone', () => ({ getDeviceTimezone: () => 'UTC' }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/error-reporting', () => ({ reportError: vi.fn(), reportHandledError: vi.fn() }));
vi.mock('@boardsesh/graphql-client', () => ({ execute: vi.fn(() => Promise.resolve({})) }));
vi.mock('@boardsesh/graphql/operations/queue-session', () => ({ LEAVE_SESSION: 'LeaveSession' }));

import { useSessionCommands } from '../use-session-commands';
import { sessionSummaryQueryKey } from '../../../lib/graphql/query-keys';

type SessionCommandsParams = Parameters<typeof useSessionCommands>[0];

const freshSummary = {
  sessionId: 'session-1',
  totalSends: 4,
  totalAttempts: 7,
  durationMinutes: 52,
} as unknown as SessionSummary;

function renderEndSession(queryClient: QueryClient) {
  const params = {
    showToast: vi.fn(),
    t: (key: string) => key,
    stateRef: { current: { queue: [], currentClimbQueueItem: null } },
    ensureJoined: vi.fn(() => Promise.resolve()),
    setQueueMutation: vi.fn(() => Promise.resolve()),
    nowSlotModeRef: { current: false },
    seedFailedSessionIdRef: { current: null },
    setSessionId: vi.fn(),
    sessionIdRef: { current: 'session-1' },
    onSessionContextChanging: vi.fn(),
    dispatch: vi.fn(),
    setPlaylistSuggestionSourceState: vi.fn(),
    setActiveBoard: vi.fn(() => Promise.resolve(true)),
    locallyEndingSessionIdRef: { current: null },
    suppressedRemoteEndSessionIdRef: { current: null },
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { ...renderHook(() => useSessionCommands(params as unknown as SessionCommandsParams), { wrapper }), params };
}

describe('useSessionCommands — endSession summary cache', () => {
  beforeEach(() => {
    mocks.request.mockReset();
    mocks.request.mockResolvedValue({ endSession: freshSummary });
  });

  it('replaces the start-of-session summary with the one END_SESSION returned', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(sessionSummaryQueryKey('session-1'), {
      sessionSummary: { sessionId: 'session-1', totalSends: 0, totalAttempts: 0 },
    });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderEndSession(queryClient);

    let returned: SessionSummary | null = null;
    await act(async () => {
      returned = await result.current.endSession();
    });

    expect(returned).toBe(freshSummary);
    expect(queryClient.getQueryData(sessionSummaryQueryKey('session-1'))).toEqual({ sessionSummary: freshSummary });
    // Freshly written, so the summary screen's 5-minute staleTime keeps it.
    expect(queryClient.getQueryState(sessionSummaryQueryKey('session-1'))?.isInvalidated).toBe(false);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessionDetail', 'session-1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessionGroupedFeed'] });
  });

  it('leaves the cache alone when END_SESSION fails', async () => {
    mocks.request.mockRejectedValue(new Error('network'));
    const queryClient = new QueryClient();
    const { result } = renderEndSession(queryClient);
    await act(async () => {
      await result.current.endSession();
    });
    expect(queryClient.getQueryData(sessionSummaryQueryKey('session-1'))).toBeUndefined();
  });
});

describe('useSessionCommands — endSession beforeEnd (#6903 queued-tick wait)', () => {
  beforeEach(() => {
    mocks.request.mockReset();
    mocks.request.mockResolvedValue({ endSession: freshSummary });
  });

  it('runs beforeEnd with the session already marked as ending, then sends END_SESSION', async () => {
    const calls: string[] = [];
    mocks.request.mockImplementation(async (operation: string) => {
      calls.push(operation);
      return { endSession: freshSummary };
    });
    const { result, params } = renderEndSession(new QueryClient());
    let endingDuringWait: string | null = null;
    await act(async () => {
      await result.current.endSession({
        beforeEnd: async (sessionId) => {
          endingDuringWait = params.locallyEndingSessionIdRef.current;
          calls.push(`wait:${sessionId}`);
        },
      });
    });
    expect(endingDuringWait).toBe('session-1');
    expect(calls).toEqual(['wait:session-1', 'EndSession']);
    expect(params.locallyEndingSessionIdRef.current).toBeNull();
  });

  // useSessionRealtime's SessionEnded branch: while locallyEndingSessionIdRef
  // names the session it only records the end and returns, no teardown.
  function remoteSessionEnded(params: ReturnType<typeof renderEndSession>['params']) {
    if (params.locallyEndingSessionIdRef.current === 'session-1') {
      (params.suppressedRemoteEndSessionIdRef as { current: string | null }).current = 'session-1';
      return 'suppressed';
    }
    return 'teardown';
  }

  it('suppresses a remote end that arrives during the wait and still returns the summary', async () => {
    const { result, params } = renderEndSession(new QueryClient());
    let remoteOutcome: string | null = null;
    let returned: SessionSummary | null = null;
    await act(async () => {
      returned = await result.current.endSession({
        beforeEnd: async () => {
          remoteOutcome = remoteSessionEnded(params);
        },
      });
    });
    expect(remoteOutcome).toBe('suppressed');
    expect(returned).toBe(freshSummary);
    expect(params.showToast).toHaveBeenCalledWith('mobile.toast.sessionEnded', 'success');
    expect(params.suppressedRemoteEndSessionIdRef.current).toBeNull();
  });

  it('treats a remote end during the wait as ended when END_SESSION then fails', async () => {
    mocks.request.mockRejectedValue(new Error('already ended'));
    const { result, params } = renderEndSession(new QueryClient());
    let returned: SessionSummary | null = freshSummary;
    await act(async () => {
      returned = await result.current.endSession({
        beforeEnd: async () => {
          remoteSessionEnded(params);
        },
      });
    });
    expect(returned).toBeNull();
    expect(params.showToast).toHaveBeenCalledWith('mobile.toast.sessionEnded', 'success');
    expect(params.showToast).not.toHaveBeenCalledWith('mobile.queue.endSessionFailedLeft', 'error');
  });

  it('still ends the session when beforeEnd throws', async () => {
    const { result } = renderEndSession(new QueryClient());
    let returned: SessionSummary | null = null;
    await act(async () => {
      returned = await result.current.endSession({
        beforeEnd: () => Promise.reject(new Error('sqlite gone')),
      });
    });
    expect(mocks.request).toHaveBeenCalledWith('EndSession', expect.objectContaining({ sessionId: 'session-1' }));
    expect(returned).toBe(freshSummary);
  });
});
