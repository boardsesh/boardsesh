// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { SearchRequestPagination } from '@/app/lib/types';

/**
 * `/b/{slug}/{angle}/list?invite=` hands the share link to the bare `/b/{slug}`
 * page, which is the one place a token is redeemed or turned into a sign-in.
 * The list page itself never reads the board for it and never renders with it.
 */

class RedirectSignal extends Error {
  constructor(readonly target: string) {
    super(`redirect:${target}`);
  }
}

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  redirect: (target: string) => {
    throw new RedirectSignal(target);
  },
}));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({ t: (key: string) => key, locale: 'en-US' })),
}));
const resolveBoardBySlug = vi.fn();
vi.mock('@/app/lib/board-slug-utils', () => ({ resolveBoardBySlug, boardToRouteParamsFromAngleSegment: vi.fn() }));
vi.mock('@/app/lib/board-utils', () => ({ getBoardDetailsForBoard: vi.fn() }));
const fetchFrontDoorListPage = vi.fn();
vi.mock('@/app/lib/data/list-page-data.server', () => ({ fetchFrontDoorListPage }));
vi.mock('@/app/lib/spray/spray-wall-render-data.server', () => ({}));
vi.mock('@/app/components/climb-front-door/static-list-front-door', () => ({ default: () => null }));
vi.mock('@/app/components/spray-wall/spray-wall-front-door', () => ({ default: () => null }));

const { default: BoardSlugListPage } = await import('../page');

const TOKEN = 'Ab3_dE-fGhIjKlMnOpQrSt';

function propsWith(invite: string | string[]) {
  return {
    params: Promise.resolve({ board_slug: 'friends-garage', angle: '40' }),
    searchParams: Promise.resolve({ invite } as SearchRequestPagination & { invite?: string | string[] }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a share link that lands on the list page', () => {
  it('goes to the bare board page with the token and nothing else', async () => {
    const outcome = await BoardSlugListPage(propsWith(TOKEN)).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(RedirectSignal);
    expect((outcome as RedirectSignal).target).toBe(`/b/friends-garage?invite=${TOKEN}`);
    expect(resolveBoardBySlug).not.toHaveBeenCalled();
    expect(fetchFrontDoorListPage).not.toHaveBeenCalled();
  });

  it('ignores a malformed token and serves the list as usual', async () => {
    resolveBoardBySlug.mockResolvedValue(null);
    const outcome = await BoardSlugListPage(propsWith('short')).catch((error: unknown) => error);
    expect(outcome).not.toBeInstanceOf(RedirectSignal);
    expect(resolveBoardBySlug).toHaveBeenCalledWith('friends-garage', undefined);
  });
});
