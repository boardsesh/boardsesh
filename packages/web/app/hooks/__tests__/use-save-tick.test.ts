import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, waitFor, act } from '@testing-library/react';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import { QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useWsAuthToken } from '../use-ws-auth-token';
import { useSession } from 'next-auth/react';
import { useSaveTick, type SaveTickOptions } from '../use-save-tick';
import { accumulatedLogbookQueryKey, type LogbookEntry } from '../use-logbook';

vi.mock('../use-ws-auth-token', () => ({
  useWsAuthToken: vi.fn(),
}));

vi.mock('next-auth/react', () => ({
  useSession: vi.fn(),
}));

const mockShowMessage = vi.fn();
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

vi.mock('@/app/lib/graphql/operations', () => ({
  SAVE_TICK: 'SAVE_TICK_MUTATION',
}));

const mockUseWsAuthToken = vi.mocked(useWsAuthToken);
const mockUseSession = vi.mocked(useSession);

function createTestWrapper() {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { wrapper, queryClient };
}

function createTickOptions(overrides: Partial<SaveTickOptions> = {}): SaveTickOptions {
  return {
    climbUuid: 'climb-1',
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 3,
    isBenchmark: false,
    comment: 'Great climb',
    climbedAt: '2024-01-01',
    ...overrides,
  };
}

function createSavedTick(overrides: Record<string, unknown> = {}) {
  return {
    uuid: 'real-uuid',
    climbUuid: 'climb-1',
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 3,
    quality: null,
    difficulty: null,
    comment: 'Great climb',
    climbedAt: '2024-01-01',
    ...overrides,
  };
}

