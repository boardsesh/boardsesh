import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, waitFor, act } from '@testing-library/react';
import { createBoardAdapterWrapper, createTestQueryClient } from '@/app/test-utils/test-providers';
import type { ExecuteHttp } from '@boardsesh/board-react';
import { useWsAuthToken } from '../use-ws-auth-token';
import { useSession } from 'next-auth/react';
import {
  useLogbook,
  useInvalidateLogbook,
  logbookQueryKey,
  accumulatedLogbookQueryKey,
  type LogbookEntry,
} from '@boardsesh/board-react';

vi.mock('../use-ws-auth-token', () => ({
  useWsAuthToken: vi.fn(),
}));

vi.mock('next-auth/react', () => ({
  useSession: vi.fn(),
}));

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

vi.mock('@boardsesh/graphql/operations', () => ({
  GET_TICKS: 'GET_TICKS_QUERY',
}));

const mockUseWsAuthToken = vi.mocked(useWsAuthToken);
const mockUseSession = vi.mocked(useSession);

// Reads current mock state at render time so tests that flip auth via
// `mockUseSession.mockReturnValue(...)` + `rerender()` see the new state.
function mkWrapper(queryClient?: ReturnType<typeof createTestQueryClient>) {
  return createBoardAdapterWrapper(
    () => ({
      isAuthenticated: mockUseSession().status === 'authenticated',
      isAuthLoading: mockUseSession().status === 'loading',
      executeHttp: (async (query: string, variables?: object) =>
        mockRequest(query, variables)) as unknown as ExecuteHttp,
    }),
    queryClient ? { queryClient } : {},
  );
}

