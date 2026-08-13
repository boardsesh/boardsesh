import { describe, it, expect, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { BoardDetails } from '@/app/lib/types';
import BoardSeshHeader from '../header';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
}));

// The create button only renders off the list/playlist/logbook surfaces.
vi.mock('next/navigation', () => ({
  usePathname: () => '/kilter/original/12x12-square/screw_bolt/40/view/some-climb',
}));

vi.mock('../../graphql-queue', () => ({
  useCurrentClimb: () => ({ currentClimb: null }),
  useSearchData: () => ({ totalSearchResultCount: 0, isFetchingClimbs: false }),
}));

vi.mock('../../queue-control/ui-searchparams-provider', () => ({
  useUISearchParams: () => ({
    uiSearchParams: {},
    clearClimbSearchParams: vi.fn(),
    updateFilters: vi.fn(),
  }),
}));

vi.mock('../../search-drawer/search-summary-utils', () => ({
  hasActiveFilters: () => false,
  hasActiveNonNameFilters: () => false,
  getSearchPillSummary: () => '',
  createSearchSummaryLabels: () => ({}),
}));

vi.mock('../../search-drawer/search-drawer-bridge-context', () => ({
  SearchDrawerBridgeInjector: () => null,
}));

vi.mock('../../search-drawer/unified-search-drawer', () => ({ default: () => null }));
vi.mock('../../search-drawer/accordion-search-form', () => ({ default: () => null }));
vi.mock('../../search-drawer/recent-searches-storage', () => ({ addRecentSearch: vi.fn() }));
vi.mock('../angle-selector', () => ({ default: () => null }));
vi.mock('../header.module.css', () => ({
  default: new Proxy({}, { get: (_target, prop) => String(prop) }),
}));

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

function makeBoardDetails(overrides: Partial<BoardDetails>): BoardDetails {
  return {
    images_to_holds: {},
    holdsData: [],
    edge_left: 0,
    edge_right: 0,
    edge_bottom: 0,
    edge_top: 0,
    boardHeight: 0,
    boardWidth: 0,
    board_name: 'kilter',
    layout_id: 1,
    set_ids: [1, 20],
    layout_name: 'Kilter Board Original',
    size_description: 'Square',
    set_names: ['Bolt Ons', 'Screw Ons'],
    ...overrides,
  } as BoardDetails;
}

function createHref() {
  return screen.getByRole('link').getAttribute('href');
}

/**
 * Kilter layout 1 carries two "12 x 12" squares — id 10 ("with kickboard") and
 * id 27 ("without kickboard") — that both name-slug to `12x12-square`. The
 * header holds the numeric ids on `boardDetails`, so its Create button can and
 * must address the exact one.
 */
describe('BoardSeshHeader create button URL', () => {
  it('emits the qualified size slug for the shadowed size', () => {
    render(
      <BoardSeshHeader
        boardDetails={makeBoardDetails({ size_id: 27, size_name: '12 x 12 without kickboard' })}
        angle={40}
      />,
    );

    expect(createHref()).toBe('/kilter/original/12x12-square-without-kickboard/screw_bolt/40/create');
  });

  it('leaves the size that owns the bare slug on it', () => {
    render(
      <BoardSeshHeader
        boardDetails={makeBoardDetails({ size_id: 10, size_name: '12 x 12 with kickboard' })}
        angle={40}
      />,
    );

    expect(createHref()).toBe('/kilter/original/12x12-square/screw_bolt/40/create');
  });

  it('falls back to the name-based URL for a board the static tables do not carry', () => {
    render(
      <BoardSeshHeader
        boardDetails={makeBoardDetails({
          layout_id: 9999,
          size_id: 9999,
          set_ids: [9999],
          layout_name: 'Kilter Board Homewall',
          size_name: '8 x 12',
          size_description: 'Home',
          set_names: ['Mainline'],
        })}
        angle={40}
      />,
    );

    expect(createHref()).toBe('/kilter/homewall/8x12-home/main/40/create');
  });

  it('renders no create link without an angle', () => {
    render(
      <BoardSeshHeader boardDetails={makeBoardDetails({ size_id: 27, size_name: '12 x 12 without kickboard' })} />,
    );

    expect(screen.queryByRole('link')).toBeNull();
  });
});