describe('useSaveTick', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequest.mockReset();
    mockShowMessage.mockReset();
    mockUseWsAuthToken.mockReturnValue({
      token: 'test-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });
    mockUseSession.mockReturnValue({
      status: 'authenticated',
      data: { user: { id: '1' }, expires: '' },
      update: vi.fn(),
    });
  });

  it('throws when not authenticated', async () => {
    mockUseSession.mockReturnValue({
      status: 'unauthenticated',
      data: null,
      update: vi.fn(),
    });

    const { wrapper } = createTestWrapper();

    const { result } = renderHook(() => useSaveTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(createTickOptions());
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Not authenticated');
  });

  it('throws when no token', async () => {
    mockUseWsAuthToken.mockReturnValue({
      token: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    });

    const { wrapper } = createTestWrapper();

    const { result } = renderHook(() => useSaveTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(createTickOptions());
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Auth token not available');
  });

  it('calls GraphQL mutation with correct variables', async () => {
    mockRequest.mockResolvedValue({
      saveTick: createSavedTick(),
    });

    const { wrapper } = createTestWrapper();

    const { result } = renderHook(() => useSaveTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(createTickOptions());
    });

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalled();
    });

    expect(mockRequest).toHaveBeenCalledWith('SAVE_TICK_MUTATION', {
      input: {
        boardType: 'kilter',
        climbUuid: 'climb-1',
        angle: 40,
        isMirror: false,
        status: 'send',
        attemptCount: 3,
        quality: undefined,
        difficulty: undefined,
        isBenchmark: false,
        comment: 'Great climb',
        climbedAt: '2024-01-01',
        sessionId: undefined,
        layoutId: undefined,
        sizeId: undefined,
        setIds: undefined,
      },
    });
  });

  it('creates optimistic entry on mutate', async () => {
    let resolveRequest: (value: unknown) => void;
    mockRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const { wrapper, queryClient } = createTestWrapper();

    queryClient.setQueryData(accumulatedLogbookQueryKey('kilter'), []);

    const { result } = renderHook(() => useSaveTick('kilter'), { wrapper });

    act(() => {
      result.current.mutate(createTickOptions());
    });

    // Check that the optimistic entry was added
    await waitFor(() => {
      const data = queryClient.getQueryData(accumulatedLogbookQueryKey('kilter')) as LogbookEntry[];
      expect(data?.length).toBe(1);
      expect(data?.[0].uuid).toMatch(/^temp-/);
      expect(data?.[0].climb_uuid).toBe('climb-1');
    });

    // Resolve to clean up
    await act(async () => {
      resolveRequest!({
        saveTick: createSavedTick(),
      });
    });
  });

  it('replaces temp UUID with real UUID on success', async () => {
    mockRequest.mockResolvedValue({
      saveTick: createSavedTick({
        uuid: 'server-uuid-123',
      }),
    });

    const { wrapper, queryClient } = createTestWrapper();

    queryClient.setQueryData(accumulatedLogbookQueryKey('kilter'), []);

    const { result } = renderHook(() => useSaveTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(createTickOptions());
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const data = queryClient.getQueryData(accumulatedLogbookQueryKey('kilter')) as LogbookEntry[];
    if (data && data.length > 0) {
      expect(data[0].uuid).toBe('server-uuid-123');
      expect(data[0].comment).toBe('Great climb');
    }
  });

  it('rolls back optimistic entry on error', async () => {
    mockRequest.mockRejectedValue(new Error('Server error'));

    const { wrapper, queryClient } = createTestWrapper();

    queryClient.setQueryData(accumulatedLogbookQueryKey('kilter'), []);

    const { result } = renderHook(() => useSaveTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(createTickOptions());
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    // The optimistic entry should have been rolled back
    const data = queryClient.getQueryData(accumulatedLogbookQueryKey('kilter')) as LogbookEntry[];
    expect(data?.length).toBe(0);
  });

  it('rolls back optimistic entry on failure without showing snackbar', async () => {
    mockRequest.mockRejectedValue(new Error('Save failed'));

    const { wrapper, queryClient } = createTestWrapper();

    queryClient.setQueryData(accumulatedLogbookQueryKey('kilter'), []);

    const { result } = renderHook(() => useSaveTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(createTickOptions());
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    // Optimistic entry should be rolled back
    const data = queryClient.getQueryData(accumulatedLogbookQueryKey('kilter')) as LogbookEntry[];
    expect(data).toEqual([]);

    // Snackbar is NOT called — callers handle their own error feedback
    expect(mockShowMessage).not.toHaveBeenCalled();
  });

  it('optimistic entry has correct is_ascent for flash/send', async () => {
    let resolveRequest: (value: unknown) => void;
    mockRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const { wrapper, queryClient } = createTestWrapper();

    queryClient.setQueryData(accumulatedLogbookQueryKey('kilter'), []);

    const { result } = renderHook(() => useSaveTick('kilter'), { wrapper });

    // Test with 'flash'
    act(() => {
      result.current.mutate(createTickOptions({ status: 'flash' }));
    });

    await waitFor(() => {
      const data = queryClient.getQueryData(accumulatedLogbookQueryKey('kilter')) as LogbookEntry[];
      expect(data?.length).toBe(1);
      expect(data?.[0].is_ascent).toBe(true);
    });

    await act(async () => {
      resolveRequest!({
        saveTick: createSavedTick({
          uuid: 'real-1',
          status: 'flash',
          attemptCount: 1,
        }),
      });
    });
  });

  it('optimistic entry has is_ascent=false for attempt', async () => {
    let resolveRequest: (value: unknown) => void;
    mockRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const { wrapper, queryClient } = createTestWrapper();

    queryClient.setQueryData(accumulatedLogbookQueryKey('kilter'), []);

    const { result } = renderHook(() => useSaveTick('kilter'), { wrapper });

    act(() => {
      result.current.mutate(createTickOptions({ status: 'attempt' }));
    });

    await waitFor(() => {
      const data = queryClient.getQueryData(accumulatedLogbookQueryKey('kilter')) as LogbookEntry[];
      expect(data?.length).toBe(1);
      expect(data?.[0].is_ascent).toBe(false);
    });

    await act(async () => {
      resolveRequest!({
        saveTick: createSavedTick({
          uuid: 'real-2',
          status: 'attempt',
        }),
      });
    });
  });

  it('creates the accumulated cache entry on first save even when no prior ticks were fetched', async () => {
    let resolveRequest: (value: unknown) => void;
    mockRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const { wrapper, queryClient } = createTestWrapper();

    const { result } = renderHook(() => useSaveTick('kilter'), { wrapper });

    act(() => {
      result.current.mutate(createTickOptions({ status: 'flash', attemptCount: 1 }));
    });

    await waitFor(() => {
      const data = queryClient.getQueryData(accumulatedLogbookQueryKey('kilter')) as LogbookEntry[] | undefined;
      expect(data?.length).toBe(1);
      expect(data?.[0].uuid).toMatch(/^temp-/);
      expect(data?.[0].status).toBe('flash');
    });

    await act(async () => {
      resolveRequest!({
        saveTick: createSavedTick({
          uuid: 'real-first',
          status: 'flash',
          attemptCount: 1,
        }),
      });
    });
  });

  it('does not recreate cleared logbook cache on late success', async () => {
    let resolveRequest: (value: unknown) => void;
    mockRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const { wrapper, queryClient } = createTestWrapper();

    queryClient.setQueryData(accumulatedLogbookQueryKey('kilter'), []);

    const { result } = renderHook(() => useSaveTick('kilter'), { wrapper });

    act(() => {
      result.current.mutate(createTickOptions({ status: 'flash', attemptCount: 1 }));
    });

    await waitFor(() => {
      const data = queryClient.getQueryData(accumulatedLogbookQueryKey('kilter')) as LogbookEntry[] | undefined;
      expect(data?.length).toBe(1);
      expect(data?.[0].uuid).toMatch(/^temp-/);
    });

    act(() => {
      queryClient.removeQueries({ queryKey: ['logbook', 'kilter'] });
    });

    expect(queryClient.getQueryData(accumulatedLogbookQueryKey('kilter'))).toBeUndefined();

    await act(async () => {
      resolveRequest!({
        saveTick: createSavedTick({
          uuid: 'real-after-clear',
          status: 'flash',
          attemptCount: 1,
        }),
      });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(queryClient.getQueryData(accumulatedLogbookQueryKey('kilter'))).toBeUndefined();
  });

  it('does not double-bump the ascent delta on two concurrent send mutations', async () => {
    // Two surfaces firing mutate() back-to-back in the same tick (e.g. a
    // double-tap on the tick button) — the cache update is synchronous so
    // the second updater sees the first updater's write and short-circuits
    // instead of bumping ascentDelta a second time. The server's distinct-
    // user count would correct any over-count via the live event, but the
    // UI should never show +2 in the first place.
    let resolveFirst: (value: ReturnType<typeof createSavedTick>) => void = () => undefined;
    let resolveSecond: (value: ReturnType<typeof createSavedTick>) => void = () => undefined;
    mockRequest
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
      );

    const { wrapper, queryClient } = createTestWrapper();
    const { result } = renderHook(() => useSaveTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(createTickOptions());
      result.current.mutate(createTickOptions());
    });

    const liveKey = ['climbStatsLive', 'kilter', 'climb-1', 40];
    const live = queryClient.getQueryData<{ ascentDelta: number }>(liveKey);
    expect(live?.ascentDelta).toBe(1);

    // Cleanup so the test doesn't leak open promises.
    await act(async () => {
      resolveFirst(createSavedTick({ uuid: 'real-1' }));
      resolveSecond(createSavedTick({ uuid: 'real-2' }));
    });
  });

  it('propagates GraphQL errors to the caller', async () => {
    const graphqlError: Error & { response?: { errors: { message: string }[] } } = new Error('GraphQL error');
    graphqlError.response = {
      errors: [{ message: 'Climb not found' }],
    };
    mockRequest.mockRejectedValue(graphqlError);

    const { wrapper } = createTestWrapper();

    const { result } = renderHook(() => useSaveTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(createTickOptions());
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    // Error is propagated so callers can handle their own feedback
    expect(result.current.error).toBe(graphqlError);
    // No snackbar from the hook itself
    expect(mockShowMessage).not.toHaveBeenCalled();
  });
});
