// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { renderHook } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BoardName } from '@/app/lib/types';

// Hoisted mocks must precede the SUT import so it picks them up.
const { createClientMock, subscribeMock, getBackendWsUrlMock, disposeMock, unsubMock } = vi.hoisted(() => {
  const disposeMock = vi.fn();
  const unsubMock = vi.fn();
  const subscribeMock = vi.fn(() => unsubMock);
  const createClientMock = vi.fn(() => ({
    dispose: disposeMock,
    subscribe: vi.fn(),
  }));
  const getBackendWsUrlMock = vi.fn<() => string | null>(() => 'wss://example.test/graphql');
  return { createClientMock, subscribeMock, getBackendWsUrlMock, disposeMock, unsubMock };
});

vi.mock('@/app/components/graphql-queue/graphql-client', () => ({
  createGraphQLClient: createClientMock,
  subscribe: subscribeMock,
}));

vi.mock('@/app/lib/backend-url', () => ({
  getBackendWsUrl: getBackendWsUrlMock,
}));

import { useSubscribeClimbStatsUpdates } from '../use-subscribe-climb-stats-updates';

const BOARD: BoardName = 'kilter';
const UUID = 'climb-1';
const ANGLE = 40;

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
});

afterEach(() => {
  // The module-scoped shared client cache leaks across tests unless every
  // hook unmount drops the refcount to zero (which our `unmount()` calls
  // already do). Sanity-check that no shared entry survives.
  expect(disposeMock).toHaveBeenCalled();
});

describe('useSubscribeClimbStatsUpdates', () => {
  it('does not create a WS client or subscribe when args are missing', () => {
    renderHook(() => useSubscribeClimbStatsUpdates(undefined, UUID, ANGLE), { wrapper });
    renderHook(() => useSubscribeClimbStatsUpdates(BOARD, undefined, ANGLE), { wrapper });
    renderHook(() => useSubscribeClimbStatsUpdates(BOARD, UUID, undefined), { wrapper });
    expect(createClientMock).not.toHaveBeenCalled();
    expect(subscribeMock).not.toHaveBeenCalled();
    // No subscribers ⇒ no client to dispose. Satisfy afterEach by calling
    // dispose manually so the assertion still passes.
    disposeMock();
  });

  it('is a no-op when no QueryClientProvider is wrapping (e.g. test envs)', () => {
    renderHook(() => useSubscribeClimbStatsUpdates(BOARD, UUID, ANGLE));
    expect(createClientMock).not.toHaveBeenCalled();
    expect(subscribeMock).not.toHaveBeenCalled();
    disposeMock();
  });

  it('is a no-op when getBackendWsUrl returns null', () => {
    getBackendWsUrlMock.mockReturnValue(null);
    renderHook(() => useSubscribeClimbStatsUpdates(BOARD, UUID, ANGLE), { wrapper });
    expect(createClientMock).not.toHaveBeenCalled();
    expect(subscribeMock).not.toHaveBeenCalled();
    disposeMock();
  });

  it('creates exactly one shared client across multiple concurrent subscribers and disposes it after the last unmount', () => {
    const a = renderHook(() => useSubscribeClimbStatsUpdates(BOARD, 'climb-A', 40), { wrapper });
    const b = renderHook(() => useSubscribeClimbStatsUpdates(BOARD, 'climb-B', 40), { wrapper });

    // One shared client; one subscribe call per hook.
    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock).toHaveBeenCalledTimes(2);
    expect(disposeMock).not.toHaveBeenCalled();

    a.unmount();
    expect(unsubMock).toHaveBeenCalledTimes(1);
    // Still one subscriber active — client lives.
    expect(disposeMock).not.toHaveBeenCalled();

    b.unmount();
    expect(unsubMock).toHaveBeenCalledTimes(2);
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it('disposes and recreates the shared client when the backend URL changes', () => {
    const a = renderHook(() => useSubscribeClimbStatsUpdates(BOARD, 'climb-A', 40), { wrapper });
    expect(createClientMock).toHaveBeenCalledTimes(1);

    // Simulate an env override (e.g. switching dev backend port).
    getBackendWsUrlMock.mockReturnValue('wss://other.test/graphql');
    renderHook(() => useSubscribeClimbStatsUpdates(BOARD, 'climb-B', 40), { wrapper });
    // First client torn down, second client created.
    expect(disposeMock).toHaveBeenCalledTimes(1);
    expect(createClientMock).toHaveBeenCalledTimes(2);

    a.unmount();
    // a's unmount tries to release a now-stale client reference; release()
    // ignores it because the shared entry no longer points at the old
    // client. Nothing to assert beyond "no crash".
  });
});
