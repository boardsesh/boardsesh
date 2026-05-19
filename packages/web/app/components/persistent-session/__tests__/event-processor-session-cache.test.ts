import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEventProcessor } from '../hooks/use-event-processor';
import type { ClimbQueueItem as LocalClimbQueueItem } from '../../queue-control/types';
import type { SessionEvent, SessionDetail, SessionDetailTick, SubscriptionQueueEvent } from '@boardsesh/shared-schema';
import type { SessionStatsUpdated } from '@boardsesh/shared-schema/generated';
import { SESSION_DETAIL_QUERY_KEY } from '@/app/hooks/use-session-detail';
import type { ActiveSessionInfo } from '../types';

function createRefs() {
  return {
    lastReceivedSequenceRef: { current: null as number | null },
    triggerResyncRef: { current: null as (() => void) | null },
    lastCorruptionResyncRef: { current: 0 },
    isFilteringCorruptedItemsRef: { current: false },
    queueEventSubscribersRef: { current: new Set<(event: SubscriptionQueueEvent) => void>() },
    sessionEventSubscribersRef: { current: new Set<(event: SessionEvent) => void>() },
    offlineBufferRef: { current: [] as LocalClimbQueueItem[] },
    activeSessionRef: { current: null as ActiveSessionInfo | null },
    setActiveSessionSharedPlaylistEnabledRef: {
      current: null as ((sessionId: string, enabled: boolean) => void) | null,
    },
  };
}

function makeActiveSession(overrides: Partial<ActiveSessionInfo> = {}): ActiveSessionInfo {
  return {
    sessionId: 'session-abc',
    boardPath: 'kilter/1/2/3/40',
    boardDetails: {} as ActiveSessionInfo['boardDetails'],
    parsedParams: {} as ActiveSessionInfo['parsedParams'],
    sharedPlaylistEnabled: true,
    ...overrides,
  };
}

function createStatsEvent(
  // Generated SessionEvent union uses `__typename?: 'X'` (optional), so the
  // `Extract<…, { __typename: 'X' }>` trick resolves to `never`. Reference the
  // generated concrete type directly instead.
  overrides: Partial<SessionStatsUpdated> = {},
): SessionEvent {
  return {
    __typename: 'SessionStatsUpdated',
    sessionId: 'session-abc',
    totalSends: 3,
    totalFlashes: 1,
    totalAttempts: 2,
    tickCount: 5,
    participants: [],
    gradeDistribution: [],
    boardTypes: ['kilter'],
    hardestGrade: 'V5',
    durationMinutes: 45,
    goal: 'Send V5',
    ticks: [],
    ...overrides,
  };
}

function createTick(climbedAt: string): SessionDetailTick {
  return {
    uuid: `tick-${climbedAt}`,
    climbUuid: 'climb-1',
    climbName: 'Test Climb',
    angle: 40,
    status: 'send',
    attemptCount: 1,
    isMirror: false,
    isBenchmark: false,
    isNoMatch: false,
    climbedAt,
    boardType: 'kilter',
    userId: 'user-1',
    upvotes: 0,
  };
}

function createExistingSession(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    sessionId: 'session-abc',
    sessionType: 'party',
    sessionName: null,
    ownerUserId: null,
    participants: [],
    totalSends: 0,
    totalFlashes: 0,
    totalAttempts: 0,
    tickCount: 0,
    gradeDistribution: [],
    boardTypes: [],
    hardestGrade: null,
    firstTickAt: '2026-04-30T08:00:00Z',
    lastTickAt: '2026-04-30T09:00:00Z',
    durationMinutes: null,
    goal: null,
    ticks: [],
    upvotes: 0,
    downvotes: 0,
    voteScore: 0,
    commentCount: 0,
    ...overrides,
  };
}

