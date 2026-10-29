import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, waitFor } from '@testing-library/react';
import { createQueryWrapper } from '@/app/test-utils/test-providers';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useMyGyms } from '../use-my-gyms';

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: vi.fn(),
}));

let mockUserId: string | null = 'user-1';
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mockUserId ? { user: { id: mockUserId } } : null }),
}));

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

vi.mock('@boardsesh/graphql/operations', () => ({
  GET_MY_GYMS: 'GET_MY_GYMS_QUERY',
}));

const mockUseWsAuthToken = vi.mocked(useWsAuthToken);

const mockGyms = [
  { uuid: 'gym-1', name: 'Boulder Project', slug: 'boulder-project', ownerId: 'user-1' },
  { uuid: 'gym-2', name: 'Send Town', slug: 'send-town', ownerId: 'user-1' },
];

describe('useMyGyms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserId = 'user-1';
    mockUseWsAuthToken.mockReturnValue({
      token: 'test-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });
  });

  it('does not fetch when disabled', () => {
    const { result } = renderHook(() => useMyGyms(false), { wrapper: createQueryWrapper() });

    expect(mockRequest).not.toHaveBeenCalled();
    expect(result.current.gyms).toEqual([]);
    // hasResolved is the definitive "we know the answer" signal — a disabled
    // query has never fetched, so it must report unresolved, not empty-success.
    expect(result.current.hasResolved).toBe(false);
  });

  it('does not fetch when not authenticated', () => {
    mockUseWsAuthToken.mockReturnValue({
      token: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    });

    const { result } = renderHook(() => useMyGyms(true), { wrapper: createQueryWrapper() });

    expect(mockRequest).not.toHaveBeenCalled();
    expect(result.current.gyms).toEqual([]);
    expect(result.current.hasResolved).toBe(false);
  });

  it('reports isLoading=true and hasResolved=false while the ws-auth token is still in flight', () => {
    // This is the exact pre-token state that caused the homepage gym card to
    // flash the non-owner nudge: enabled=true, isAuthenticated=true, but no
    // token yet. The query stays disabled until the token resolves, so it
    // must never look like a settled "0 gyms" result.
    mockUseWsAuthToken.mockReturnValue({
      token: null,
      isAuthenticated: true,
      isLoading: true,
      error: null,
    });

    const { result } = renderHook(() => useMyGyms(true), { wrapper: createQueryWrapper() });

    expect(mockRequest).not.toHaveBeenCalled();
    expect(result.current.gyms).toEqual([]);
    expect(result.current.isLoading).toBe(true);
    expect(result.current.hasResolved).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('fetches gyms when enabled and authenticated, and resolves hasResolved=true', async () => {
    mockRequest.mockResolvedValueOnce({ myGyms: { gyms: mockGyms, totalCount: 2, hasMore: false } });

    const { result } = renderHook(() => useMyGyms(true), { wrapper: createQueryWrapper() });

    expect(result.current.hasResolved).toBe(false);

    await waitFor(() => {
      expect(result.current.hasResolved).toBe(true);
    });

    expect(result.current.gyms).toEqual(mockGyms);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockRequest).toHaveBeenCalledWith('GET_MY_GYMS_QUERY', { input: { limit: 50, offset: 0 } });
  });

  it('sets error and hasResolved=true on fetch failure', async () => {
    mockRequest.mockRejectedValueOnce(new Error('network error'));

    const { result } = renderHook(() => useMyGyms(true), { wrapper: createQueryWrapper() });

    await waitFor(() => {
      expect(result.current.hasResolved).toBe(true);
    });

    expect(result.current.error).toBe('Failed to load your gyms');
    expect(result.current.gyms).toEqual([]);
  });

  it('passes a custom limit to the query', async () => {
    mockRequest.mockResolvedValueOnce({ myGyms: { gyms: [], totalCount: 0, hasMore: false } });

    renderHook(() => useMyGyms(true, 20), { wrapper: createQueryWrapper() });

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('GET_MY_GYMS_QUERY', { input: { limit: 20, offset: 0 } });
    });
  });

  it('exposes hasMore and paginates via loadMore', async () => {
    mockRequest.mockResolvedValueOnce({
      myGyms: { gyms: [mockGyms[0]], totalCount: 2, hasMore: true },
    });

    const { result } = renderHook(() => useMyGyms(true, 1), { wrapper: createQueryWrapper() });

    await waitFor(() => {
      expect(result.current.gyms).toHaveLength(1);
    });
    expect(result.current.hasMore).toBe(true);

    mockRequest.mockResolvedValueOnce({
      myGyms: { gyms: [mockGyms[1]], totalCount: 2, hasMore: false },
    });

    result.current.loadMore();

    await waitFor(() => {
      expect(result.current.gyms).toHaveLength(2);
    });
    expect(result.current.hasMore).toBe(false);
    expect(mockRequest).toHaveBeenLastCalledWith('GET_MY_GYMS_QUERY', { input: { limit: 1, offset: 1 } });
  });

  it('scopes the cached result to the viewer so a different signed-in user does not see stale gyms', async () => {
    mockRequest.mockResolvedValueOnce({ myGyms: { gyms: mockGyms, totalCount: 2, hasMore: false } });

    const { result, rerender } = renderHook(() => useMyGyms(true), { wrapper: createQueryWrapper() });

    await waitFor(() => {
      expect(result.current.gyms).toHaveLength(2);
    });

    mockUserId = 'user-2';
    mockRequest.mockResolvedValueOnce({ myGyms: { gyms: [], totalCount: 0, hasMore: false } });
    rerender();

    // A new viewer has no cached entry under their own query key, so the hook
    // goes back to unresolved rather than briefly showing user-1's gyms.
    expect(result.current.hasResolved).toBe(false);

    await waitFor(() => {
      expect(result.current.hasResolved).toBe(true);
    });
    expect(result.current.gyms).toEqual([]);
  });
});
