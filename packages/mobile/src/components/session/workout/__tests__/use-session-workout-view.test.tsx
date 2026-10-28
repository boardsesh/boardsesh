// @vitest-environment jsdom
// The summary's workout (#6903): the phone's recap while the server has none,
// and only for the account it was kept for.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EndedWorkoutRecord } from '../../../../lib/ended-workout-store';

const mocks = vi.hoisted(() => ({
  viewerId: 'user-1' as string | null,
  recap: null as EndedWorkoutRecord | null,
  pending: { ticks: 0, workouts: 0 },
  request: vi.fn(async () => ({ sessionWorkouts: [] })),
}));
vi.mock('../../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: mocks.request }) }));
vi.mock('../../../../hooks/use-grade-format', () => {
  const formatGrade = (label: string | null | undefined) => label ?? null;
  return { useGradeFormat: () => ({ formatGrade }) };
});
vi.mock('../../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: mocks.viewerId ? { id: mocks.viewerId } : null }),
}));
vi.mock('../../../../lib/graphql/hooks/use-session-detail', () => ({ useSessionOwnerUserId: () => ({ data: null }) }));
vi.mock('../../../../hooks/use-is-offline', () => ({ useIsOffline: () => false }));
vi.mock('../../../../offline/pending-tick', () => ({ readPendingSessionWrites: async () => mocks.pending }));
vi.mock('../../../../offline/offline-sync-adapter', () => ({ subscribeMutationDelivery: () => () => undefined }));
vi.mock('../../../../lib/ended-workout-store', () => ({ useEndedWorkout: () => mocks.recap }));
vi.mock('../../../../lib/workout-run-store', () => ({ useWorkoutRunRecord: () => null }));

import { useSessionWorkoutView } from '../use-session-workout-view';

const SESSION_ID = '6f1c2a8e-3b4d-4c5e-9f60-7a8b9c0d1e2f';

const recap = (userId: string | null): EndedWorkoutRecord => ({
  sessionId: SESSION_ID,
  run: { stages: [{ id: 'main', kind: 'volume', itemUuids: ['q1'] }] },
  climbs: { q1: { climbUuid: 'climb-1', angle: 40, name: 'Crimps' } },
  log: [{ queueItemUuid: 'q1', status: 'send', climbedAt: '2026-10-28T10:00:00Z', tickUuid: 't1' }],
  endedAtMs: 0,
  userId,
});

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  mocks.viewerId = 'user-1';
  mocks.pending = { ticks: 0, workouts: 0 };
  mocks.request.mockClear();
});

describe('useSessionWorkoutView', () => {
  it("draws the phone's recap while the server has no workout for the viewer", async () => {
    mocks.recap = recap('user-1');
    const { result } = renderHook(() => useSessionWorkoutView(SESSION_ID), { wrapper });
    await waitFor(() => expect(mocks.request).toHaveBeenCalled());
    await waitFor(() => expect(result.current?.workout.stages[0]?.tally.sent).toBe(1));
    expect(result.current?.workout.userId).toBe('user-1');
  });

  it('reports the ticks still saving from the outbox', async () => {
    mocks.recap = recap('user-1');
    mocks.pending = { ticks: 3, workouts: 1 };
    const { result } = renderHook(() => useSessionWorkoutView(SESSION_ID), { wrapper });
    await waitFor(() => expect(result.current?.pendingTicks).toBe(3));
  });

  it('ignores a recap kept for another account, or for none', async () => {
    mocks.recap = recap('someone-else');
    const other = renderHook(() => useSessionWorkoutView(SESSION_ID), { wrapper });
    await waitFor(() => expect(mocks.request).toHaveBeenCalled());
    expect(other.result.current).toBeUndefined();

    mocks.recap = recap(null);
    const unknown = renderHook(() => useSessionWorkoutView(SESSION_ID), { wrapper });
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
    expect(unknown.result.current).toBeUndefined();
  });
});
