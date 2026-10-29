import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, waitFor } from '@testing-library/react';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useMyBoards } from '../use-my-boards';

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: vi.fn(),
}));

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

vi.mock('@boardsesh/graphql/operations', () => ({
  GET_MY_BOARDS: 'GET_MY_BOARDS',
}));

const mockUseWsAuthToken = vi.mocked(useWsAuthToken);

const mockBoards = [
  {
    uuid: 'board-1',
    name: 'Home Kilter',
    slug: 'home-kilter',
    boardType: 'kilter',
    angle: 40,
    locationName: 'Home',
  },
  {
    uuid: 'board-2',
    name: 'Gym Tension',
    slug: 'gym-tension',
    boardType: 'tension',
    angle: 30,
    locationName: 'Gym',
  },
];

describe('useMyBoards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseWsAuthToken.mockReturnValue({
      token: 'test-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });
  });

  it('fetches boards when enabled and authenticated', async () => {
    mockRequest.mockResolvedValueOnce({ myBoards: { boards: mockBoards } });

    const { result } = renderHook(() => useMyBoards(true));

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.boards).toEqual(mockBoards);
    expect(result.current.error).toBeNull();
    expect(mockRequest).toHaveBeenCalledWith('GET_MY_BOARDS', { input: { limit: 50, offset: 0 } });
  });

  it('does not fetch when disabled', () => {
    const { result } = renderHook(() => useMyBoards(false));

    expect(mockRequest).not.toHaveBeenCalled();
    expect(result.current.boards).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it('does not fetch when not authenticated', () => {
    mockUseWsAuthToken.mockReturnValue({
      token: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    });

    const { result } = renderHook(() => useMyBoards(true));

    expect(mockRequest).not.toHaveBeenCalled();
    expect(result.current.boards).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it('does not fetch when token is null', () => {
    mockUseWsAuthToken.mockReturnValue({
      token: null,
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    renderHook(() => useMyBoards(true));

    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('sets error state on fetch failure', async () => {
    mockRequest.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useMyBoards(true));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('Failed to load your boards');
    expect(result.current.boards).toEqual([]);
  });

  it('passes custom limit to the query', async () => {
    mockRequest.mockResolvedValueOnce({ myBoards: { boards: [] } });

    renderHook(() => useMyBoards(true, 20));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('GET_MY_BOARDS', {
        input: { limit: 20, offset: 0 },
      });
    });
  });

  it('cancels in-flight request when unmounted', async () => {
    let resolveRequest: (value: unknown) => void;
    mockRequest.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const { result, unmount } = renderHook(() => useMyBoards(true));

    expect(result.current.isLoading).toBe(true);

    unmount();

    // Resolve after unmount - state should not update (no act warning)
    resolveRequest!({ myBoards: { boards: mockBoards } });

    // The hook was unmounted, so we just verify no errors were thrown
  });

  it('refetches when token changes', async () => {
    mockRequest.mockResolvedValueOnce({ myBoards: { boards: [mockBoards[0]] } });

    const { result, rerender } = renderHook(({ enabled }) => useMyBoards(enabled), {
      initialProps: { enabled: true },
    });

    await waitFor(() => {
      expect(result.current.boards).toHaveLength(1);
    });

    // Simulate token change
    mockUseWsAuthToken.mockReturnValue({
      token: 'new-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });
    mockRequest.mockResolvedValueOnce({ myBoards: { boards: mockBoards } });

    rerender({ enabled: true });

    await waitFor(() => {
      expect(result.current.boards).toHaveLength(2);
    });
  });

  it('clears error on successful refetch', async () => {
    mockRequest.mockRejectedValueOnce(new Error('fail'));

    const { result, rerender } = renderHook(({ enabled }) => useMyBoards(enabled), {
      initialProps: { enabled: true },
    });

    await waitFor(() => {
      expect(result.current.error).toBe('Failed to load your boards');
    });

    // Simulate re-enable with new token triggering refetch
    mockUseWsAuthToken.mockReturnValue({
      token: 'new-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });
    mockRequest.mockResolvedValueOnce({ myBoards: { boards: mockBoards } });

    rerender({ enabled: true });

    await waitFor(() => {
      expect(result.current.error).toBeNull();
      expect(result.current.boards).toEqual(mockBoards);
    });
  });
});
