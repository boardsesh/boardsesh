// @vitest-environment jsdom
// useFollowingClimbLogs is the only reader of other climbers' logs on a climb.
// These pin what makes it safe: network only, scoped to the viewer, never
// showing one climb's rows under another, and silent whenever it is not wanted.
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GET_FOLLOWING_CLIMB_ASCENTS } from '@boardsesh/graphql/operations';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  offlineAwareRequest: vi.fn(),
  viewerId: 'viewer' as string | undefined,
}));

vi.mock('../../client', () => ({ getHttpClient: () => ({ request: mocks.request }) }));
vi.mock('../../offline-request', () => ({ offlineAwareRequest: mocks.offlineAwareRequest }));
vi.mock('../../../../hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: mocks.viewerId, isLoading: false }),
}));

import { useClimbDwell, useFollowingClimbLogs } from '../use-following-climb-logs';
import { FOLLOWING_CLIMB_LOGS_QUERY_KEY, followingClimbLogsQueryKey } from '../../query-keys';

function answer(uuid: string) {
  return {
    followingClimbAscents: {
      items: [{ uuid }],
      hasMore: false,
      summary: { climberCount: 1, senderCount: 1, byAngle: [] },
    },
  };
}

function createHarness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
}

async function expectNoRequest(result: { current: { fetchStatus: string; isIdle: boolean; isLoading: boolean } }) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(mocks.request).not.toHaveBeenCalled();
  expect(result.current.fetchStatus).toBe('idle');
  expect(result.current.isIdle).toBe(true);
  // The trap a caller must not fall into: a disabled query is `pending` forever,
  // so "loading" has to come from `isLoading`.
  expect(result.current.isLoading).toBe(false);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.viewerId = 'viewer';
  mocks.request.mockImplementation(async (_document: unknown, variables: { input: { climbUuid: string } }) =>
    answer(`log-on-${variables.input.climbUuid}`),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('followingClimbLogsQueryKey', () => {
  it('is the root, the viewer, the board and the climb, with no angle', () => {
    expect(FOLLOWING_CLIMB_LOGS_QUERY_KEY).toBe('followingClimbLogs');
    expect(followingClimbLogsQueryKey('viewer', 'kilter', 'c1')).toEqual([
      'followingClimbLogs',
      'viewer',
      'kilter',
      'c1',
    ]);
  });
});

describe('useFollowingClimbLogs', () => {
  it('asks the server directly with only the board and the climb', async () => {
    const { client, wrapper } = createHarness();
    const { result } = renderHook(() => useFollowingClimbLogs('kilter', 'c1'), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toEqual(answer('log-on-c1').followingClimbAscents);
    expect(result.current.isIdle).toBe(false);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith(GET_FOLLOWING_CLIMB_ASCENTS, {
      input: { boardType: 'kilter', climbUuid: 'c1' },
    });
    // Never the offline interceptor: there is no local copy of these logs to read.
    expect(mocks.offlineAwareRequest).not.toHaveBeenCalled();
    expect(client.getQueryData(['followingClimbLogs', 'viewer', 'kilter', 'c1'])).toBeDefined();
  });

  it('stays silent without a viewer id', async () => {
    mocks.viewerId = undefined;
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useFollowingClimbLogs('kilter', 'c1'), { wrapper });
    await expectNoRequest(result);
  });

  it('stays silent without a climb', async () => {
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useFollowingClimbLogs('kilter', null), { wrapper });
    await expectNoRequest(result);
  });

  it('stays silent when the caller turns it off', async () => {
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useFollowingClimbLogs('kilter', 'c1', { enabled: false }), { wrapper });
    await expectNoRequest(result);
  });

  it('stays silent in screenshot mode', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useFollowingClimbLogs('kilter', 'c1'), { wrapper });
    await expectNoRequest(result);
  });

  it("never shows the previous climb's rows while the next climb loads", async () => {
    const { wrapper } = createHarness();
    const { result, rerender } = renderHook(({ climbUuid }) => useFollowingClimbLogs('kilter', climbUuid), {
      wrapper,
      initialProps: { climbUuid: 'c1' },
    });
    await waitFor(() => expect(result.current.data?.items[0].uuid).toBe('log-on-c1'));

    let release: (value: unknown) => void = () => {};
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    rerender({ climbUuid: 'c2' });

    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      release(answer('log-on-c2'));
    });
    await waitFor(() => expect(result.current.data?.items[0].uuid).toBe('log-on-c2'));
  });

  it("never answers one account with another account's rows", async () => {
    const { wrapper } = createHarness();
    const { result, rerender } = renderHook(() => useFollowingClimbLogs('kilter', 'c1'), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    mocks.request.mockImplementationOnce(() => new Promise(() => {}));
    mocks.viewerId = 'someone-else';
    rerender();

    expect(result.current.data).toBeUndefined();
  });
});

describe('useClimbDwell', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is false until the climb has stayed put for the window', () => {
    const { result } = renderHook(() => useClimbDwell('c1'));
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(599);
    });
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it('starts over on a new climb, so a fast swipe never dwells', () => {
    const { result, rerender } = renderHook(({ climbUuid }) => useClimbDwell(climbUuid), {
      initialProps: { climbUuid: 'c1' },
    });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(result.current).toBe(true);

    for (const climbUuid of ['c2', 'c3', 'c4']) {
      rerender({ climbUuid });
      // False on the very first render of the new climb, not one frame later.
      expect(result.current).toBe(false);
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(result.current).toBe(false);
    }

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toBe(true);
  });

  it('honours a custom window', () => {
    const { result } = renderHook(() => useClimbDwell('c1', 100));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe(true);
  });
});
