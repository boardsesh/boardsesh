import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import { QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

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
  DELETE_TICK: 'DELETE_TICK_MUTATION',
}));

import { useWsAuthToken } from '../use-ws-auth-token';
import { useSession } from 'next-auth/react';
import { useDeleteTick, type DeleteTickOptions } from '../use-delete-tick';
import type { LogbookEntry } from '../use-logbook';

const mockUseWsAuthToken = vi.mocked(useWsAuthToken);
const mockUseSession = vi.mocked(useSession);

function createTestWrapper() {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { wrapper, queryClient };
}

function createDeleteOptions(overrides: Partial<DeleteTickOptions> = {}): DeleteTickOptions {
  return {
    uuid: 'tick-uuid-1',
    ...overrides,
  };
}

function createLogbookEntry(overrides: Partial<LogbookEntry> = {}): LogbookEntry {
  return {
    uuid: 'tick-uuid-1',
    climb_uuid: 'climb-1',
    angle: 40,
    is_mirror: false,
    status: 'send',
    tries: 1,
    quality: null,
    difficulty: null,
    comment: '',
    is_ascent: true,
    climbed_at: '2024-01-01',
    ...overrides,
  };
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

    const { result } = renderHook(() => useDeleteTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(createDeleteOptions());
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

    const { result } = renderHook(() => useDeleteTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(createDeleteOptions());
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Auth token not available');
  });

  it('calls GraphQL mutation with correct variables', async () => {
    mockRequest.mockResolvedValue({
      deleteTick: { uuid: 'tick-uuid-1' },
    });

    const { wrapper } = createTestWrapper();

    const { result } = renderHook(() => useDeleteTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(createDeleteOptions());
    });

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalled();
    });

    expect(mockRequest).toHaveBeenCalledWith('DELETE_TICK_MUTATION', {
      input: { uuid: 'tick-uuid-1' },
    });
  });

  it('optimistically removes entry from cache', async () => {
    let resolveRequest: (value: unknown) => void;
    mockRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const { wrapper, queryClient } = createTestWrapper();

    const entry = createLogbookEntry({ uuid: 'tick-uuid-1' });
    queryClient.setQueryData(['logbook', 'kilter'], [entry]);

    const { result } = renderHook(() => useDeleteTick('kilter'), { wrapper });

    act(() => {
      result.current.mutate(createDeleteOptions({ uuid: 'tick-uuid-1' }));
    });

    await waitFor(() => {
      const data = queryClient.getQueryData(['logbook', 'kilter']) as LogbookEntry[];
      expect(data?.length).toBe(0);
    });

    await act(async () => {
      resolveRequest!({ deleteTick: { uuid: 'tick-uuid-1' } });
    });
  });

  it('rolls back (restores entry) on error', async () => {
    mockRequest.mockRejectedValue(new Error('Server error'));

    const { wrapper, queryClient } = createTestWrapper();

    const entry = createLogbookEntry({ uuid: 'tick-uuid-1' });
    queryClient.setQueryData(['logbook', 'kilter'], [entry]);

    const { result } = renderHook(() => useDeleteTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(createDeleteOptions({ uuid: 'tick-uuid-1' }));
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    const data = queryClient.getQueryData(['logbook', 'kilter']) as LogbookEntry[];
    expect(data?.length).toBe(1);
    expect(data?.[0].uuid).toBe('tick-uuid-1');
  });

  it('shows success snackbar on success', async () => {
    mockRequest.mockResolvedValue({
      deleteTick: { uuid: 'tick-uuid-1' },
    });

    const { wrapper } = createTestWrapper();

    const { result } = renderHook(() => useDeleteTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(createDeleteOptions());
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockShowMessage).toHaveBeenCalledWith('Ascent deleted', 'success');
  });

  it('shows error snackbar on failure', async () => {
    mockRequest.mockRejectedValue(new Error('Delete failed'));

    const { wrapper } = createTestWrapper();

    const { result } = renderHook(() => useDeleteTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(createDeleteOptions());
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(mockShowMessage).toHaveBeenCalledWith('Delete failed', 'error');
  });

  it('extracts GraphQL error message from response', async () => {
    const graphqlError: Error & { response?: { errors: { message: string }[] } } = new Error('GraphQL error');
    graphqlError.response = {
      errors: [{ message: 'Tick not found' }],
    };
    mockRequest.mockRejectedValue(graphqlError);

    const { wrapper } = createTestWrapper();

    const { result } = renderHook(() => useDeleteTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(createDeleteOptions());
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(mockShowMessage).toHaveBeenCalledWith('Tick not found', 'error');
  });

  it('does not affect other entries in cache when deleting one', async () => {
    let resolveRequest: (value: unknown) => void;
    mockRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const { wrapper, queryClient } = createTestWrapper();

    const entryToDelete = createLogbookEntry({ uuid: 'tick-uuid-1', climb_uuid: 'climb-1' });
    const otherEntry = createLogbookEntry({ uuid: 'tick-uuid-2', climb_uuid: 'climb-2' });
    queryClient.setQueryData(['logbook', 'kilter'], [entryToDelete, otherEntry]);

    const { result } = renderHook(() => useDeleteTick('kilter'), { wrapper });

    act(() => {
      result.current.mutate(createDeleteOptions({ uuid: 'tick-uuid-1' }));
    });

    await waitFor(() => {
      const data = queryClient.getQueryData(['logbook', 'kilter']) as LogbookEntry[];
      expect(data?.length).toBe(1);
      expect(data?.[0].uuid).toBe('tick-uuid-2');
    });

    await act(async () => {
      resolveRequest!({ deleteTick: { uuid: 'tick-uuid-1' } });
    });
  });
});
