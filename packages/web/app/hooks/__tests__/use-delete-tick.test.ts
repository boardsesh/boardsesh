import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, waitFor, act } from '@testing-library/react';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import { QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useWsAuthToken } from '../use-ws-auth-token';
import { useSession } from 'next-auth/react';
import { useDeleteTick } from '../use-delete-tick';

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

vi.mock('@boardsesh/graphql/operations', () => ({
  DELETE_TICK: 'DELETE_TICK_MUTATION',
}));

const mockUseWsAuthToken = vi.mocked(useWsAuthToken);
const mockUseSession = vi.mocked(useSession);

function createTestWrapper() {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { wrapper, queryClient };
}

describe('useDeleteTick', () => {
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
    const { result } = renderHook(() => useDeleteTick(), { wrapper });

    await act(async () => {
      result.current.mutate('tick-uuid-1');
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
    const { result } = renderHook(() => useDeleteTick(), { wrapper });

    await act(async () => {
      result.current.mutate('tick-uuid-1');
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Auth token not available');
  });

  it('calls GraphQL mutation with correct uuid', async () => {
    mockRequest.mockResolvedValue({ deleteTick: true });

    const { wrapper } = createTestWrapper();
    const { result } = renderHook(() => useDeleteTick(), { wrapper });

    await act(async () => {
      result.current.mutate('tick-uuid-123');
    });

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalled();
    });

    expect(mockRequest).toHaveBeenCalledWith('DELETE_TICK_MUTATION', {
      uuid: 'tick-uuid-123',
    });
  });

  it('refreshes relevant query caches on success', async () => {
    mockRequest.mockResolvedValue({ deleteTick: true });

    const { wrapper, queryClient } = createTestWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const removeSpy = vi.spyOn(queryClient, 'removeQueries');

    // Seed some cache data
    queryClient.setQueryData(['ascentsFeed', 'user-1', 10], { pages: [] });
    queryClient.setQueryData(['logbook', 'kilter', 'accumulated'], []);
    queryClient.setQueryData(['sessionDetail', 'session-1'], {});

    const { result } = renderHook(() => useDeleteTick(), { wrapper });

    await act(async () => {
      result.current.mutate('tick-uuid-1');
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const invalidatedKeys = invalidateSpy.mock.calls.map((call) => call[0]?.queryKey);
    expect(invalidatedKeys).toContainEqual(['ascentsFeed']);
    expect(invalidatedKeys).toContainEqual(['sessionDetail']);
    expect(invalidatedKeys).toContainEqual(['userProfileStats']);
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: ['logbook'] });
  });

  it('shows error snackbar on failure', async () => {
    mockRequest.mockRejectedValue(new Error('Delete failed'));

    const { wrapper } = createTestWrapper();
    const { result } = renderHook(() => useDeleteTick(), { wrapper });

    await act(async () => {
      result.current.mutate('tick-uuid-1');
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(mockShowMessage).toHaveBeenCalledWith('Delete failed', 'error');
  });

  it('extracts GraphQL error message from response', async () => {
    const graphqlError: Error & { response?: { errors: { message: string }[] } } = new Error('GraphQL error');
    graphqlError.response = {
      errors: [{ message: 'You can only delete your own ticks' }],
    };
    mockRequest.mockRejectedValue(graphqlError);

    const { wrapper } = createTestWrapper();
    const { result } = renderHook(() => useDeleteTick(), { wrapper });

    await act(async () => {
      result.current.mutate('tick-uuid-1');
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(mockShowMessage).toHaveBeenCalledWith('You can only delete your own ticks', 'error');
  });
});
