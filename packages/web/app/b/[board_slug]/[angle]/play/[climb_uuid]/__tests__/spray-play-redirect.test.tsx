// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * `/play/...` canonicalises to `/view/...` on a spray wall too.
 *
 * The redirect was already board-agnostic, and that is worth a test rather than
 * a shrug: it is the one place a wall's share link could have kept a second
 * indexable URL for the same climb, and the spray view page self-canonicalises,
 * so a `/play` twin would be a duplicate with nothing pointing away from it.
 */

vi.mock('server-only', () => ({}));

const permanentRedirect = vi.fn((url: string) => {
  throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${url};308;` });
});

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
  }),
  permanentRedirect: (url: string) => permanentRedirect(url),
}));

// `url-utils.server` pulls the database client in through the readable-slug
// resolver, which this redirect never reaches. Stubbing the one function the
// page imports keeps the test off a live `DATABASE_URL`.
vi.mock('@/app/lib/url-utils.server', () => ({
  redirectWithQuery: (viewUrl: string, searchParams: Record<string, string | string[]>) => {
    const query = new URLSearchParams(
      Object.entries(searchParams).flatMap(([key, value]) =>
        Array.isArray(value)
          ? value.map((entry) => [key, entry] as [string, string])
          : [[key, value] as [string, string]],
      ),
    ).toString();
    return permanentRedirect(query ? `${viewUrl}?${query}` : viewUrl);
  },
}));

vi.mock('@/app/lib/board-slug-utils', () => ({
  resolveBoardBySlug: vi.fn(async () => ({
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
  })),
  boardToRouteParamsFromAngleSegment: vi.fn(() => ({
    board_name: 'spray',
    layout_id: 900,
    size_id: 900,
    set_ids: [1],
    angle: 40,
  })),
}));

vi.mock('@/app/lib/data/queries', () => ({
  getClimb: vi.fn(async () => ({ name: 'Crimp Ladder' })),
}));

const CLIMB_UUID = 'c0ffee00000000000000000000000001';

const { default: BoardSlugPlayRedirectPage } = await import('../page');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('/b/{slug}/{angle}/play/{climb} on a spray wall', () => {
  it('308s to the view URL the page canonicalises to', async () => {
    await expect(
      BoardSlugPlayRedirectPage({
        params: Promise.resolve({ board_slug: 'garage-wall', angle: '40', climb_uuid: CLIMB_UUID }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow('NEXT_REDIRECT');

    expect(permanentRedirect).toHaveBeenCalledWith(`/b/garage-wall/40/view/crimp-ladder-${CLIMB_UUID}`);
  });
});
