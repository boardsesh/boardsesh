import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import { useWsAuthToken } from '../use-ws-auth-token';
import { useSession } from 'next-auth/react';
import { useUpdateTick } from '../use-update-tick';

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
  UPDATE_TICK: 'UPDATE_TICK_MUTATION',
}));

const mockUseWsAuthToken = vi.mocked(useWsAuthToken);
const mockUseSession = vi.mocked(useSession);

function createTestWrapper() {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { wrapper, queryClient };
}

describe('useUpdateTick', () => {
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
    const { result } = renderHook(() => useUpdateTick(), { wrapper });

    await act(async () => {
      result.current.mutate({
        uuid: 'tick-1',
        input: { status: 'send', attemptCount: 1 },
      });
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Not authenticated');
  });

  it('calls GraphQL mutation with the provided uuid and input', async () => {
    mockRequest.mockResolvedValue({
      updateTick: {
        uuid: 'tick-123',
        status: 'send',
        attemptCount: 1,
        quality: 4,
        difficulty: 22,
        isBenchmark: false,
        comment: 'Nice',
        updatedAt: '2026-04-17T00:00:00.000Z',
      },
    });

    const { wrapper } = createTestWrapper();
    const { result } = renderHook(() => useUpdateTick(), { wrapper });

    await act(async () => {
      result.current.mutate({
        uuid: 'tick-123',
        input: { status: 'send', attemptCount: 1, quality: 4, difficulty: 22, comment: 'Nice' },
      });
    });

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('UPDATE_TICK_MUTATION', {
        uuid: 'tick-123',
        input: { status: 'send', attemptCount: 1, quality: 4, difficulty: 22, comment: 'Nice' },
      });
    });
  });

  it('merges the edit into the persisted feed caches and refreshes aggregates', async () => {
    mockRequest.mockResolvedValue({
      updateTick: {
        uuid: 'tick-1',
        status: 'flash',
        attemptCount: 1,
        quality: 5,
        difficulty: 22,
        isBenchmark: false,
        comment: 'Sent',
        updatedAt: '2026-04-17T00:00:00.000Z',
      },
    });

    const { wrapper, queryClient } = createTestWrapper();

    // Seed both feed caches with a row that holds the same tick uuid so we can
    // assert the edit lands in place (no skeleton flash on edit).
    const baseRow = {
      uuid: 'tick-1',
      climbUuid: 'climb-1',
      climbName: 'Test climb',
      setterUsername: null,
      boardType: 'kilter',
      layoutId: 1,
      angle: 40,
      isMirror: false,
      status: 'send' as const,
      attemptCount: 3,
      quality: 2,
      difficulty: 22,
      difficultyName: null,
      consensusDifficulty: null,
      consensusDifficultyName: null,
      qualityAverage: null,
      isBenchmark: false,
      isNoMatch: false,
      comment: 'Stale',
      climbedAt: '2026-04-16T00:00:00.000Z',
      frames: null,
    };
    queryClient.setQueryData(['logbookFeed', '1', 'all', 'all-layouts', '', '{}', '{}'], {
      pages: [{ items: [baseRow], totalCount: 1, hasMore: false }],
      pageParams: [0],
    });
    queryClient.setQueryData(['ascentsFeed', '1', 10], {
      pages: [
        {
          groups: [
            {
              key: 'g1',
              climbUuid: 'climb-1',
              climbName: 'Test climb',
              setterUsername: null,
              boardType: 'kilter',
              layoutId: 1,
              angle: 40,
              isMirror: false,
              frames: null,
              difficultyName: null,
              isBenchmark: false,
              isNoMatch: false,
              date: '2026-04-16',
              flashCount: 0,
              sendCount: 1,
              attemptCount: 0,
              bestQuality: null,
              latestComment: null,
              items: [baseRow],
            },
          ],
          totalCount: 1,
          hasMore: false,
        },
      ],
      pageParams: [0],
    });

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const removeSpy = vi.spyOn(queryClient, 'removeQueries');

    const { result } = renderHook(() => useUpdateTick(), { wrapper });

    await act(async () => {
      result.current.mutate({
        uuid: 'tick-1',
        input: { status: 'flash', attemptCount: 1 },
      });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const logbookData = queryClient.getQueryData<{
      pages: { items: (typeof baseRow)[] }[];
    }>(['logbookFeed', '1', 'all', 'all-layouts', '', '{}', '{}']);
    expect(logbookData?.pages[0].items[0].status).toBe('flash');
    expect(logbookData?.pages[0].items[0].attemptCount).toBe(1);
    expect(logbookData?.pages[0].items[0].comment).toBe('Sent');

    const ascentsData = queryClient.getQueryData<{
      pages: {
        groups: {
          items: (typeof baseRow)[];
          flashCount: number;
          sendCount: number;
          attemptCount: number;
          bestQuality: number | null;
          latestComment: string | null;
        }[];
      }[];
    }>(['ascentsFeed', '1', 10]);
    expect(ascentsData?.pages[0].groups[0].items[0].status).toBe('flash');
    expect(ascentsData?.pages[0].groups[0].items[0].comment).toBe('Sent');
    // status flipped send -> flash: group counters must follow, and bestQuality
    // / latestComment recompute from the new item set.
    expect(ascentsData?.pages[0].groups[0].flashCount).toBe(1);
    expect(ascentsData?.pages[0].groups[0].sendCount).toBe(0);
    expect(ascentsData?.pages[0].groups[0].attemptCount).toBe(0);
    expect(ascentsData?.pages[0].groups[0].bestQuality).toBe(5);
    expect(ascentsData?.pages[0].groups[0].latestComment).toBe('Sent');

    const invalidatedKeys = invalidateSpy.mock.calls.map((call) => call[0]?.queryKey);
    expect(invalidatedKeys).toContainEqual(['sessionDetail']);
    expect(invalidatedKeys).toContainEqual(['userProfileStats']);
    expect(invalidatedKeys).toContainEqual(['userTicks']);
    expect(invalidatedKeys).toContainEqual(['userClimbPercentile']);
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: ['logbook'] });
    expect(mockShowMessage).toHaveBeenCalledWith('Tick updated', 'success');
  });

  it('extracts GraphQL error messages for the snackbar', async () => {
    const graphqlError: Error & { response?: { errors: { message: string }[] } } = new Error('GraphQL error');
    graphqlError.response = {
      errors: [{ message: 'Not authorized to update this tick' }],
    };
    mockRequest.mockRejectedValue(graphqlError);

    const { wrapper } = createTestWrapper();
    const { result } = renderHook(() => useUpdateTick(), { wrapper });

    await act(async () => {
      result.current.mutate({
        uuid: 'tick-1',
        input: { status: 'attempt', attemptCount: 2 },
      });
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(mockShowMessage).toHaveBeenCalledWith('Not authorized to update this tick', 'error');
  });
});