describe('useLogbook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mockRequest.mockReset();
  });

  it('returns empty logbook when disabled (no session)', async () => {
    mockUseSession.mockReturnValue({
      status: 'unauthenticated',
      data: null,
      update: vi.fn(),
    });

    const { result } = renderHook(() => useLogbook('kilter', ['uuid-1']), {
      wrapper: mkWrapper(),
    });

    // Query should not execute
    expect(result.current.logbook).toEqual([]);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('returns empty logbook when no token', async () => {
    mockUseWsAuthToken.mockReturnValue({
      token: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    });
    mockUseSession.mockReturnValue({
      status: 'unauthenticated',
      data: null,
      update: vi.fn(),
    });

    const { result } = renderHook(() => useLogbook('kilter', ['uuid-1']), {
      wrapper: mkWrapper(),
    });

    expect(result.current.logbook).toEqual([]);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('returns empty logbook when empty climbUuids', async () => {
    const { result } = renderHook(() => useLogbook('kilter', []), {
      wrapper: mkWrapper(),
    });

    expect(result.current.logbook).toEqual([]);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('creates the accumulated cache entry even when the initial fetch is empty', async () => {
    mockRequest.mockResolvedValue({ ticks: [] });

    const queryClient = createTestQueryClient();
    const { result } = renderHook(() => useLogbook('kilter', ['climb-1']), { wrapper: mkWrapper(queryClient) });

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    expect(result.current.logbook).toEqual([]);
    expect(queryClient.getQueryData(accumulatedLogbookQueryKey('kilter'))).toEqual([]);
  });

  it('fetches and transforms ticks when enabled', async () => {
    mockRequest.mockResolvedValue({
      ticks: [
        {
          uuid: 'tick-1',
          climbUuid: 'climb-1',
          angle: 40,
          isMirror: false,
          attemptCount: 3,
          quality: 4,
          difficulty: 10,
          isBenchmark: false,
          comment: 'Nice climb',
          climbedAt: '2024-01-01',
          status: 'send',
        },
      ],
    });

    const { result } = renderHook(() => useLogbook('kilter', ['climb-1']), {
      wrapper: mkWrapper(),
    });

    await waitFor(() => {
      expect(result.current.logbook.length).toBe(1);
    });

    expect(result.current.logbook[0]).toEqual({
      uuid: 'tick-1',
      climb_uuid: 'climb-1',
      angle: 40,
      is_mirror: false,
      tries: 3,
      quality: 4,
      difficulty: 10,
      // `ticks` query doesn't return `effectiveDifficulty`; toLogbookEntry
      // falls back to the raw override.
      effectiveDifficulty: 10,
      comment: 'Nice climb',
      climbed_at: '2024-01-01',
      is_ascent: true,
      status: 'send',
      upvotes: 0,
      downvotes: 0,
      commentCount: 0,
    });
  });

  it('transformTicks maps fields correctly', async () => {
    mockRequest.mockResolvedValue({
      ticks: [
        {
          uuid: 'tick-2',
          climbUuid: 'climb-2',
          angle: 20,
          isMirror: true,
          attemptCount: 1,
          quality: null,
          difficulty: null,
          isBenchmark: true,
          comment: '',
          climbedAt: '2024-06-15',
          status: 'flash',
        },
      ],
    });

    const { result } = renderHook(() => useLogbook('tension', ['climb-2']), {
      wrapper: mkWrapper(),
    });

    await waitFor(() => {
      expect(result.current.logbook.length).toBe(1);
    });

    const entry = result.current.logbook[0];
    expect(entry.is_mirror).toBe(true);
    expect(entry.quality).toBeNull();
    expect(entry.difficulty).toBeNull();
    expect(entry.is_ascent).toBe(true);
    expect(entry.status).toBe('flash');
  });

  it('logbookQueryKey sorts climbUuids for stability', () => {
    const key1 = logbookQueryKey('kilter', ['c', 'a', 'b']);
    const key2 = logbookQueryKey('kilter', ['b', 'a', 'c']);

    expect(key1).toEqual(key2);
    expect(key1[2]).toBe('a,b,c');
  });

  it('handles loading state', () => {
    mockRequest.mockReturnValue(new Promise(() => {})); // never resolves

    const { result } = renderHook(() => useLogbook('kilter', ['climb-1']), {
      wrapper: mkWrapper(),
    });

    expect(result.current.isLoading).toBe(true);
  });

  it('query key includes boardName and sorted UUIDs', () => {
    const key = logbookQueryKey('tension', ['z-uuid', 'a-uuid']);
    expect(key[0]).toBe('logbook');
    expect(key[1]).toBe('tension');
    expect(key[2]).toBe('a-uuid,z-uuid');
  });

  it('is_ascent is true for flash/send, false for attempt', async () => {
    mockRequest.mockResolvedValue({
      ticks: [
        {
          uuid: 'tick-flash',
          climbUuid: 'climb-1',
          angle: 30,
          isMirror: false,
          attemptCount: 1,
          quality: null,
          difficulty: null,
          isBenchmark: false,
          comment: '',
          climbedAt: '2024-01-01',
          status: 'flash',
        },
        {
          uuid: 'tick-send',
          climbUuid: 'climb-1',
          angle: 30,
          isMirror: false,
          attemptCount: 5,
          quality: null,
          difficulty: null,
          isBenchmark: false,
          comment: '',
          climbedAt: '2024-01-02',
          status: 'send',
        },
        {
          uuid: 'tick-attempt',
          climbUuid: 'climb-1',
          angle: 30,
          isMirror: false,
          attemptCount: 2,
          quality: null,
          difficulty: null,
          isBenchmark: false,
          comment: '',
          climbedAt: '2024-01-03',
          status: 'attempt',
        },
      ],
    });

    const { result } = renderHook(() => useLogbook('kilter', ['climb-1']), {
      wrapper: mkWrapper(),
    });

    await waitFor(() => {
      expect(result.current.logbook.length).toBe(3);
    });

    expect(result.current.logbook[0].is_ascent).toBe(true); // flash
    expect(result.current.logbook[1].is_ascent).toBe(true); // send
    expect(result.current.logbook[2].is_ascent).toBe(false); // attempt
  });

  it('accumulates entries across multiple fetches', async () => {
    // First fetch returns tick for climb-1
    mockRequest.mockResolvedValueOnce({
      ticks: [
        {
          uuid: 'tick-1',
          climbUuid: 'climb-1',
          angle: 40,
          isMirror: false,
          attemptCount: 1,
          quality: null,
          difficulty: null,
          isBenchmark: false,
          comment: '',
          climbedAt: '2024-01-01',
          status: 'send',
        },
      ],
    });

    const { result, rerender } = renderHook(({ uuids }: { uuids: string[] }) => useLogbook('kilter', uuids), {
      wrapper: mkWrapper(),
      initialProps: { uuids: ['climb-1'] },
    });

    await waitFor(() => {
      expect(result.current.logbook.length).toBe(1);
    });
    expect(result.current.logbook[0].uuid).toBe('tick-1');

    // Second fetch returns tick for climb-2
    mockRequest.mockResolvedValueOnce({
      ticks: [
        {
          uuid: 'tick-2',
          climbUuid: 'climb-2',
          angle: 30,
          isMirror: false,
          attemptCount: 2,
          quality: null,
          difficulty: null,
          isBenchmark: false,
          comment: '',
          climbedAt: '2024-01-02',
          createdAt: '2024-01-02T10:00:00Z',
          updatedAt: '2024-01-02T10:00:00Z',
          status: 'flash',
          auroraId: null,
        },
      ],
    });

    // Expand the UUID list (simulates loading a new page)
    rerender({ uuids: ['climb-1', 'climb-2'] });

    await waitFor(() => {
      expect(result.current.logbook.length).toBe(2);
    });

    // Both entries should be present (accumulated)
    expect(result.current.logbook.find((e) => e.uuid === 'tick-1')).toBeDefined();
    expect(result.current.logbook.find((e) => e.uuid === 'tick-2')).toBeDefined();
    // climb-1 should NOT have been re-fetched
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('does not re-fetch already-fetched UUIDs', async () => {
    mockRequest.mockResolvedValueOnce({
      ticks: [
        {
          uuid: 'tick-1',
          climbUuid: 'climb-1',
          angle: 40,
          isMirror: false,
          attemptCount: 1,
          quality: null,
          difficulty: null,
          isBenchmark: false,
          comment: '',
          climbedAt: '2024-01-01',
          status: 'send',
        },
      ],
    });

    const { result, rerender } = renderHook(({ uuids }: { uuids: string[] }) => useLogbook('kilter', uuids), {
      wrapper: mkWrapper(),
      initialProps: { uuids: ['climb-1'] },
    });

    await waitFor(() => {
      expect(result.current.logbook.length).toBe(1);
    });

    // Re-render with the same UUIDs — should not trigger another fetch
    rerender({ uuids: ['climb-1'] });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(result.current.logbook.length).toBe(1);
  });

  it('syncs external cache updates from useSaveTick', async () => {
    const queryClient = createTestQueryClient();

    mockRequest.mockResolvedValueOnce({
      ticks: [
        {
          uuid: 'tick-1',
          climbUuid: 'climb-1',
          angle: 40,
          isMirror: false,
          attemptCount: 1,
          quality: null,
          difficulty: null,
          isBenchmark: false,
          comment: '',
          climbedAt: '2024-01-01',
          status: 'send',
        },
      ],
    });

    const { result } = renderHook(() => useLogbook('kilter', ['climb-1']), { wrapper: mkWrapper(queryClient) });

    await waitFor(() => {
      expect(result.current.logbook.length).toBe(1);
    });

    // Simulate useSaveTick's optimistic update against the accumulated query.
    const optimisticEntry: LogbookEntry = {
      uuid: 'temp-123',
      climb_uuid: 'climb-1',
      angle: 40,
      is_mirror: false,
      tries: 1,
      quality: null,
      difficulty: null,
      effectiveDifficulty: null,
      comment: 'optimistic',
      climbed_at: '2024-02-01',
      is_ascent: true,
      status: 'flash',
      upvotes: 0,
      downvotes: 0,
      commentCount: 0,
    };

    act(() => {
      queryClient.setQueryData<LogbookEntry[]>(accumulatedLogbookQueryKey('kilter'), (old = []) => [
        optimisticEntry,
        ...old,
      ]);
    });

    await waitFor(() => {
      expect(result.current.logbook.length).toBe(2);
    });

    expect(result.current.logbook.find((e) => e.uuid === 'temp-123')).toBeDefined();
  });

  it('clears logbook when auth is lost', async () => {
    mockRequest.mockResolvedValueOnce({
      ticks: [
        {
          uuid: 'tick-1',
          climbUuid: 'climb-1',
          angle: 40,
          isMirror: false,
          attemptCount: 1,
          quality: null,
          difficulty: null,
          isBenchmark: false,
          comment: '',
          climbedAt: '2024-01-01',
          status: 'send',
        },
      ],
    });

    const { result, rerender } = renderHook(() => useLogbook('kilter', ['climb-1']), {
      wrapper: mkWrapper(),
    });

    await waitFor(() => {
      expect(result.current.logbook.length).toBe(1);
    });

    // Simulate logout
    mockUseSession.mockReturnValue({
      status: 'unauthenticated',
      data: null,
      update: vi.fn(),
    });

    rerender();

    await waitFor(() => {
      expect(result.current.logbook).toEqual([]);
    });
  });

  it('re-fetches after auth is restored', async () => {
    mockRequest.mockResolvedValue({
      ticks: [
        {
          uuid: 'tick-1',
          climbUuid: 'climb-1',
          angle: 40,
          isMirror: false,
          attemptCount: 1,
          quality: null,
          difficulty: null,
          isBenchmark: false,
          comment: '',
          climbedAt: '2024-01-01',
          status: 'send',
        },
      ],
    });

    const { result, rerender } = renderHook(() => useLogbook('kilter', ['climb-1']), {
      wrapper: mkWrapper(),
    });

    await waitFor(() => {
      expect(result.current.logbook.length).toBe(1);
    });

    expect(mockRequest).toHaveBeenCalledTimes(1);

    // Simulate logout
    mockUseSession.mockReturnValue({
      status: 'unauthenticated',
      data: null,
      update: vi.fn(),
    });
    rerender();

    await waitFor(() => {
      expect(result.current.logbook).toEqual([]);
    });

    // Simulate re-login
    mockUseSession.mockReturnValue({
      status: 'authenticated',
      data: { user: { id: '1' }, expires: '' },
      update: vi.fn(),
    });
    rerender();

    await waitFor(() => {
      expect(result.current.logbook.length).toBe(1);
    });

    // Should have fetched again after re-auth
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });
});

describe('useInvalidateLogbook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mockRequest.mockReset();
  });

  it('returns a function', () => {
    const { result } = renderHook(() => useInvalidateLogbook('kilter'), {
      wrapper: mkWrapper(),
    });

    expect(typeof result.current).toBe('function');
  });

  it('resets tracking and triggers re-fetch', async () => {
    mockRequest.mockResolvedValue({
      ticks: [
        {
          uuid: 'tick-1',
          climbUuid: 'climb-1',
          angle: 40,
          isMirror: false,
          attemptCount: 1,
          quality: null,
          difficulty: null,
          isBenchmark: false,
          comment: '',
          climbedAt: '2024-01-01',
          status: 'send',
        },
      ],
    });

    const queryClient = createTestQueryClient();

    const { result } = renderHook(
      () => {
        const logbook = useLogbook('kilter', ['climb-1']);
        const invalidate = useInvalidateLogbook('kilter');
        return { ...logbook, invalidate };
      },
      { wrapper: mkWrapper(queryClient) },
    );

    // Wait for initial fetch
    await waitFor(() => {
      expect(result.current.logbook.length).toBe(1);
    });
    expect(mockRequest).toHaveBeenCalledTimes(1);

    // Invalidate — should clear state and trigger re-fetch
    act(() => {
      result.current.invalidate();
    });

    await waitFor(() => {
      // Should have fetched again after invalidation
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    await waitFor(() => {
      expect(result.current.logbook.length).toBe(1);
    });
  });
});
