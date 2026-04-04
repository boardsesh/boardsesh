import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RecentSearchPills from '../recent-search-pills';

const mockGetRecentSearches = vi.fn();
const mockUpdateFilters = vi.fn();

vi.mock('@/app/components/queue-control/ui-searchparams-provider', () => ({
  useUISearchParams: () => ({
    uiSearchParams: {},
    updateFilters: mockUpdateFilters,
  }),
}));

vi.mock('../recent-searches-storage', () => ({
  getRecentSearches: () => mockGetRecentSearches(),
  getFilterKey: (filters: unknown) => JSON.stringify(filters),
  RECENT_SEARCHES_CHANGED_EVENT: 'boardsesh:recent-searches-changed',
}));

describe('RecentSearchPills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders shadow pills before the initial recent-search load resolves', async () => {
    let resolveSearches!: (value: unknown[]) => void;
    mockGetRecentSearches.mockImplementation(
      () =>
        new Promise<unknown[]>((resolve) => {
          resolveSearches = resolve;
        }),
    );

    render(<RecentSearchPills />);

    expect(screen.getByTestId('recent-search-pills-loading')).toBeTruthy();
    expect(screen.getAllByTestId('recent-search-pill-shadow')).toHaveLength(5);

    resolveSearches([]);

    await waitFor(() => {
      expect(screen.queryByTestId('recent-search-pills-loading')).toBeNull();
    });
  });

  it('replaces the placeholders with real pills when recent searches exist', async () => {
    mockGetRecentSearches.mockResolvedValue([
      {
        id: 'search-1',
        label: 'V5-V7',
        filters: { minGrade: 10, maxGrade: 14 },
        timestamp: Date.now(),
      },
    ]);

    render(<RecentSearchPills />);

    await waitFor(() => {
      expect(screen.getByText('V5-V7')).toBeTruthy();
    });

    expect(screen.queryByTestId('recent-search-pills-loading')).toBeNull();
    expect(screen.queryByTestId('recent-search-pill-shadow')).toBeNull();
  });

  it('collapses after hydration when there are no recent searches', async () => {
    mockGetRecentSearches.mockResolvedValue([]);

    const { container } = render(<RecentSearchPills />);

    expect(screen.getByTestId('recent-search-pills-loading')).toBeTruthy();

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });
});
