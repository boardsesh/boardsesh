import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useSessionWorkouts } from '../use-session-workouts';
import { useSessionWorkoutHeadlines } from '../use-session-workout-headlines';

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({ useWsAuthToken: vi.fn() }));

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>;
}

const headline = (sessionId: string, userId = 'user-1') => ({
  sessionId,
  userId,
  mainKind: 'fourByFour',
  mainTargetGrade: '6b/V4',
  secondMainKind: null,
  blockCount: 3,
  extraMainBlocks: 0,
});

beforeEach(() => {
  mockRequest.mockReset();
});

describe('useSessionWorkouts', () => {
  it('keeps the server copy for a signed-out viewer', () => {
    vi.mocked(useWsAuthToken).mockReturnValue({ token: null, isAuthenticated: false, isLoading: false, error: null });
    const initialData = [{ userId: 'user-1' }] as never;

    const { result } = renderHook(() => useSessionWorkouts({ sessionId: 'session-1', initialData }), { wrapper });

    expect(result.current).toBe(initialData);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('refetches signed in, and never for a daily group', async () => {
    vi.mocked(useWsAuthToken).mockReturnValue({ token: 'token', isAuthenticated: true, isLoading: false, error: null });
    mockRequest.mockResolvedValue({ sessionWorkouts: [{ userId: 'fresh' }] });

    const { result } = renderHook(() => useSessionWorkouts({ sessionId: 'session-1', initialData: [] }), { wrapper });
    await waitFor(() => expect(result.current).toEqual([{ userId: 'fresh' }]));

    mockRequest.mockClear();
    renderHook(() => useSessionWorkouts({ sessionId: 'daily:user-1:2026-10-27' }), { wrapper });
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe('useSessionWorkoutHeadlines', () => {
  it('asks once per page, leaves out daily groups, and keeps the first headline per session', async () => {
    vi.mocked(useWsAuthToken).mockReturnValue({ token: null, isAuthenticated: false, isLoading: false, error: null });
    mockRequest.mockImplementation(async (_document: string, { sessionIds }: { sessionIds: string[] }) => ({
      sessionWorkoutHeadlines: sessionIds.flatMap((id) => [headline(id, 'first'), headline(id, 'second')]),
    }));

    const pages = [['s1', 'daily:u:2026-10-27'], ['s2'], ['daily:u:2026-10-26']];
    const { result } = renderHook(() => useSessionWorkoutHeadlines({ pages, token: null, enabled: true }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.size).toBe(2));
    expect(mockRequest.mock.calls.map(([, variables]) => variables.sessionIds)).toEqual([['s1'], ['s2']]);
    expect(result.current.get('s1')?.userId).toBe('first');
  });
});
