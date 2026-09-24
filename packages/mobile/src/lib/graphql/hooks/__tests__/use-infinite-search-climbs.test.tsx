// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import type { SearchClimbsQueryResponse } from '../../operations';

const requestMock = vi.fn();

vi.mock('../../client', () => ({
  getHttpClient: () => ({ request: requestMock }),
}));

// The live flag bag, keyed like FEATURE_FLAG_DEFINITIONS. Empty = every flag
// unresolved, which is what a device with no PostHog answer sees.
const featureFlags = vi.hoisted(() => ({ values: {} as Record<string, boolean | undefined> }));
vi.mock('../../../../providers/feature-flags-provider', () => ({
  useFeatureFlag: (key: string) => featureFlags.values[key],
  useBoardseshGradeEnabled: () => featureFlags.values['boardsesh-grade'] === true,
}));

// The climber's "Show Boardsesh grades" preference, read with the flag above.
const boardseshGradesPreference = vi.hoisted(() => ({ enabled: false }));
vi.mock('../../../boardsesh-grades-preference', () => ({
  useBoardseshGradesPreference: () => ({ enabled: boardseshGradesPreference.enabled, loaded: true }),
}));

import { keepSameBoardSearchResults, useInfiniteSearchClimbs } from '../use-infinite-search-climbs';

const baseInput: ClimbSearchInput = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 2,
  setIds: '3',
  angle: 40,
  page: 999,
  pageSize: 30,
  name: 'Moonage',
};

function wrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function lastInput(): ClimbSearchInput {
  const call = requestMock.mock.calls.at(-1);
  if (!call) throw new Error('No GraphQL request was made');
  return (call[1] as { input: ClimbSearchInput }).input;
}

function makeResponse(page: number): SearchClimbsQueryResponse {
  return {
    searchClimbs: {
      climbs: [],
      hasMore: page === 0,
    },
  };
}

