// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BoardName } from '@/app/lib/types';

// Hoisted mocks must precede the SUT import.
const { createClientMock, subscribeMock, getBackendWsUrlMock, useWsAuthTokenMock, disposeMock, unsubMock } = vi.hoisted(
  () => {
    const disposeMock = vi.fn();
    const unsubMock = vi.fn();
    const subscribeMock = vi.fn(() => unsubMock);
    const createClientMock = vi.fn(() => ({
      dispose: disposeMock,
      subscribe: vi.fn(),
    }));
    const getBackendWsUrlMock = vi.fn<() => string | null>(() => 'wss://example.test/graphql');
    const useWsAuthTokenMock = vi.fn<() => { token: string | null; isAuthenticated: boolean }>(() => ({
      token: 'test-token',
      isAuthenticated: true,
    }));
    return { createClientMock, subscribeMock, getBackendWsUrlMock, useWsAuthTokenMock, disposeMock, unsubMock };
  },
);

vi.mock('@/app/components/graphql-queue/graphql-client', () => ({
  createGraphQLClient: createClientMock,
  subscribe: subscribeMock,
}));

vi.mock('@/app/lib/backend-url', () => ({
  getBackendWsUrl: getBackendWsUrlMock,
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => useWsAuthTokenMock(),
}));

import { useSubscribeClimbStatsLayout } from '../use-subscribe-climb-stats-layout';

const BOARD: BoardName = 'kilter';
const LAYOUT_ID = 1;

let queryClient: QueryClient;
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  createClientMock.mockClear();
  subscribeMock.mockClear();
  disposeMock.mockClear();
  unsubMock.mockClear();
  getBackendWsUrlMock.mockReturnValue('wss://example.test/graphql');
  useWsAuthTokenMock.mockReturnValue({ token: 'test-token', isAuthenticated: true });
});

describe('useSubscribeClimbStatsLayout', () => {
  it('does not subscribe when boardName or layoutId is missing', () => {
    renderHook(() => useSubscribeClimbStatsLayout(undefined, LAYOUT_ID), { wrapper });
    renderHook(() => useSubscribeClimbStatsLayout(BOARD, undefined), { wrapper });
    renderHook(() => useSubscribeClimbStatsLayout(BOARD, null), { wrapper });
    expect(createClientMock).not.toHaveBeenCalled();
    expect(subscribeMock).not.toHaveBeenCalled();
  });

  it('does not subscribe for anonymous users', () => {
    useWsAuthTokenMock.mockReturnValue({ token: null, isAuthenticated: false });
    renderHook(() => useSubscribeClimbStatsLayout(BOARD, LAYOUT_ID), { wrapper });
    expect(createClientMock).not.toHaveBeenCalled();
    expect(subscribeMock).not.toHaveBeenCalled();
  });

  it('does not subscribe when no QueryClientProvider wraps the tree', () => {
    renderHook(() => useSubscribeClimbStatsLayout(BOARD, LAYOUT_ID));
    expect(createClientMock).not.toHaveBeenCalled();
    expect(subscribeMock).not.toHaveBeenCalled();
  });

  it('does not subscribe when getBackendWsUrl returns null', () => {
    getBackendWsUrlMock.mockReturnValue(null);
    renderHook(() => useSubscribeClimbStatsLayout(BOARD, LAYOUT_ID), { wrapper });
    expect(createClientMock).not.toHaveBeenCalled();
    expect(subscribeMock).not.toHaveBeenCalled();
  });

  it('creates one shared client for two concurrent subscribers on the same token and disposes it after the last unmount', () => {
    const a = renderHook(() => useSubscribeClimbStatsLayout(BOARD, 1), { wrapper });
    const b = renderHook(() => useSubscribeClimbStatsLayout(BOARD, 2), { wrapper });

    // One shared anonymous-ish client across the two hooks; one subscribe per hook.
    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock).toHaveBeenCalledTimes(2);
    expect(disposeMock).not.toHaveBeenCalled();

    a.unmount();
    expect(unsubMock).toHaveBeenCalledTimes(1);
    expect(disposeMock).not.toHaveBeenCalled();

    b.unmount();
    expect(unsubMock).toHaveBeenCalledTimes(2);
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it('disposes the old shared client and creates a new one when the auth token changes', () => {
    const a = renderHook(() => useSubscribeClimbStatsLayout(BOARD, 1), { wrapper });
    expect(createClientMock).toHaveBeenCalledTimes(1);

    // Simulate a session change (e.g. user re-auth refreshing the token).
    useWsAuthTokenMock.mockReturnValue({ token: 'new-token', isAuthenticated: true });
    renderHook(() => useSubscribeClimbStatsLayout(BOARD, 2), { wrapper });
    expect(disposeMock).toHaveBeenCalledTimes(1);
    expect(createClientMock).toHaveBeenCalledTimes(2);

    a.unmount();
    // a's release targets the old (already-disposed) entry, not the new
    // shared. With the captured-entry fix, no crash and no off-by-one on
    // the new client's refCount.
  });

  it('passes (boardType, layoutId) as the subscription variables', () => {
    renderHook(() => useSubscribeClimbStatsLayout(BOARD, 42), { wrapper });
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    const firstCall = (subscribeMock.mock.calls as unknown as unknown[][])[0];
    const op = firstCall[1] as { variables: { boardType: string; layoutId: number } };
    expect(op.variables).toEqual({ boardType: BOARD, layoutId: 42 });
  });
});
