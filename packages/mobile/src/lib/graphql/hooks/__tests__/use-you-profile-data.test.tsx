// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// useYouProfileData composes three React Query hooks + the pure
// deriveProfileViewModel. These tests cover its *filter-state* logic
// (board/timeframe selectors + hasActiveFilters + the loading gate), so the
// data hooks are stubbed to a settled, empty shape and the view model runs on
// no ticks. Mock at the module boundary so no real query / network / grade
// preference is touched.
const settledQuery = { data: undefined, isPending: false, isRefetching: false, refetch: vi.fn() };

vi.mock('../use-you-data', () => ({
  useAllBoardsTicks: vi.fn(() => ({ ...settledQuery, data: {} })),
  useUserProfileStats: vi.fn(() => ({ ...settledQuery, data: null })),
  useUserClimbPercentile: vi.fn(() => ({ ...settledQuery, data: null })),
}));

vi.mock('expo-router', () => ({ useIsFocused: () => true }));

vi.mock('../../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ gradeFormat: 'v-grade' }),
}));

import { useUserProfileStats } from '../use-you-data';
import { profileTotalsStatus, useYouProfileData } from '../use-you-profile-data';

describe('useYouProfileData filter state', () => {
  it('defaults to no active filters (all boards, all time)', () => {
    const { result } = renderHook(() => useYouProfileData('user-1'));
    expect(result.current.selectedBoard).toBe('all');
    expect(result.current.timeframe).toBe('all');
    expect(result.current.hasActiveFilters).toBe(false);
  });

  it('flags active filters when the timeframe changes, and clears on reset', () => {
    const { result } = renderHook(() => useYouProfileData('user-1'));

    act(() => result.current.setTimeframe('lastWeek'));
    expect(result.current.timeframe).toBe('lastWeek');
    expect(result.current.hasActiveFilters).toBe(true);

    act(() => result.current.setTimeframe('all'));
    expect(result.current.hasActiveFilters).toBe(false);
  });

  it('flags active filters when a specific board is selected, and clears on reset', () => {
    const { result } = renderHook(() => useYouProfileData('user-1'));

    act(() => result.current.setSelectedBoard('kilter'));
    expect(result.current.selectedBoard).toBe('kilter');
    expect(result.current.hasActiveFilters).toBe(true);

    act(() => result.current.setSelectedBoard('all'));
    expect(result.current.hasActiveFilters).toBe(false);
  });

  it('stays active while either board or timeframe is non-default', () => {
    const { result } = renderHook(() => useYouProfileData('user-1'));

    act(() => {
      result.current.setSelectedBoard('tension');
      result.current.setTimeframe('lastMonth');
    });
    expect(result.current.hasActiveFilters).toBe(true);

    // Clearing only the board still leaves the timeframe filter active.
    act(() => result.current.setSelectedBoard('all'));
    expect(result.current.hasActiveFilters).toBe(true);
  });

  it('defaults comparisonMode to trailing and exposes a setter', () => {
    const { result } = renderHook(() => useYouProfileData('user-1'));
    expect(result.current.comparisonMode).toBe('trailing');

    act(() => result.current.setComparisonMode('yearOverYear'));
    expect(result.current.comparisonMode).toBe('yearOverYear');
  });

  it('reports loading until a userId is available', () => {
    const { result, rerender } = renderHook(({ userId }) => useYouProfileData(userId), {
      initialProps: { userId: undefined as string | undefined },
    });
    // No signed-in user yet → loading, regardless of the (settled) queries.
    expect(result.current.loading).toBe(true);

    rerender({ userId: 'user-1' });
    expect(result.current.loading).toBe(false);
  });
});

describe('profileTotalsStatus', () => {
  it('is ready only when the totals have data', () => {
    expect(profileTotalsStatus({ data: { totalDistinctClimbs: 0 }, status: 'success', fetchStatus: 'idle' })).toBe(
      'ready',
    );
    // A refetch error keeps the last good totals on screen.
    expect(profileTotalsStatus({ data: { totalDistinctClimbs: 3 }, status: 'error', fetchStatus: 'idle' })).toBe(
      'ready',
    );
  });

  it('is loading while the first request is in flight', () => {
    expect(profileTotalsStatus({ data: undefined, status: 'pending', fetchStatus: 'fetching' })).toBe('loading');
  });

  it('is error when the request failed with nothing cached', () => {
    expect(profileTotalsStatus({ data: undefined, status: 'error', fetchStatus: 'idle' })).toBe('error');
  });

  it('is offline when the request is paused for want of a network', () => {
    expect(profileTotalsStatus({ data: undefined, status: 'pending', fetchStatus: 'paused' })).toBe('offline');
  });
});

describe('useYouProfileData totals gate', () => {
  it('does not hold the whole tab on a spinner while only the totals are pending', () => {
    vi.mocked(useUserProfileStats).mockReturnValueOnce({
      ...settledQuery,
      data: undefined,
      isPending: true,
      status: 'pending',
      fetchStatus: 'fetching',
    } as unknown as ReturnType<typeof useUserProfileStats>);
    const { result } = renderHook(() => useYouProfileData('user-1'));
    expect(result.current.loading).toBe(false);
    expect(result.current.totalsStatus).toBe('loading');
  });
});
