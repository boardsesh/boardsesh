import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { BoardDetails, SearchRequestPagination } from '@/app/lib/types';
import { DEFAULT_SEARCH_PARAMS } from '@/app/lib/url-utils';
import AccordionSearchForm from '../accordion-search-form';

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

vi.mock('@/app/components/providers/auth-modal-provider', () => ({
  useAuthModal: () => ({ openAuthModal: vi.fn() }),
}));

vi.mock('../search-climb-name-input', () => ({
  default: () => null,
}));

vi.mock('../setter-name-select', () => ({
  default: () => null,
}));

vi.mock('../climb-hold-search-form', () => ({
  default: () => null,
}));

vi.mock('../search-summary-utils', () => ({
  getQualityPanelSummary: () => '',
  getStatusPanelSummary: () => '',
  getUserPanelSummary: () => '',
  getHoldsPanelSummary: () => '',
}));

const boardDetails = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 1,
  set_ids: [],
  size_name: '12 x 12',
} as unknown as BoardDetails;

describe('AccordionSearchForm — numeric handlers never emit undefined', () => {
  beforeEach(() => {
    mockUpdateFilters.mockClear();
    mockUISearchParams = { ...DEFAULT_SEARCH_PARAMS };
  });

  // Regression for Sentry issues 7434008446 / 7435688419 / 7439815956:
  // clearing a numeric input previously dispatched `undefined`, which then
  // crashed `searchParamsToUrlParams` in mobile Safari. The handlers must emit
  // 0 (the DEFAULT_SEARCH_PARAMS sentinel) instead.
  const findNumericInputs = () =>
    screen
      .getAllByPlaceholderText('Any')
      .filter((el): el is HTMLInputElement => (el as HTMLInputElement).type === 'number');

  it('Min Ascents emits 0 when cleared', () => {
    mockUISearchParams = { ...DEFAULT_SEARCH_PARAMS, minAscents: 5 };
    render(<AccordionSearchForm boardDetails={boardDetails} />);
    // Source order: [0]=Min Ascents, [1]=Min Rating.
    const minAscents = findNumericInputs()[0];
    expect(minAscents.value).toBe('5');

    fireEvent.change(minAscents, { target: { value: '' } });
    const lastCall = mockUpdateFilters.mock.calls.at(-1)?.[0];
    expect(lastCall).toEqual({ minAscents: 0 });
    expect(lastCall?.minAscents).not.toBeUndefined();
  });

  it('Min Rating emits 0 when cleared', () => {
    mockUISearchParams = { ...DEFAULT_SEARCH_PARAMS, minRating: 2.5 };
    render(<AccordionSearchForm boardDetails={boardDetails} />);
    const minRating = findNumericInputs()[1];
    expect(minRating.value).toBe('2.5');

    fireEvent.change(minRating, { target: { value: '' } });
    const lastCall = mockUpdateFilters.mock.calls.at(-1)?.[0];
    expect(lastCall).toEqual({ minRating: 0 });
    expect(lastCall?.minRating).not.toBeUndefined();
  });

  it('Min Ascents emits the typed number verbatim', () => {
    render(<AccordionSearchForm boardDetails={boardDetails} />);
    const minAscents = findNumericInputs()[0];
    fireEvent.change(minAscents, { target: { value: '12' } });
    expect(mockUpdateFilters.mock.calls.at(-1)?.[0]).toEqual({ minAscents: 12 });
  });
});