describe('useInfiniteSearchClimbs', () => {
  beforeEach(() => {
    featureFlags.values = {};
    boardseshGradesPreference.enabled = false;
    requestMock.mockReset();
    requestMock.mockImplementation((_query: unknown, variables: { input: ClimbSearchInput }) =>
      Promise.resolve(makeResponse(variables.input.page ?? 0)),
    );
  });

  it('starts at backend page 0 even when the input carries a stale page field', async () => {
    renderHook(() => useInfiniteSearchClimbs(baseInput), { wrapper: wrapper() });

    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
    expect(lastInput()).toMatchObject({ page: 0, pageSize: 30, name: 'Moonage' });
  });

  it('fetches the next backend page when hasMore is true', async () => {
    const { result } = renderHook(() => useInfiniteSearchClimbs(baseInput), { wrapper: wrapper() });

    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.fetchNextPage();
    });

    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));
    expect(lastInput()).toMatchObject({ page: 1, pageSize: 30, name: 'Moonage' });
    expect(result.current.hasNextPage).toBe(false);
  });

  // Issue #5642: on Woods the "Other angles" filter switch decides, and it
  // defaults off; the tester flag only reaches boards that are not angle-bound.
  describe('crossAngleStats', () => {
    const woodsInput: ClimbSearchInput = { ...baseInput, boardName: 'woods' };

    it('sends true on Woods when the Other angles switch is on', async () => {
      renderHook(() => useInfiniteSearchClimbs({ ...woodsInput, crossAngleStats: true }), { wrapper: wrapper() });

      await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
      expect(lastInput().crossAngleStats).toBe(true);
    });

    it('sends false on Woods by default, even with the tester flag on', async () => {
      featureFlags.values = { 'cross-angle-stats': true };
      renderHook(() => useInfiniteSearchClimbs(woodsInput), { wrapper: wrapper() });

      await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
      expect(lastInput().crossAngleStats).toBe(false);
    });

    it('sends true on Kilter when the tester flag is on', async () => {
      featureFlags.values = { 'cross-angle-stats': true };
      renderHook(() => useInfiniteSearchClimbs(baseInput), { wrapper: wrapper() });

      await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
      expect(lastInput().crossAngleStats).toBe(true);
    });

    it('sends false on Kilter with the flag unresolved', async () => {
      renderHook(() => useInfiniteSearchClimbs(baseInput), { wrapper: wrapper() });

      await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
      expect(lastInput().crossAngleStats).toBe(false);
    });

    it('refetches when the switch flips, because the value is part of the query key', async () => {
      const { rerender } = renderHook(({ input }: { input: ClimbSearchInput }) => useInfiniteSearchClimbs(input), {
        initialProps: { input: woodsInput },
        wrapper: wrapper(),
      });
      await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));

      rerender({ input: { ...woodsInput, crossAngleStats: true } });

      await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));
      expect(lastInput().crossAngleStats).toBe(true);
    });
  });

  // Issue #5643: with Boardsesh grades on, the grade filter keys on the grade
  // the rows are labelled with.
  describe('gradeSource', () => {
    // A grade bound, so the source can reach SQL and is worth sending.
    const gradedInput: ClimbSearchInput = { ...baseInput, minGrade: 16, maxGrade: 18 };

    it('omits gradeSource while Boardsesh grades are off', async () => {
      featureFlags.values = { 'boardsesh-grade': true };
      renderHook(() => useInfiniteSearchClimbs(gradedInput), { wrapper: wrapper() });

      await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
      expect(lastInput().gradeSource).toBeUndefined();
    });

    it('omits gradeSource when the preference is on but the flag is off', async () => {
      boardseshGradesPreference.enabled = true;
      renderHook(() => useInfiniteSearchClimbs(gradedInput), { wrapper: wrapper() });

      await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
      expect(lastInput().gradeSource).toBeUndefined();
    });

    it('sends BOARDSESH with the flag and the preference on', async () => {
      featureFlags.values = { 'boardsesh-grade': true };
      boardseshGradesPreference.enabled = true;
      renderHook(() => useInfiniteSearchClimbs(gradedInput), { wrapper: wrapper() });

      await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
      expect(lastInput().gradeSource).toBe('BOARDSESH');
    });

    it('refetches when the preference flips, because the source is part of the query key', async () => {
      featureFlags.values = { 'boardsesh-grade': true };
      const { rerender } = renderHook(() => useInfiniteSearchClimbs(gradedInput), { wrapper: wrapper() });
      await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
      expect(lastInput().gradeSource).toBeUndefined();

      boardseshGradesPreference.enabled = true;
      rerender();

      await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));
      expect(lastInput().gradeSource).toBe('BOARDSESH');
    });

    it('omits gradeSource when neither a grade bound nor the difficulty sort can read it', async () => {
      featureFlags.values = { 'boardsesh-grade': true };
      boardseshGradesPreference.enabled = true;
      renderHook(() => useInfiniteSearchClimbs(baseInput), { wrapper: wrapper() });

      await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
      expect(lastInput().gradeSource).toBeUndefined();
    });

    it('sends BOARDSESH for the difficulty sort without a grade bound', async () => {
      featureFlags.values = { 'boardsesh-grade': true };
      boardseshGradesPreference.enabled = true;
      renderHook(() => useInfiniteSearchClimbs({ ...baseInput, sortBy: 'difficulty' }), { wrapper: wrapper() });

      await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
      expect(lastInput().gradeSource).toBe('BOARDSESH');
    });
  });

  describe('keepPreviousResults', () => {
    beforeEach(() => {
      // Only the first search resolves; every later one stays in flight, so the
      // assertions read the state a climber sees while the new search loads.
      requestMock.mockImplementation((_query: unknown, variables: { input: ClimbSearchInput }) =>
        variables.input.name === 'Moonage'
          ? Promise.resolve(makeResponse(variables.input.page ?? 0))
          : new Promise<SearchClimbsQueryResponse>(() => {}),
      );
    });

    it('keeps the previous results for a new search on the same board, and drops them on a board change', async () => {
      const { result, rerender } = renderHook(
        ({ input }: { input: ClimbSearchInput }) => useInfiniteSearchClimbs(input, true, { keepPreviousResults: true }),
        { initialProps: { input: baseInput }, wrapper: wrapper() },
      );
      await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));

      rerender({ input: { ...baseInput, name: 'Zenith' } });
      await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));
      expect(result.current.isPlaceholderData).toBe(true);
      // Still the selected shape (`pages[i].climbs`), not the raw response.
      expect(result.current.data?.pages[0]).toEqual({ climbs: [], hasMore: true });

      // A different size is a different board: skeletons, not the old climbs.
      rerender({ input: { ...baseInput, name: 'Zenith', sizeId: 7 } });
      await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(3));
      expect(result.current.data).toBeUndefined();
      expect(result.current.isPlaceholderData).toBe(false);
    });

    it('drops to no data on a new search when the option is off', async () => {
      const { result, rerender } = renderHook(
        ({ input }: { input: ClimbSearchInput }) => useInfiniteSearchClimbs(input),
        { initialProps: { input: baseInput }, wrapper: wrapper() },
      );
      await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));

      rerender({ input: { ...baseInput, name: 'Zenith' } });
      await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));
      expect(result.current.data).toBeUndefined();
      expect(result.current.isPlaceholderData).toBe(false);
    });
  });
});

describe('keepSameBoardSearchResults', () => {
  const boardScope = { boardName: 'kilter', layoutId: 1, sizeId: 2, setIds: '3' };
  const previousResults = { pages: ['previous'] };
  const previousKey = ['infiniteSearchClimbs', { ...boardScope, angle: 40, name: 'Moonage', pageSize: 30 }];

  it('keeps the previous data when the previous search used the same board', () => {
    expect(keepSameBoardSearchResults(boardScope, previousResults, previousKey)).toBe(previousResults);
  });

  it.each([
    ['board name', { boardName: 'tension' }],
    ['layout', { layoutId: 9 }],
    ['size', { sizeId: 9 }],
    ['sets', { setIds: '3,4' }],
  ])('drops the previous data when the %s changed', (_label, boardChange) => {
    expect(keepSameBoardSearchResults({ ...boardScope, ...boardChange }, previousResults, previousKey)).toBeUndefined();
  });

  it('drops the previous data with no previous query, no data, or a foreign key', () => {
    expect(keepSameBoardSearchResults(boardScope, previousResults, undefined)).toBeUndefined();
    expect(keepSameBoardSearchResults(boardScope, undefined, previousKey)).toBeUndefined();
    expect(keepSameBoardSearchResults(boardScope, previousResults, ['searchClimbsCount', boardScope])).toBeUndefined();
  });
});
