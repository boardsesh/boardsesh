import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, waitFor, act } from '@testing-library/react';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import { QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useWsAuthToken } from '../use-ws-auth-token';
import { useSession } from 'next-auth/react';
import { useUpdateSession } from '../use-update-session';
import { SESSION_DETAIL_QUERY_KEY } from '../use-session-detail';

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
  UPDATE_SESSION: 'UPDATE_SESSION_MUTATION',
}));

const mockUseWsAuthToken = vi.mocked(useWsAuthToken);
const mockUseSession = vi.mocked(useSession);

function createTestWrapper() {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { wrapper, queryClient };
}

describe('useUpdateSession', () => {
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
    mockUseSession.mockReturnValue({ status: 'unauthenticated', data: null, update: vi.fn() });

    const { wrapper } = createTestWrapper();
    const { result } = renderHook(() => useUpdateSession(), { wrapper });

    await act(async () => {
      result.current.mutate({ sessionId: 'session-1', notes: 'hi' });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('Not authenticated');
  });

  it('throws when no token', async () => {
    mockUseWsAuthToken.mockReturnValue({ token: null, isAuthenticated: false, isLoading: false, error: null });

    const { wrapper } = createTestWrapper();
    const { result } = renderHook(() => useUpdateSession(), { wrapper });

    await act(async () => {
      result.current.mutate({ sessionId: 'session-1', notes: 'hi' });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('Auth token not available');
  });

  it('sends the input wrapped in the UpdateSession variables shape', async () => {
    mockRequest.mockResolvedValue({ updateSession: { sessionId: 'session-1', name: null, notes: 'Good sesh' } });

    const { wrapper } = createTestWrapper();
    const { result } = renderHook(() => useUpdateSession(), { wrapper });

    await act(async () => {
      result.current.mutate({ sessionId: 'session-1', notes: 'Good sesh' });
    });

    await waitFor(() => expect(mockRequest).toHaveBeenCalled());
    expect(mockRequest).toHaveBeenCalledWith('UPDATE_SESSION_MUTATION', {
      input: { sessionId: 'session-1', notes: 'Good sesh' },
    });
  });

  it('sends null notes when clearing', async () => {
    mockRequest.mockResolvedValue({ updateSession: { sessionId: 'session-1', name: 'Board Session', notes: null } });

    const { wrapper } = createTestWrapper();
    const { result } = renderHook(() => useUpdateSession(), { wrapper });

    await act(async () => {
      result.current.mutate({ sessionId: 'session-1', notes: null });
    });

    await waitFor(() => expect(mockRequest).toHaveBeenCalled());
    expect(mockRequest).toHaveBeenCalledWith('UPDATE_SESSION_MUTATION', {
      input: { sessionId: 'session-1', notes: null },
    });
  });

  it('merges the returned name/notes into the session-detail cache', async () => {
    mockRequest.mockResolvedValue({
      updateSession: { sessionId: 'session-1', name: 'Renamed', notes: 'Crushed V5' },
    });

    const { wrapper, queryClient } = createTestWrapper();
    queryClient.setQueryData(SESSION_DETAIL_QUERY_KEY('session-1'), {
      sessionId: 'session-1',
      sessionName: 'Old name',
      notes: null,
      totalSends: 4,
    });

    const { result } = renderHook(() => useUpdateSession(), { wrapper });

    await act(async () => {
      result.current.mutate({ sessionId: 'session-1', notes: 'Crushed V5' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const cached = queryClient.getQueryData(SESSION_DETAIL_QUERY_KEY('session-1')) as {
      sessionName?: string | null;
      notes?: string | null;
      totalSends?: number;
    };
    expect(cached.sessionName).toBe('Renamed');
    expect(cached.notes).toBe('Crushed V5');
    // Untouched fields are preserved.
    expect(cached.totalSends).toBe(4);
  });

  it('leaves the cache untouched when there is no detail entry', async () => {
    mockRequest.mockResolvedValue({ updateSession: { sessionId: 'session-1', name: null, notes: 'hi' } });

    const { wrapper, queryClient } = createTestWrapper();
    const { result } = renderHook(() => useUpdateSession(), { wrapper });

    await act(async () => {
      result.current.mutate({ sessionId: 'session-1', notes: 'hi' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(SESSION_DETAIL_QUERY_KEY('session-1'))).toBeUndefined();
  });

  it('invalidates the session detail and feed queries on success', async () => {
    mockRequest.mockResolvedValue({ updateSession: { sessionId: 'session-1', name: null, notes: 'hi' } });

    const { wrapper, queryClient } = createTestWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateSession(), { wrapper });

    await act(async () => {
      result.current.mutate({ sessionId: 'session-1', notes: 'hi' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const invalidatedKeys = invalidateSpy.mock.calls.map((call) => call[0]?.queryKey);
    expect(invalidatedKeys).toContainEqual(['sessionDetail']);
    expect(invalidatedKeys).toContainEqual(['sessionFeed']);
  });

  it('shows the call-site fallback message on a network error', async () => {
    mockRequest.mockRejectedValue(new Error('fetch failed'));

    const { wrapper } = createTestWrapper();
    const { result } = renderHook(() => useUpdateSession({ errorMessage: "Couldn't save your notes" }), { wrapper });

    await act(async () => {
      result.current.mutate({ sessionId: 'session-1', notes: 'hi' });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockShowMessage).toHaveBeenCalledWith("Couldn't save your notes", 'error');
  });

  it('prefers a specific GraphQL error message over the fallback', async () => {
    const graphqlError: Error & { response?: { errors: { message: string }[] } } = new Error('GraphQL error');
    graphqlError.response = { errors: [{ message: 'You can only edit your own sessions' }] };
    mockRequest.mockRejectedValue(graphqlError);

    const { wrapper } = createTestWrapper();
    const { result } = renderHook(() => useUpdateSession({ errorMessage: "Couldn't save your notes" }), { wrapper });

    await act(async () => {
      result.current.mutate({ sessionId: 'session-1', notes: 'hi' });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockShowMessage).toHaveBeenCalledWith('You can only edit your own sessions', 'error');
  });
});
