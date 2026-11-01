// @vitest-environment jsdom
// Feed-card workout lines (#6903): one request per feed page, and a map that
// keeps its identity while no line changes, so memoized cards stay put.

import { describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({
  request: vi.fn(async (_query: string, variables: { sessionIds: string[] }) => ({
    sessionWorkoutHeadlines: variables.sessionIds
      .filter((sessionId) => sessionId !== 'plain')
      .map((sessionId) => ({
        sessionId,
        userId: 'user-1',
        mainKind: 'fourByFour',
        mainTargetGrade: '6b/V4',
        secondMainKind: null,
        blockCount: 3,
        extraMainBlocks: 0,
      })),
  })),
}));
vi.mock('../../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: mocks.request }) }));
vi.mock('../../../../hooks/use-grade-format', () => {
  const formatGrade = (label: string | null | undefined) => label?.split('/').at(1) ?? null;
  return { useGradeFormat: () => ({ formatGrade }) };
});
// The view hook's other imports reach into native modules; this suite renders only the headline hook.
vi.mock('../../../../lib/graphql/hooks', () => ({ useProfile: () => ({ data: null }) }));
vi.mock('../../../../lib/graphql/hooks/use-session-detail', () => ({ useSessionOwnerUserId: () => ({ data: null }) }));
vi.mock('../../../../hooks/use-is-offline', () => ({ useIsOffline: () => false }));
vi.mock('../../../../offline/pending-tick', () => ({ readPendingSessionWrites: vi.fn() }));
vi.mock('../../../../offline/offline-sync-adapter', () => ({ subscribeMutationDelivery: () => () => undefined }));
vi.mock('../../../../lib/ended-workout-store', () => ({ useEndedWorkout: () => null }));
vi.mock('../../../../lib/workout-run-store', () => ({ useWorkoutRunRecord: () => null }));

import { useSessionWorkoutHeadlines } from '../use-session-workout-view';

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

describe('useSessionWorkoutHeadlines', () => {
  it('asks once per feed page and keeps the earlier pages’ answers when the next page loads', async () => {
    const firstPage = ['s1', 'daily:user-1:2026-10-28', 'plain'];
    const { result, rerender } = renderHook(({ pages }: { pages: string[][] }) => useSessionWorkoutHeadlines(pages), {
      wrapper,
      initialProps: { pages: [firstPage] },
    });

    await waitFor(() => expect(result.current.size).toBe(1));
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls[0]?.[1]).toEqual({ sessionIds: ['s1', 'plain'] });
    expect(result.current.get('s1')).toEqual({
      mainKind: 'fourByFour',
      mainTargetGrade: 'V4',
      secondMainKind: null,
      blockCount: 3,
      extraMainBlocks: 0,
    });
    const firstLine = result.current.get('s1');

    rerender({ pages: [firstPage, ['s2']] });
    await waitFor(() => expect(result.current.size).toBe(2));
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(mocks.request.mock.calls[1]?.[1]).toEqual({ sessionIds: ['s2'] });
    // The first card's line is the same object: its memoized card does not redraw.
    expect(result.current.get('s1')).toBe(firstLine);

    const settled = result.current;
    rerender({ pages: [firstPage, ['s2']] });
    expect(result.current).toBe(settled);
  });
});
