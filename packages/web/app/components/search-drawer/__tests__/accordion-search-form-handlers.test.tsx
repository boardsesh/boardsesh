import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { BoardDetails, SearchRequestPagination } from '@/app/lib/types';
import { DEFAULT_SEARCH_PARAMS } from '@/app/lib/url-utils';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// Stub IndexedDB-backed preferences so the form's `useLastUsedGrade` hook
// (and the grade-format hook it transitively triggers) doesn't try to open a
// real database in the test environment.
const mockGetLastUsedGrade = vi.fn();
const mockSetLastUsedGrade = vi.fn();
vi.mock('@/app/lib/user-preferences-db', () => ({
  getLastUsedGrade: () => mockGetLastUsedGrade(),
  setLastUsedGrade: (value: number) => mockSetLastUsedGrade(value),
  getPreference: () => Promise.resolve(null),
  setPreference: () => Promise.resolve(undefined),
  removePreference: () => Promise.resolve(undefined),
  getAlwaysTickInApp: () => Promise.resolve(false),
  setAlwaysTickInApp: () => Promise.resolve(undefined),
  getGradeDisplayFormat: () => Promise.resolve('v-grade'),
  setGradeDisplayFormat: () => Promise.resolve(undefined),
}));

const mockUpdateFilters = vi.fn();
let mockUISearchParams: SearchRequestPagination = { ...DEFAULT_SEARCH_PARAMS };

vi.mock('@/app/components/queue-control/ui-searchparams-provider', () => ({
  useUISearchParams: () => ({
    uiSearchParams: mockUISearchParams,
    updateFilters: mockUpdateFilters,
  }),
}));

vi.mock('@/app/components/board-provider/board-provider-context', () => ({
  useBoardProvider: () => ({ isAuthenticated: false }),
}));

const mockTrack = vi.fn();
vi.mock('@/app/lib/analytics', () => ({
  track: (name: string, properties?: Record<string, unknown>) => mockTrack(name, properties),
}));

vi.mock('@/app/components/providers/auth-modal-provider', () => ({
  useAuthModal: () => ({ openAuthModal: vi.fn() }),
}));

// Deterministic seed so the reshuffle assertion isn't probabilistic.
vi.mock('@boardsesh/climb-filters', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/climb-filters')>()),
  newSortSeed: () => '999',
}));

vi.mock('../search-climb-name-input', () => ({
  default: () => null,
}));

vi.mock('../setter-name-select', () => ({
  default: () => null,
}));

vi.mock('../climb-search-form', () => ({
  default: () => null,
}));

vi.mock('../search-summary-utils', () => ({
  createSearchSummaryLabels: () => ({
    quality: {
      tallClimbsOnly: 'Tall',
      wideClimbsOnly: 'Wide',
    },
    status: {
      drafts: 'Drafts',
      projects: 'Projects',
      established: 'Established',
    },
    user: {
      attempted: 'attempted',
      completed: 'completed',
    },
    holds: {
      count: (count: number) => `${count} holds`,
    },
    zone: 'Zone',
    zoneModes: {
      allHolds: 'All holds inside',
      anyHold: 'At least 1 hold',
    },
  }),
  getQualityPanelSummary: () => [],
  getStatusPanelSummary: () => [],
  getUserPanelSummary: () => [],
  getHoldsPanelSummary: () => [],
  getZonePanelSummary: () => [],
}));

import AccordionSearchForm from '../accordion-search-form';

const boardDetails = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 1,
  set_ids: [],
  size_name: '12 x 12',
} as unknown as BoardDetails;

const makeBoardDetails = (overrides: Partial<BoardDetails>): BoardDetails =>
  ({
    ...boardDetails,
    ...overrides,
  }) as BoardDetails;

