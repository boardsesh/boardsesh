// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLIMB_FILTER_STATE, DEFAULT_CLIMB_BOARD_FILTER_STATE } from '@boardsesh/climb-filters';
import type { Climb } from '@boardsesh/shared-schema';

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../../../lib/analytics', () => analytics);
vi.mock('../../../components/ClimbFilterSheet', async () => {
  const { hasActiveClimbFilters } = await import('@boardsesh/climb-filters');
  return { hasActiveFilters: hasActiveClimbFilters };
});
import { useClimbSearchAnalytics } from '../use-climb-search-analytics';

type Options = Parameters<typeof useClimbSearchAnalytics>[0];
const climb: Climb = {
  uuid: 'climb-1',
  name: 'Zenith',
  setter_username: 'setter',
  frames: '',
  angle: 40,
  ascensionist_count: 1,
  difficulty: '6a/V3',
  quality_average: '3',
  stars: 3,
  difficulty_error: '0',
  benchmark_difficulty: null,
};

function renderSearchAnalytics(overrides: Partial<Options> = {}) {
  const initialProps: Options = {
    firstSearchPage: { climbs: [] },
    isPlaceholderData: false,
    showFilters: false,
    climbCount: 0,
    name: 'no such climb',
    filters: DEFAULT_CLIMB_FILTER_STATE,
    boardFilters: DEFAULT_CLIMB_BOARD_FILTER_STATE,
    boardName: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    angle: 40,
    gradeFormat: 'v-grade',
    ...overrides,
  };
  return { ...renderHook(useClimbSearchAnalytics, { initialProps }), initialProps };
}

beforeEach(() => vi.clearAllMocks());

describe('useClimbSearchAnalytics', () => {
  it('reports a repeated empty search after a settled clear without tracking the default browse', () => {
    const search = renderSearchAnalytics();
    expect(analytics.track).toHaveBeenCalledOnce();

    search.rerender({ ...search.initialProps, name: '' });
    expect(analytics.track).toHaveBeenCalledOnce();

    search.rerender(search.initialProps);
    expect(analytics.track).toHaveBeenCalledTimes(2);
    expect(analytics.track).toHaveBeenLastCalledWith(
      'Climb Search Performed',
      expect.objectContaining({ hasQuery: true, resultCount: 0 }),
    );
    expect(analytics.track.mock.calls[1][1]).not.toHaveProperty('name');
    expect(analytics.track.mock.calls[1][1]).not.toHaveProperty('query');
  });

  it('keeps rerenders, refreshed first pages and pagination within one search event', () => {
    const search = renderSearchAnalytics({
      name: climb.name,
      firstSearchPage: { climbs: [climb] },
      climbCount: 1,
    });
    search.rerender({ ...search.initialProps });
    search.rerender({ ...search.initialProps, firstSearchPage: { climbs: [climb] } });
    search.rerender({ ...search.initialProps, climbCount: 2 });
    expect(analytics.track).toHaveBeenCalledExactlyOnceWith(
      'Climb Search Performed',
      expect.objectContaining({ resultCount: 1 }),
    );
  });

  it.each(['unresolved', 'placeholder', 'open filters'] as const)(
    'does not reset deduplication for default states marked %s',
    (state) => {
      const search = renderSearchAnalytics();
      search.rerender({
        ...search.initialProps,
        name: '',
        firstSearchPage: state === 'unresolved' ? undefined : search.initialProps.firstSearchPage,
        isPlaceholderData: state === 'placeholder',
        showFilters: state === 'open filters',
      });
      search.rerender(search.initialProps);
      expect(analytics.track).toHaveBeenCalledOnce();
    },
  );

  it('waits for a resolved search outside the filter sheet before reporting', () => {
    const search = renderSearchAnalytics({ firstSearchPage: undefined });
    expect(analytics.track).not.toHaveBeenCalled();
    search.rerender({ ...search.initialProps, firstSearchPage: { climbs: [] }, isPlaceholderData: true });
    search.rerender({ ...search.initialProps, firstSearchPage: { climbs: [] }, showFilters: true });
    expect(analytics.track).not.toHaveBeenCalled();
    search.rerender({ ...search.initialProps, firstSearchPage: { climbs: [] } });
    expect(analytics.track).toHaveBeenCalledOnce();
  });
});
