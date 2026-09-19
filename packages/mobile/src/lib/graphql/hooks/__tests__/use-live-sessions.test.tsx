// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LiveSession } from '@boardsesh/shared-schema';
import { BOARD_LIVE_SESSIONS, FOLLOWED_LIVE_SESSIONS } from '@boardsesh/graphql/operations/live-sessions';
import { boardLiveSessionsQueryKey, followedLiveSessionsQueryKey } from '../../query-keys';

const requestMock = vi.hoisted(() => vi.fn());
const nav = vi.hoisted(() => ({ focused: true, offline: false }));
vi.mock('../../client', () => ({ getHttpClient: () => ({ request: requestMock }) }));
vi.mock('expo-router', () => ({ useIsFocused: () => nav.focused }));
vi.mock('../../../../hooks/use-is-offline', () => ({ useIsOffline: () => nav.offline }));

import {
  FOLLOWED_LIVE_SESSIONS_LIMIT,
  LIVE_SESSIONS_REFETCH_INTERVAL_MS,
  liveSessionsRefetchInterval,
  useBoardLiveSessions,
  useFollowedLiveSessions,
} from '../use-live-sessions';

function session(sessionId: string, overrides: Partial<LiveSession> = {}): LiveSession {
  return {
    sessionId,
    name: null,
    goal: null,
    color: null,
    startedAt: '2026-09-16T10:00:00.000Z',
    lastActivity: '2026-09-16T10:30:00.000Z',
    host: { userId: `host-${sessionId}`, displayName: 'Hana Host', avatarUrl: null },
    participants: [],
    participantCount: 1,
    followedParticipantIds: [],
    viewerIsMember: false,
    isPublic: true,
    board: null,
    boardType: 'kilter',
    angle: 40,
    sendCount: 0,
    flashCount: 0,
    hardestSendGrade: null,
    currentClimb: null,
    reasons: ['FOLLOWING_USER'],
    ...overrides,
  };
}

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

beforeEach(() => {
  requestMock.mockReset();
  nav.focused = true;
  nav.offline = false;
});

describe('liveSessionsRefetchInterval', () => {
  it('polls every 60s only while visible and online', () => {
    expect(liveSessionsRefetchInterval(true, false)).toBe(LIVE_SESSIONS_REFETCH_INTERVAL_MS);
    expect(LIVE_SESSIONS_REFETCH_INTERVAL_MS).toBe(60_000);
    expect(liveSessionsRefetchInterval(false, false)).toBe(false);
    expect(liveSessionsRefetchInterval(true, true)).toBe(false);
  });
});

describe('useFollowedLiveSessions', () => {
  it('sends the board scope and a limit, and maps rows to card models', async () => {
    requestMock.mockResolvedValue({ followedLiveSessions: [session('a')] });
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useFollowedLiveSessions('board-uuid', true), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestMock).toHaveBeenCalledWith(FOLLOWED_LIVE_SESSIONS, {
      boardUuid: 'board-uuid',
      limit: FOLLOWED_LIVE_SESSIONS_LIMIT,
    });
    expect(result.current.data?.map((card) => card.sessionId)).toEqual(['a']);
    expect(result.current.data?.[0]).not.toHaveProperty('lastActivity');
  });

  it('does not fetch while Home is out of focus, and refetches stale cards the moment it returns', async () => {
    nav.focused = false;
    const { queryClient, wrapper } = makeWrapper();
    // Cards cached from an earlier visit, older than the stale time.
    queryClient.setQueryData(
      followedLiveSessionsQueryKey(null),
      { followedLiveSessions: [session('ended')] },
      {
        updatedAt: Date.now() - 5 * 60_000,
      },
    );
    requestMock.mockResolvedValue({ followedLiveSessions: [] });
    const { result, rerender } = renderHook(() => useFollowedLiveSessions(null, true), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requestMock).not.toHaveBeenCalled();
    // The cached cards stay readable while blurred.
    expect(result.current.data?.map((card) => card.sessionId)).toEqual(['ended']);

    nav.focused = true;
    rerender();
    // No waiting out the 60s poll: the ended session is gone on the next fetch.
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.data).toEqual([]));
  });

  it('fires no request while disabled', async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useFollowedLiveSessions(null, false), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requestMock).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('keeps card order stable when the backend re-sorts', async () => {
    requestMock.mockResolvedValueOnce({ followedLiveSessions: [session('a'), session('b')] });
    const { queryClient, wrapper } = makeWrapper();
    const { result } = renderHook(() => useFollowedLiveSessions(null, true), { wrapper });
    await waitFor(() => expect(result.current.data?.map((card) => card.sessionId)).toEqual(['a', 'b']));

    requestMock.mockResolvedValueOnce({ followedLiveSessions: [session('c'), session('b'), session('a')] });
    await queryClient.invalidateQueries({ queryKey: followedLiveSessionsQueryKey(null) });
    await waitFor(() => expect(result.current.data?.map((card) => card.sessionId)).toEqual(['a', 'b', 'c']));
  });

  it('hands back the same card object when a poll changes only lastActivity', async () => {
    requestMock.mockResolvedValueOnce({ followedLiveSessions: [session('a')] });
    const { queryClient, wrapper } = makeWrapper();
    const { result } = renderHook(() => useFollowedLiveSessions(null, true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const firstCard = result.current.data?.[0];

    requestMock.mockResolvedValueOnce({
      followedLiveSessions: [session('a', { lastActivity: '2026-09-16T10:31:00.000Z' })],
    });
    await queryClient.invalidateQueries({ queryKey: followedLiveSessionsQueryKey(null) });
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.data?.[0]).toBe(firstCard);
  });
});

describe('useBoardLiveSessions', () => {
  it('queries by board id', async () => {
    requestMock.mockResolvedValue({ boardLiveSessions: [session('a', { reasons: ['SELECTED_BOARD'] })] });
    const { queryClient, wrapper } = makeWrapper();
    const { result } = renderHook(() => useBoardLiveSessions(42, true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestMock).toHaveBeenCalledWith(BOARD_LIVE_SESSIONS, { boardId: 42 });
    expect(queryClient.getQueryState(boardLiveSessionsQueryKey(42))).toBeDefined();
  });

  it('stays idle without a board id', async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useBoardLiveSessions(null, true), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requestMock).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe('idle');
  });
});
