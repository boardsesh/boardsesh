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
  return renderHook(() => useSessionCommands(params as unknown as SessionCommandsParams), { wrapper });
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