describe('AccordionSearchForm — quality filter controls', () => {
  beforeEach(() => {
    mockUpdateFilters.mockClear();
    mockTrack.mockClear();
    mockGetLastUsedGrade.mockReset().mockResolvedValue(undefined);
    mockSetLastUsedGrade.mockReset().mockResolvedValue(undefined);
    mockUISearchParams = { ...DEFAULT_SEARCH_PARAMS };
  });

  // The old numeric-input Sentry regressions are covered by controls that always emit concrete sentinels.
  it('renders quality controls without raw number inputs', () => {
    const { container } = render(<AccordionSearchForm boardDetails={boardDetails} />);
    expect(container.querySelector('input[type="number"]')).toBeNull();
  });

  it('Min Ascents preset emits the selected threshold', () => {
    render(<AccordionSearchForm boardDetails={boardDetails} />);

    fireEvent.click(screen.getByRole('button', { name: '10+' }));

    expect(mockUpdateFilters.mock.calls.at(-1)?.[0]).toEqual({ minAscents: 10 });
  });

  it('Min Ascents selected zero bucket emits the 0 sentinel when clicked again', () => {
    render(<AccordionSearchForm boardDetails={boardDetails} />);

    fireEvent.click(screen.getByRole('button', { name: '0+' }));

    expect(mockUpdateFilters.mock.calls.at(-1)?.[0]).toEqual({ minAscents: 0 });
  });

  it('renders the requested Min Ascents buckets', () => {
    render(<AccordionSearchForm boardDetails={boardDetails} />);

    for (const label of ['0+', '1+', '10+', '100+', '1k+', '10k+']) {
      expect(screen.getByRole('button', { name: label })).toBeDefined();
    }
  });

  it('Min Rating star picker emits whole-star thresholds', () => {
    render(<AccordionSearchForm boardDetails={boardDetails} />);
    fireEvent.click(screen.getByRole('option', { name: '4 stars and up' }));
    expect(mockUpdateFilters.mock.calls.at(-1)?.[0]).toEqual({ minRating: 4 });
  });

  it('Min Rating clear option emits the 0 sentinel', () => {
    mockUISearchParams = { ...DEFAULT_SEARCH_PARAMS, minRating: 3 };
    render(<AccordionSearchForm boardDetails={boardDetails} />);
    const ratingListbox = screen.getByRole('listbox', { name: 'Min Rating' });
    const anyRatingOption = within(ratingListbox).getByRole('option', { name: 'Any' });
    expect(anyRatingOption.textContent).toBe('Any');
    fireEvent.click(anyRatingOption);
    const lastCall = mockUpdateFilters.mock.calls.at(-1)?.[0];
    expect(lastCall).toEqual({ minRating: 0 });
    expect(lastCall?.minRating).not.toBeUndefined();
  });

  it('rounds a legacy decimal Min Rating up to the next whole-star display', () => {
    mockUISearchParams = { ...DEFAULT_SEARCH_PARAMS, minRating: 2.5 };
    render(<AccordionSearchForm boardDetails={boardDetails} />);
    expect(screen.getByRole('option', { name: '3 stars and up' }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows wide climbs filter for 10x10 Kilter Homewall and updates filters', () => {
    render(
      <AccordionSearchForm
        boardDetails={makeBoardDetails({ board_name: 'kilter', layout_id: 8, size_id: 21, size_name: '10x10' })}
      />,
    );

    expect(screen.queryByText('Tall Climbs Only')).toBeNull();
    expect(screen.getByText('Wide Climbs Only')).toBeDefined();
    fireEvent.click(screen.getByRole('switch', { name: 'Show only climbs that use the 10x10 side expansion holds' }));

    expect(mockUpdateFilters.mock.calls.at(-1)?.[0]).toEqual({ onlyWideClimbs: true });
  });

  it('shows wide climbs filter for the 10x10 Auxiliary LED Kit size', () => {
    render(
      <AccordionSearchForm
        boardDetails={makeBoardDetails({
          board_name: 'kilter',
          layout_id: 8,
          size_id: 29,
          size_name: 'Auxiliary LED Kit',
        })}
      />,
    );

    expect(screen.getByText('Wide Climbs Only')).toBeDefined();
  });

  it('shows tall and wide climbs filters for 10x12 Kilter Homewall', () => {
    render(
      <AccordionSearchForm
        boardDetails={makeBoardDetails({ board_name: 'kilter', layout_id: 8, size_id: 25, size_name: '10x12' })}
      />,
    );

    expect(screen.getByText('Tall Climbs Only')).toBeDefined();
    expect(screen.getByText('Wide Climbs Only')).toBeDefined();
  });

  it('shows tall but not wide climbs filter for 8x12 Kilter Homewall', () => {
    render(
      <AccordionSearchForm
        boardDetails={makeBoardDetails({ board_name: 'kilter', layout_id: 8, size_id: 23, size_name: '8x12' })}
      />,
    );

    expect(screen.getByText('Tall Climbs Only')).toBeDefined();
    expect(screen.queryByText('Wide Climbs Only')).toBeNull();
  });

  it('uses the size id, not size name text, for tall-climbs availability', () => {
    render(
      <AccordionSearchForm
        boardDetails={makeBoardDetails({ board_name: 'kilter', layout_id: 8, size_id: 26, size_name: 'Large' })}
      />,
    );

    expect(screen.getByText('Tall Climbs Only')).toBeDefined();
  });

  it('does not show tall climbs for non-tall size ids with misleading names', () => {
    render(
      <AccordionSearchForm
        boardDetails={makeBoardDetails({ board_name: 'kilter', layout_id: 8, size_id: 22, size_name: '10x12' })}
      />,
    );

    expect(screen.queryByText('Tall Climbs Only')).toBeNull();
  });

  it('does not show wide climbs filter for boards without 10x10 side expansions', () => {
    const unsupportedBoards = [
      makeBoardDetails({ board_name: 'kilter', layout_id: 8, size_name: '7x10' }),
      makeBoardDetails({ board_name: 'kilter', layout_id: 8, size_name: '8x12' }),
      makeBoardDetails({ board_name: 'kilter', layout_id: 1, size_name: '10x12' }),
      makeBoardDetails({ board_name: 'tension', layout_id: 8, size_name: '10x12' }),
    ];

    for (const unsupportedBoard of unsupportedBoards) {
      const { unmount } = render(<AccordionSearchForm boardDetails={unsupportedBoard} />);
      expect(screen.queryByText('Wide Climbs Only')).toBeNull();
      unmount();
    }
  });

  describe('grade range picker (chip row)', () => {
    // V6 = 7a = difficulty_id 22. V11 = 8a = 28.
    // Scope chip lookup to the picker's listbox so "Any" doesn't collide with
    // the Min Rating picker's "Any" option, which lives in a separate listbox.
    const tapChip = (label: string) => {
      const listbox = screen.getByRole('listbox', { name: 'Grade range' });
      const chip = within(listbox).getByRole('option', { name: label });
      fireEvent.click(chip);
    };

    it('tapping a grade chip collapses both bounds to that grade', () => {
      render(<AccordionSearchForm boardDetails={boardDetails} />);
      tapChip('V6');
      expect(mockUpdateFilters.mock.calls.at(-1)?.[0]).toEqual({ minGrade: 22, maxGrade: 22 });
    });

    it('tapping the currently-selected single chip clears both bounds (0 sentinel)', () => {
      mockUISearchParams = { ...DEFAULT_SEARCH_PARAMS, minGrade: 22, maxGrade: 22 };
      render(<AccordionSearchForm boardDetails={boardDetails} />);
      tapChip('V6');
      const lastCall = mockUpdateFilters.mock.calls.at(-1)?.[0];
      // Regression guard: updateFilters strips undefined fields, so emitting
      // undefined here would silently no-op the clear. The handler coerces to 0.
      expect(lastCall).toEqual({ minGrade: 0, maxGrade: 0 });
      expect(lastCall?.minGrade).not.toBeUndefined();
      expect(lastCall?.maxGrade).not.toBeUndefined();
    });

    it('tapping the "Any" clear chip clears both bounds', () => {
      mockUISearchParams = { ...DEFAULT_SEARCH_PARAMS, minGrade: 22, maxGrade: 28 };
      render(<AccordionSearchForm boardDetails={boardDetails} />);
      tapChip('Any');
      expect(mockUpdateFilters.mock.calls.at(-1)?.[0]).toEqual({ minGrade: 0, maxGrade: 0 });
    });

    it('tapping a different grade while a range is set collapses to that single grade', () => {
      mockUISearchParams = { ...DEFAULT_SEARCH_PARAMS, minGrade: 22, maxGrade: 28 };
      render(<AccordionSearchForm boardDetails={boardDetails} />);
      tapChip('V8');
      // V8 → difficulty_id 24 (7b)
      expect(mockUpdateFilters.mock.calls.at(-1)?.[0]).toEqual({ minGrade: 24, maxGrade: 24 });
    });

    it('does not persist a "last used grade" — the URL params already capture the range', () => {
      render(<AccordionSearchForm boardDetails={boardDetails} />);
      tapChip('V6');
      expect(mockSetLastUsedGrade).not.toHaveBeenCalled();
    });
  });
});

describe('AccordionSearchForm — random sort', () => {
  beforeEach(() => {
    mockUpdateFilters.mockClear();
    mockUISearchParams = { ...DEFAULT_SEARCH_PARAMS };
  });

  it('shows "Shuffle again" for random and mints a fresh seed on click', () => {
    mockUISearchParams = { ...DEFAULT_SEARCH_PARAMS, sortBy: 'random', sortSeed: '5' };
    render(<AccordionSearchForm boardDetails={boardDetails} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));

    fireEvent.click(screen.getByRole('button', { name: 'Shuffle again' }));

    // newSortSeed is mocked to '999', so a click replaces the stale '5' seed —
    // MuiButton onClick fires every click (unlike MuiSelect onChange, which is
    // exactly why re-selecting Random in the dropdown couldn't reshuffle).
    expect(mockUpdateFilters).toHaveBeenCalledWith({ sortSeed: '999' });
  });

  it('hides "Shuffle again" for a non-random sort', () => {
    mockUISearchParams = { ...DEFAULT_SEARCH_PARAMS, sortBy: 'quality' };
    render(<AccordionSearchForm boardDetails={boardDetails} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    expect(screen.queryByRole('button', { name: 'Shuffle again' })).toBeNull();
  });
});