describe('useEventProcessor - SessionStatsUpdated → React Query cache', () => {
  let queryClient: QueryClient;

  function createWrapper() {
    return ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);
  }

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('does not seed cache when no existing data (waits for HTTP fetch)', () => {
    const refs = createRefs();
    const { result } = renderHook(() => useEventProcessor({ refs }), { wrapper: createWrapper() });

    act(() => {
      result.current.handleSessionEvent(createStatsEvent());
    });

    const cached = queryClient.getQueryData<SessionDetail>(SESSION_DETAIL_QUERY_KEY('session-abc'));
    expect(cached).toBeUndefined();
  });

  it('updates stats in existing cached data', () => {
    queryClient.setQueryData(SESSION_DETAIL_QUERY_KEY('session-abc'), createExistingSession());

    const refs = createRefs();
    const { result } = renderHook(() => useEventProcessor({ refs }), { wrapper: createWrapper() });

    act(() => {
      result.current.handleSessionEvent(createStatsEvent());
    });

    const cached = queryClient.getQueryData<SessionDetail>(SESSION_DETAIL_QUERY_KEY('session-abc'));
    expect(cached).not.toBeNull();
    expect(cached!.totalSends).toBe(3);
    expect(cached!.totalFlashes).toBe(1);
    expect(cached!.totalAttempts).toBe(2);
    expect(cached!.tickCount).toBe(5);
    expect(cached!.boardTypes).toEqual(['kilter']);
    expect(cached!.hardestGrade).toBe('V5');
    expect(cached!.durationMinutes).toBe(45);
    expect(cached!.goal).toBe('Send V5');
  });

  it('preserves sessionType, ownerUserId, and social fields when merging', () => {
    queryClient.setQueryData(
      SESSION_DETAIL_QUERY_KEY('session-abc'),
      createExistingSession({
        sessionType: 'inferred',
        sessionName: 'My Inferred Session',
        ownerUserId: 'owner-123',
        upvotes: 5,
        downvotes: 1,
        voteScore: 4,
        commentCount: 3,
      }),
    );

    const refs = createRefs();
    const { result } = renderHook(() => useEventProcessor({ refs }), { wrapper: createWrapper() });

    act(() => {
      result.current.handleSessionEvent(
        createStatsEvent({
          totalSends: 5,
          totalFlashes: 2,
          hardestGrade: 'V6',
          ticks: [createTick('2026-04-30T11:00:00Z')],
        }),
      );
    });

    const cached = queryClient.getQueryData<SessionDetail>(SESSION_DETAIL_QUERY_KEY('session-abc'));
    expect(cached!.sessionType).toBe('inferred');
    expect(cached!.ownerUserId).toBe('owner-123');
    expect(cached!.sessionName).toBe('My Inferred Session');
    expect(cached!.upvotes).toBe(5);
    expect(cached!.commentCount).toBe(3);
    expect(cached!.totalSends).toBe(5);
    expect(cached!.totalFlashes).toBe(2);
    expect(cached!.hardestGrade).toBe('V6');
  });

  it('derives firstTickAt/lastTickAt from ticks when present', () => {
    queryClient.setQueryData(SESSION_DETAIL_QUERY_KEY('session-abc'), createExistingSession());

    const refs = createRefs();
    const { result } = renderHook(() => useEventProcessor({ refs }), { wrapper: createWrapper() });

    const ticks = [
      createTick('2026-04-30T10:00:00Z'),
      createTick('2026-04-30T09:30:00Z'),
      createTick('2026-04-30T09:00:00Z'),
    ];

    act(() => {
      result.current.handleSessionEvent(createStatsEvent({ ticks }));
    });

    const cached = queryClient.getQueryData<SessionDetail>(SESSION_DETAIL_QUERY_KEY('session-abc'));
    expect(cached!.lastTickAt).toBe('2026-04-30T10:00:00Z');
    expect(cached!.firstTickAt).toBe('2026-04-30T09:00:00Z');
  });

  it('derives firstTickAt/lastTickAt regardless of incoming tick order', () => {
    queryClient.setQueryData(SESSION_DETAIL_QUERY_KEY('session-abc'), createExistingSession());

    const refs = createRefs();
    const { result } = renderHook(() => useEventProcessor({ refs }), { wrapper: createWrapper() });

    // Ticks arrive ascending — opposite of the documented newest-first contract.
    const ticks = [
      createTick('2026-04-30T09:00:00Z'),
      createTick('2026-04-30T09:30:00Z'),
      createTick('2026-04-30T10:00:00Z'),
    ];

    act(() => {
      result.current.handleSessionEvent(createStatsEvent({ ticks }));
    });

    const cached = queryClient.getQueryData<SessionDetail>(SESSION_DETAIL_QUERY_KEY('session-abc'));
    expect(cached!.lastTickAt).toBe('2026-04-30T10:00:00Z');
    expect(cached!.firstTickAt).toBe('2026-04-30T09:00:00Z');
    // Cached ticks are normalized to newest-first.
    expect(cached!.ticks.map((tick) => tick.climbedAt)).toEqual([
      '2026-04-30T10:00:00Z',
      '2026-04-30T09:30:00Z',
      '2026-04-30T09:00:00Z',
    ]);
  });

  it('handles mixed-timezone climbedAt strings via epoch comparison', () => {
    queryClient.setQueryData(SESSION_DETAIL_QUERY_KEY('session-abc'), createExistingSession());

    const refs = createRefs();
    const { result } = renderHook(() => useEventProcessor({ refs }), { wrapper: createWrapper() });

    // 14:30+05:30 == 09:00Z; 12:00Z is later; 11:00Z is earliest in absolute time.
    const ticks = [
      createTick('2026-04-30T11:00:00Z'),
      createTick('2026-04-30T14:30:00+05:30'),
      createTick('2026-04-30T12:00:00Z'),
    ];

    act(() => {
      result.current.handleSessionEvent(createStatsEvent({ ticks }));
    });

    const cached = queryClient.getQueryData<SessionDetail>(SESSION_DETAIL_QUERY_KEY('session-abc'));
    expect(cached!.lastTickAt).toBe('2026-04-30T12:00:00Z');
    expect(cached!.firstTickAt).toBe('2026-04-30T14:30:00+05:30');
  });

  it('preserves prev firstTickAt/lastTickAt when merging with no ticks', () => {
    queryClient.setQueryData(SESSION_DETAIL_QUERY_KEY('session-abc'), createExistingSession());

    const refs = createRefs();
    const { result } = renderHook(() => useEventProcessor({ refs }), { wrapper: createWrapper() });

    act(() => {
      result.current.handleSessionEvent(createStatsEvent({ ticks: [] }));
    });

    const cached = queryClient.getQueryData<SessionDetail>(SESSION_DETAIL_QUERY_KEY('session-abc'));
    expect(cached!.firstTickAt).toBe('2026-04-30T08:00:00Z');
    expect(cached!.lastTickAt).toBe('2026-04-30T09:00:00Z');
  });

  it('notifies session event subscribers', () => {
    const refs = createRefs();
    const subscriberCalls: SessionEvent[] = [];
    (refs.sessionEventSubscribersRef as { current: Set<(event: SessionEvent) => void> }).current.add((e) =>
      subscriberCalls.push(e),
    );

    const { result } = renderHook(() => useEventProcessor({ refs }), { wrapper: createWrapper() });

    const event = createStatsEvent();
    act(() => {
      result.current.handleSessionEvent(event);
    });

    expect(subscriberCalls).toHaveLength(1);
    expect(subscriberCalls[0]).toBe(event);
  });

  it('handles non-SessionStatsUpdated events without touching cache', () => {
    const refs = createRefs();
    const { result } = renderHook(() => useEventProcessor({ refs }), { wrapper: createWrapper() });

    act(() => {
      result.current.handleSessionEvent({
        __typename: 'UserJoined',
        user: { id: 'user-1', username: 'test', isLeader: false, connectionState: 'CONNECTED' },
      });
    });

    const cached = queryClient.getQueryData<SessionDetail>(SESSION_DETAIL_QUERY_KEY('session-abc'));
    expect(cached).toBeUndefined();
  });
});

