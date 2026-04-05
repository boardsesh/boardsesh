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
  UPDATE_TICK: 'UPDATE_TICK_MUTATION',
}));

import { useWsAuthToken } from '../use-ws-auth-token';
import { useSession } from 'next-auth/react';
import { useUpdateTick, type UpdateTickOptions } from '../use-update-tick';
import type { LogbookEntry } from '../use-logbook';

const mockUseWsAuthToken = vi.mocked(useWsAuthToken);
const mockUseSession = vi.mocked(useSession);

function createTestWrapper() {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { wrapper, queryClient };
}

function createUpdateOptions(overrides: Partial<UpdateTickOptions> = {}): UpdateTickOptions {
  return {
    uuid: 'tick-uuid-1',
    status: 'send',
    attemptCount: 3,
    quality: 2,
    comment: 'Solid climb',
    ...overrides,
  };
}

function createLogbookEntry(overrides: Partial<LogbookEntry> = {}): LogbookEntry {
  return {
    uuid: 'tick-uuid-1',
    climb_uuid: 'climb-1',
    angle: 40,
    is_mirror: false,
    status: 'attempt',
    tries: 1,
    quality: null,
    difficulty: null,
    comment: '',
    is_ascent: false,
    climbed_at: '2024-01-01',
    ...overrides,
  };
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

    const { result } = renderHook(() => useUpdateTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(createUpdateOptions());
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

    const { result } = renderHook(() => useUpdateTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(createUpdateOptions());
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Auth token not available');
  });

  it('calls GraphQL mutation with correct variables', async () => {
    mockRequest.mockResolvedValue({
      updateTick: {
        uuid: 'tick-uuid-1',
        status: 'send',
        attemptCount: 3,
        quality: 2,
        comment: 'Solid climb',
        updatedAt: '2024-01-01T12:00:00Z',
      },
    });

    const { wrapper } = createTestWrapper();

    const { result } = renderHook(() => useUpdateTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(createUpdateOptions());
    });

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalled();
    });

    expect(mockRequest).toHaveBeenCalledWith('UPDATE_TICK_MUTATION', {
      input: {
        uuid: 'tick-uuid-1',
        status: 'send',
        attemptCount: 3,
        quality: 2,
        comment: 'Solid climb',
      },
    });
  });

  it('optimistically updates existing entry in cache', async () => {
    let resolveRequest: (value: unknown) => void;
    mockRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const { wrapper, queryClient } = createTestWrapper();

    const existing = createLogbookEntry({ uuid: 'tick-uuid-1', status: 'attempt', tries: 1, is_ascent: false });
    queryClient.setQueryData(['logbook', 'kilter'], [existing]);

    const { result } = renderHook(() => useUpdateTick('kilter'), { wrapper });

    act(() => {
      result.current.mutate(createUpdateOptions({ status: 'send', attemptCount: 3 }));
    });

    await waitFor(() => {
      const data = queryClient.getQueryData(['logbook', 'kilter']) as LogbookEntry[];
      expect(data?.[0].status).toBe('send');
      expect(data?.[0].tries).toBe(3);
      expect(data?.[0].is_ascent).toBe(true);
    });

    await act(async () => {
      resolveRequest!({
        updateTick: {
          uuid: 'tick-uuid-1',
          status: 'send',
          attemptCount: 3,
          quality: 2,
          comment: 'Solid climb',
          updatedAt: '2024-01-01T12:00:00Z',
        },
      });
    });
  });

  it('rolls back optimistic update on error', async () => {
    mockRequest.mockRejectedValue(new Error('Server error'));

    const { wrapper, queryClient } = createTestWrapper();

    const existing = createLogbookEntry({ uuid: 'tick-uuid-1', status: 'attempt', tries: 1, is_ascent: false });
    queryClient.setQueryData(['logbook', 'kilter'], [existing]);

    const { result } = renderHook(() => useUpdateTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(createUpdateOptions({ status: 'send', attemptCount: 3 }));
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    const data = queryClient.getQueryData(['logbook', 'kilter']) as LogbookEntry[];
    expect(data?.[0].status).toBe('attempt');
    expect(data?.[0].tries).toBe(1);
    expect(data?.[0].is_ascent).toBe(false);
  });

  it('shows success snackbar on success', async () => {
    mockRequest.mockResolvedValue({
      updateTick: {
        uuid: 'tick-uuid-1',
        status: 'send',
        attemptCount: 3,
        quality: 2,
        comment: 'Solid climb',
        updatedAt: '2024-01-01T12:00:00Z',
      },
    });

    const { wrapper } = createTestWrapper();

    const { result } = renderHook(() => useUpdateTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(createUpdateOptions());
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockShowMessage).toHaveBeenCalledWith('Ascent updated', 'success');
  });

  it('shows error snackbar on failure', async () => {
    mockRequest.mockRejectedValue(new Error('Update failed'));

    const { wrapper } = createTestWrapper();

    const { result } = renderHook(() => useUpdateTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(createUpdateOptions());
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(mockShowMessage).toHaveBeenCalledWith('Update failed', 'error');
  });

  it('extracts GraphQL error message from response', async () => {
    const graphqlError: Error & { response?: { errors: { message: string }[] } } = new Error('GraphQL error');
    graphqlError.response = {
      errors: [{ message: 'Tick not found' }],
    };
    mockRequest.mockRejectedValue(graphqlError);

    const { wrapper } = createTestWrapper();

    const { result } = renderHook(() => useUpdateTick('kilter'), { wrapper });

    await act(async () => {
      result.current.mutate(createUpdateOptions());
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(mockShowMessage).toHaveBeenCalledWith('Tick not found', 'error');
  });

  it('correctly updates is_ascent when changing status to attempt', async () => {
    let resolveRequest: (value: unknown) => void;
    mockRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const { wrapper, queryClient } = createTestWrapper();

    const existing = createLogbookEntry({ uuid: 'tick-uuid-1', status: 'send', tries: 2, is_ascent: true });
    queryClient.setQueryData(['logbook', 'kilter'], [existing]);

    const { result } = renderHook(() => useUpdateTick('kilter'), { wrapper });

    act(() => {
      result.current.mutate(createUpdateOptions({ status: 'attempt' }));
    });

    await waitFor(() => {
      const data = queryClient.getQueryData(['logbook', 'kilter']) as LogbookEntry[];
      expect(data?.[0].status).toBe('attempt');
      expect(data?.[0].is_ascent).toBe(false);
    });

    await act(async () => {
      resolveRequest!({
        updateTick: {
          uuid: 'tick-uuid-1',
          status: 'attempt',
          attemptCount: 3,
          quality: null,
          comment: '',
          updatedAt: '2024-01-01T12:00:00Z',
        },
      });
    });
  });
});
