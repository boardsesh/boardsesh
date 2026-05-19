import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { DEFAULT_SEARCH_PARAMS } from '@/app/lib/url-utils';
import BoardSeshHeader from '../header';
import type { BoardDetails } from '@/app/lib/types';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
}));

const mockPush = vi.fn();
let mockPathname = '/kilter/1/10/1,2/40/play/some-climb';

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

vi.mock('@/app/lib/i18n/use-locale-router', () => ({
  useLocaleRouter: () => ({ push: mockPush, replace: vi.fn() }),
}));

vi.mock('../../graphql-queue', () => ({
  useCurrentClimb: () => ({ currentClimb: null }),
  useSearchData: () => ({ totalSearchResultCount: 0, isFetchingClimbs: false }),
}));

vi.mock('../../queue-control/ui-searchparams-provider', () => ({
  useUISearchParams: () => ({
    uiSearchParams: DEFAULT_SEARCH_PARAMS,
    clearClimbSearchParams: vi.fn(),
    updateFilters: vi.fn(),
  }),
}));

vi.mock('../../search-drawer/unified-search-drawer', () => ({
  default: () => null,
}));

vi.mock('../../search-drawer/accordion-search-form', () => ({
  default: () => null,
}));

vi.mock('../../search-drawer/search-drawer-bridge-context', () => ({
  SearchDrawerBridgeInjector: () => null,
}));

vi.mock('../angle-selector', () => ({
  default: () => null,
}));

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../header.module.css', () => ({
  default: new Proxy({}, { get: (_target, prop) => String(prop) }),
}));

const boardDetails = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 10,
  set_ids: [1, 2],
  layout_name: 'Original',
  size_name: '12x12',
  size_description: 'Home',
  set_names: ['Bolt-On'],
} as unknown as BoardDetails;

describe('BoardSeshHeader getBackToListUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/kilter/1/10/1,2/40/play/some-climb';
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('preserves live URL query string when navigating back to the list', () => {
    // QueueContext writes filter state to the URL via history.replaceState,
    // which Next.js's useSearchParams() does not observe. The header must
    // read window.location.search directly so filters aren't dropped on
    // back-to-list.
    window.history.replaceState({}, '', '/kilter/1/10/1,2/40/play/some-climb?minGrade=10&onlyClassics=true');

    render(<BoardSeshHeader boardDetails={boardDetails} angle={40} />);

    fireEvent.click(screen.getByRole('button', { name: /back to climb list/i }));

    const pushedUrl = mockPush.mock.calls[0]?.[0] as string;
    expect(pushedUrl).toContain('minGrade=10');
    expect(pushedUrl).toContain('onlyClassics=true');
  });

  it('does not append a trailing ? when no filters are set', () => {
    window.history.replaceState({}, '', '/kilter/1/10/1,2/40/play/some-climb');

    render(<BoardSeshHeader boardDetails={boardDetails} angle={40} />);

    fireEvent.click(screen.getByRole('button', { name: /back to climb list/i }));

    const pushedUrl = mockPush.mock.calls[0]?.[0] as string;
    expect(pushedUrl).not.toContain('?');
  });
});
