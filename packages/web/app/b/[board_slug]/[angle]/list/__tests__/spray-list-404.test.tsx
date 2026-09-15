// @vitest-environment node
import { describe, expect, it, vi } from 'vite-plus/test';
import type { SearchRequestPagination } from '@/app/lib/types';

/**
 * A wall has no climb list on www, and this route is where `/b/{slug}` lands.
 *
 * Without the guard the page reaches `getBoardDetailsForBoard`, which has no
 * catalogue row to resolve for a wall and throws — a 500 on a URL the gym page
 * links to. A 404 is the honest answer for a page that does not exist.
 */

const NOT_FOUND_DIGEST = 'NEXT_HTTP_ERROR_FALLBACK;404';

vi.mock('server-only', () => ({}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: NOT_FOUND_DIGEST });
  }),
}));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({ t: (key: string) => key, locale: 'en-US' })),
}));

const resolveBoardBySlug = vi.fn(async (_slug: string) => ({
  uuid: 'wall-uuid-1',
  slug: 'garage-wall',
  boardType: 'spray',
  layoutId: 900,
  sizeId: 900,
  setIds: '1',
  name: 'Garage Wall',
  isPublic: true,
  isUnlisted: false,
  isOwned: false,
  ownerId: 'owner-1',
  angle: 40,
  isAngleAdjustable: false,
}));

vi.mock('@/app/lib/board-slug-utils', () => ({
  resolveBoardBySlug,
  boardToRouteParamsFromAngleSegment: vi.fn(() => ({
    board_name: 'spray',
    layout_id: 900,
    size_id: 900,
    set_ids: [1],
    angle: 40,
  })),
}));

const getBoardDetailsForBoard = vi.fn(() => {
  throw new Error('the catalogue has no size row for a spray wall');
});
vi.mock('@/app/lib/board-utils', () => ({
  getBoardDetailsForBoard: () => getBoardDetailsForBoard(),
}));

const fetchFrontDoorListPage = vi.fn();
vi.mock('@/app/lib/data/list-page-data.server', () => ({
  fetchFrontDoorListPage: (...args: unknown[]) => fetchFrontDoorListPage(...args),
}));

vi.mock('@/app/components/climb-front-door/static-list-front-door', () => ({ default: () => null }));

const { default: BoardSlugListPage, generateMetadata } = await import('../page');

const props = {
  params: Promise.resolve({ board_slug: 'garage-wall', angle: '40' }),
  searchParams: Promise.resolve({} as SearchRequestPagination),
};

describe('the /b/{slug}/{angle}/list route on a spray wall', () => {
  it('404s instead of reaching the catalogue', async () => {
    await expect(BoardSlugListPage(props)).rejects.toMatchObject({ digest: NOT_FOUND_DIGEST });
    expect(getBoardDetailsForBoard).not.toHaveBeenCalled();
    expect(fetchFrontDoorListPage).not.toHaveBeenCalled();
  });

  it('asks for no indexation of the page it does not serve', async () => {
    const metadata = await generateMetadata(props);

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBeUndefined();
  });
});
