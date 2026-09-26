// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GET_USER_TICKS, GET_USER_PROFILE_STATS, GET_USER_CLIMB_PERCENTILE } from '@boardsesh/graphql/operations';
import { BOARD_TYPES } from '@boardsesh/profile-stats';

// The You page's three reads refetch only when a tick changed AND the screen is
// on screen. These pin the two halves: an invalidation while unsubscribed (off
// screen) sends nothing, and re-subscribing (focus) fetches the stale data — so
// a tick logged elsewhere is on the You page when the climber opens it.

const requestMock = vi.hoisted(() => vi.fn());
vi.mock('../../client', () => ({ getHttpClient: () => ({ request: requestMock }) }));

import { useAllBoardsTicks, useUserProfileStats, useUserClimbPercentile } from '../use-you-data';

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

function useYouPageReads(subscribed: boolean) {
  return {
    ticks: useAllBoardsTicks('user-1', { subscribed }),
    stats: useUserProfileStats('user-1', { subscribed }),
    percentile: useUserClimbPercentile('user-1', { subscribed }),
  };
}

function callsFor(document: string) {
  return requestMock.mock.calls.filter(([calledDocument]) => calledDocument === document).length;
}

beforeEach(() => {
  requestMock.mockReset();
  requestMock.mockImplementation((document: string) => {
    if (document === GET_USER_TICKS) return Promise.resolve({ userTicks: [] });
    if (document === GET_USER_PROFILE_STATS) return Promise.resolve({ userProfileStats: null });
    return Promise.resolve({ userClimbPercentile: null });
  });
});

describe('You page read freshness', () => {
  it('marks the reads stale off screen and refetches them once the screen is back', async () => {
    const { queryClient, wrapper } = makeWrapper();
    const { result, rerender } = renderHook(({ subscribed }) => useYouPageReads(subscribed), {
      wrapper,
      initialProps: { subscribed: true },
    });
    await waitFor(() => expect(result.current.percentile.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.ticks.isSuccess).toBe(true));
    expect(callsFor(GET_USER_TICKS)).toBe(BOARD_TYPES.length);
    expect(callsFor(GET_USER_PROFILE_STATS)).toBe(1);

    // The climber leaves for a climb and logs a tick there.
    rerender({ subscribed: false });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['userTicks'] });
      await queryClient.invalidateQueries({ queryKey: ['userProfileStats'] });
      await queryClient.invalidateQueries({ queryKey: ['userClimbPercentile'] });
    });
    expect(callsFor(GET_USER_TICKS)).toBe(BOARD_TYPES.length);
    expect(callsFor(GET_USER_PROFILE_STATS)).toBe(1);

    // Back on the You page: the stale reads refetch, once.
    rerender({ subscribed: true });
    await waitFor(() => expect(callsFor(GET_USER_TICKS)).toBe(BOARD_TYPES.length * 2));
    await waitFor(() => expect(callsFor(GET_USER_PROFILE_STATS)).toBe(2));
    await waitFor(() => expect(callsFor(GET_USER_CLIMB_PERCENTILE)).toBe(2));
  });

  it('does not refetch fresh data on refocus', async () => {
    const { wrapper } = makeWrapper();
    const { result, rerender } = renderHook(({ subscribed }) => useYouPageReads(subscribed), {
      wrapper,
      initialProps: { subscribed: true },
    });
    await waitFor(() => expect(result.current.ticks.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.stats.isSuccess).toBe(true));

    rerender({ subscribed: false });
    rerender({ subscribed: true });
    // Nothing invalidated and well inside the 30-minute staleTime.
    await act(async () => {
      await Promise.resolve();
    });
    expect(callsFor(GET_USER_TICKS)).toBe(BOARD_TYPES.length);
    expect(callsFor(GET_USER_PROFILE_STATS)).toBe(1);
  });

  it('refetches straight away when the invalidation lands while the screen is up', async () => {
    const { queryClient, wrapper } = makeWrapper();
    const { result } = renderHook(() => useYouPageReads(true), { wrapper });
    await waitFor(() => expect(result.current.stats.isSuccess).toBe(true));

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['userProfileStats'] });
    });
    expect(callsFor(GET_USER_PROFILE_STATS)).toBe(2);
  });
});
