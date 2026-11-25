import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * "Something wrong with this board? Report a problem" on `/b/{slug}/{angle}/list`
 * (docs/product/directory-reports.md). The page is in a shared CDN cache, so the
 * link depends on the `directory-reports` flag alone: never on who is reading.
 */

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ notFound: vi.fn(), redirect: vi.fn() }));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({ t: (key: string) => key, locale: 'en-US' })),
}));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale: vi.fn(async () => 'en-US') }));
vi.mock('@/app/lib/backend-url', () => ({ getPublicBackendHttpUrl: () => 'https://ws.boardsesh.com' }));

const reportsEnabled = vi.hoisted(() => ({ current: false }));
vi.mock('@/app/lib/directory-reports/directory-reports-flag', () => ({
  isDirectoryReportsEnabled: vi.fn(async () => reportsEnabled.current),
}));
const setupSuggestionsEnabled = vi.hoisted(() => ({ current: false }));
vi.mock('@/app/lib/directory-reports/directory-setup-suggestions-flag', () => ({
  isDirectorySetupSuggestionsEnabled: vi.fn(async () => setupSuggestionsEnabled.current),
}));

vi.mock('@/app/lib/board-slug-utils', () => ({
  resolveBoardBySlug: vi.fn(async () => ({
    uuid: 'board-uuid-1',
    slug: 'my-board',
    name: 'Backspace',
    angle: 40,
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 7,
    setIds: '1,20',
    isPublic: true,
    isUnlisted: false,
  })),
  resolveBoardBySlugAsStranger: vi.fn(),
  boardToRouteParamsFromAngleSegment: vi.fn(() => ({
    board_name: 'kilter',
    layout_id: 1,
    size_id: 7,
    set_ids: [1, 20],
    angle: 40,
  })),
}));
vi.mock('@/app/lib/data/list-page-data.server', () => ({
  fetchFrontDoorListPage: vi.fn(async () => ({
    boardDetails: { board_name: 'kilter', layout_id: 1, size_id: 7, set_ids: [1, 20] },
    climbs: [],
    hasMore: false,
    preloadUrls: [],
  })),
}));
vi.mock('@/app/components/climb-front-door/static-list-front-door', () => ({ default: () => null }));
vi.mock('@/app/components/providers/i18n-provider', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

const BoardSlugListPage = (await import('@/app/(site)/b/[board_slug]/[angle]/list/page')).default;
const StaticListFrontDoor = (await import('@/app/components/climb-front-door/static-list-front-door')).default;
const BoardReportLink = (await import('@/app/components/directory-reports/board-report-link')).default;

function findElements(node: React.ReactNode, type: unknown): React.ReactElement[] {
  const found: React.ReactElement[] = [];
  const visit = (current: React.ReactNode): void => {
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    if (!React.isValidElement(current)) return;
    if (current.type === type) found.push(current);
    const props = current.props as { children?: React.ReactNode; reportProblem?: React.ReactNode };
    visit(props.children);
    visit(props.reportProblem);
  };
  visit(node);
  return found;
}

const renderPage = () =>
  BoardSlugListPage({
    params: Promise.resolve({ board_slug: 'my-board', angle: '40' }),
    searchParams: Promise.resolve({} as never),
  });

beforeEach(() => {
  reportsEnabled.current = false;
  setupSuggestionsEnabled.current = false;
});

describe('the board list Report a problem link', () => {
  it('renders the link for this board while the flag is on', async () => {
    reportsEnabled.current = true;
    const tree = await renderPage();
    const links = findElements(tree, BoardReportLink);
    expect(links).toHaveLength(1);
    expect((links[0].props as { boardUuid: string }).boardUuid).toBe('board-uuid-1');
  });

  it('hands the link the setup-suggestions flag, and the store words only when the fields can show', async () => {
    reportsEnabled.current = true;
    let [link] = findElements(await renderPage(), BoardReportLink);
    expect(link.props).toMatchObject({ setupSuggestionsEnabled: false, storeLabels: null });

    setupSuggestionsEnabled.current = true;
    [link] = findElements(await renderPage(), BoardReportLink);
    expect(link.props).toMatchObject({ setupSuggestionsEnabled: true, storeLabels: { locale: 'en-US' } });
  });

  it('renders nothing while the flag is off', async () => {
    const tree = await renderPage();
    const [frontDoor] = findElements(tree, StaticListFrontDoor);
    expect((frontDoor.props as { reportProblem?: React.ReactNode }).reportProblem).toBeUndefined();
    expect(findElements(tree, BoardReportLink)).toHaveLength(0);
  });
});