describe('useEventProcessor - SharedPlaylistToggled → activeSession setter', () => {
  let queryClient: QueryClient;

  function createWrapper() {
    return ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);
  }

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('routes a matching SharedPlaylistToggled event through setActiveSessionSharedPlaylistEnabled', () => {
    const refs = createRefs();
    refs.activeSessionRef.current = makeActiveSession({ sharedPlaylistEnabled: true });
    const setterCalls: Array<[string, boolean]> = [];
    refs.setActiveSessionSharedPlaylistEnabledRef.current = (sessionId, enabled) => {
      setterCalls.push([sessionId, enabled]);
    };

    const { result } = renderHook(() => useEventProcessor({ refs }), { wrapper: createWrapper() });

    act(() => {
      result.current.handleSessionEvent({
        __typename: 'SharedPlaylistToggled',
        sessionId: 'session-abc',
        enabled: false,
      });
    });

    expect(setterCalls).toEqual([['session-abc', false]]);
  });

  it('ignores SharedPlaylistToggled when the event sessionId does not match activeSession', () => {
    const refs = createRefs();
    refs.activeSessionRef.current = makeActiveSession({ sharedPlaylistEnabled: true });
    const setterCalls: Array<[string, boolean]> = [];
    refs.setActiveSessionSharedPlaylistEnabledRef.current = (sessionId, enabled) => {
      setterCalls.push([sessionId, enabled]);
    };

    const { result } = renderHook(() => useEventProcessor({ refs }), { wrapper: createWrapper() });

    act(() => {
      result.current.handleSessionEvent({
        __typename: 'SharedPlaylistToggled',
        sessionId: 'session-other',
        enabled: false,
      });
    });

    expect(setterCalls).toHaveLength(0);
  });

  it('is a no-op when there is no active session', () => {
    const refs = createRefs();
    refs.activeSessionRef.current = null;
    const setterCalls: Array<[string, boolean]> = [];
    refs.setActiveSessionSharedPlaylistEnabledRef.current = (sessionId, enabled) => {
      setterCalls.push([sessionId, enabled]);
    };

    const { result } = renderHook(() => useEventProcessor({ refs }), { wrapper: createWrapper() });

    act(() => {
      result.current.handleSessionEvent({
        __typename: 'SharedPlaylistToggled',
        sessionId: 'session-abc',
        enabled: true,
      });
    });

    expect(setterCalls).toHaveLength(0);
  });

  it('always notifies session event subscribers even for SharedPlaylistToggled', () => {
    const refs = createRefs();
    refs.activeSessionRef.current = makeActiveSession({ sharedPlaylistEnabled: true });
    refs.setActiveSessionSharedPlaylistEnabledRef.current = () => {};
    const subscriberCalls: SessionEvent[] = [];
    (refs.sessionEventSubscribersRef as { current: Set<(event: SessionEvent) => void> }).current.add((e) =>
      subscriberCalls.push(e),
    );

    const { result } = renderHook(() => useEventProcessor({ refs }), { wrapper: createWrapper() });

    const event: SessionEvent = {
      __typename: 'SharedPlaylistToggled',
      sessionId: 'session-abc',
      enabled: false,
    };
    act(() => {
      result.current.handleSessionEvent(event);
    });

    expect(subscriberCalls).toHaveLength(1);
    expect(subscriberCalls[0]).toBe(event);
  });
});
