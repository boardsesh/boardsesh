import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEventProcessor } from '../hooks/use-event-processor';
import type { ClimbQueueItem as LocalClimbQueueItem } from '../../queue-control/types';
import type {
  SessionEvent,
  SessionDetail,
  SessionDetailTick,
  SubscriptionQueueEvent,
  BetaLinksGqlRow,
} from '@boardsesh/shared-schema';
import type { SessionStatsUpdated } from '@boardsesh/shared-schema/generated';
import { SESSION_DETAIL_QUERY_KEY } from '@/app/hooks/use-session-detail';

function createRefs() {
  return {
    lastReceivedSequenceRef: { current: null as number | null },
    triggerResyncRef: { current: null as (() => void) | null },
    lastCorruptionResyncRef: { current: 0 },
    isFilteringCorruptedItemsRef: { current: false },
    queueEventSubscribersRef: { current: new Set<(event: SubscriptionQueueEvent) => void>() },
    sessionEventSubscribersRef: { current: new Set<(event: SessionEvent) => void>() },
    offlineBufferRef: { current: [] as LocalClimbQueueItem[] },
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

function createTick(climbedAt: string, overrides: Partial<SessionDetailTick> = {}): SessionDetailTick {
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
    ...overrides,
  };
}

function betaRow(overrides: Partial<BetaLinksGqlRow> = {}): BetaLinksGqlRow {
  return {
    climbUuid: 'climb-1',
    link: 'https://www.instagram.com/reel/abc/',
    foreignUsername: 'setter',
    angle: 40,
    thumbnail: null,
    isListed: true,
    createdAt: '2026-04-30T08:00:00Z',
    tickUuid: null,
    boardId: null,
    ...overrides,
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
        sessionType: 'party',
        sessionName: 'My Session',
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
    expect(cached!.sessionType).toBe('party');
    expect(cached!.ownerUserId).toBe('owner-123');
    expect(cached!.sessionName).toBe('My Session');
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

  it('carries over per-tick beta links from the cache when the stats event omits them', () => {
    const beta = betaRow();
    queryClient.setQueryData(
      SESSION_DETAIL_QUERY_KEY('session-abc'),
      createExistingSession({ ticks: [createTick('2026-04-30T09:00:00Z', { betaLinks: [beta] })] }),
    );

    const refs = createRefs();
    const { result } = renderHook(() => useEventProcessor({ refs }), { wrapper: createWrapper() });

    // The live SessionStatsUpdated event's ticks omit betaLinks (the subscription
    // doesn't select them), so the optimistic merge must preserve the cached ones.
    act(() => {
      result.current.handleSessionEvent(createStatsEvent({ ticks: [createTick('2026-04-30T09:00:00Z')] }));
    });

    const cached = queryClient.getQueryData<SessionDetail>(SESSION_DETAIL_QUERY_KEY('session-abc'));
    expect(cached!.ticks[0].betaLinks).toEqual([beta]);
  });

  it('keys the beta carry-over by boardType + climbUuid so a shared climb UUID across boards stays separate', () => {
    const kilterBeta = betaRow({ climbUuid: 'shared-climb', link: 'https://www.instagram.com/reel/kilter/' });
    const tensionBeta = betaRow({ climbUuid: 'shared-climb', link: 'https://www.tiktok.com/@t/video/1' });
    queryClient.setQueryData(
      SESSION_DETAIL_QUERY_KEY('session-abc'),
      createExistingSession({
        ticks: [
          createTick('2026-04-30T09:00:00Z', {
            uuid: 'tick-kilter',
            boardType: 'kilter',
            climbUuid: 'shared-climb',
            betaLinks: [kilterBeta],
          }),
          createTick('2026-04-30T09:01:00Z', {
            uuid: 'tick-tension',
            boardType: 'tension',
            climbUuid: 'shared-climb',
            betaLinks: [tensionBeta],
          }),
        ],
      }),
    );

    const refs = createRefs();
    const { result } = renderHook(() => useEventProcessor({ refs }), { wrapper: createWrapper() });

    act(() => {
      result.current.handleSessionEvent(
        createStatsEvent({
          ticks: [
            createTick('2026-04-30T09:00:00Z', { uuid: 'tick-kilter', boardType: 'kilter', climbUuid: 'shared-climb' }),
            createTick('2026-04-30T09:01:00Z', {
              uuid: 'tick-tension',
              boardType: 'tension',
              climbUuid: 'shared-climb',
            }),
          ],
        }),
      );
    });

    const cached = queryClient.getQueryData<SessionDetail>(SESSION_DETAIL_QUERY_KEY('session-abc'));
    const byUuid = new Map(cached!.ticks.map((tick) => [tick.uuid, tick]));
    expect(byUuid.get('tick-kilter')!.betaLinks).toEqual([kilterBeta]);
    expect(byUuid.get('tick-tension')!.betaLinks).toEqual([tensionBeta]);
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
