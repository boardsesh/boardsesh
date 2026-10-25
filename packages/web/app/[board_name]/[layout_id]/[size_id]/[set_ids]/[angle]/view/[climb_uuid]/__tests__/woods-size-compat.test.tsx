import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { tryConstructSlugViewUrl } from '@/app/lib/url-utils';

// A Woods climb measured on one size must not be drawn on the other: the two
// sizes number holds from different origins, so the render succeeds with the
// wrong holds. The view page redirects (307) to a size the climb fits.

const CLIMB_UUID = 'abcdef1234567890abcdef1234567890';

const redirect = vi.fn((url: string) => {
  const redirectError = new Error('NEXT_REDIRECT') as Error & { digest: string };
  redirectError.digest = `NEXT_REDIRECT;replace;${url};307;`;
  throw redirectError;
});
const permanentRedirect = vi.fn((url: string) => {
  const redirectError = new Error('NEXT_REDIRECT') as Error & { digest: string };
  redirectError.digest = `NEXT_REDIRECT;replace;${url};308;`;
  throw redirectError;
});
const notFound = vi.fn(() => {
  throw new Error('NOT_FOUND');
});
vi.mock('next/navigation', () => ({ redirect, permanentRedirect, notFound }));
vi.mock('server-only', () => ({}));

let routeBoard = 'woods';
let routeSizeId = 2;
let routeIsNumeric = false;
let climbCompatibleSizeIds: number[] | null = [1];

vi.mock('@/app/lib/url-utils.server', () => ({
  parseRouteParams: vi.fn(async () => ({
    parsedParams: {
      board_name: routeBoard,
      layout_id: 1,
      size_id: routeSizeId,
      set_ids: [1],
      angle: 40,
      climb_uuid: CLIMB_UUID,
    },
    isNumericFormat: routeIsNumeric,
  })),
}));

vi.mock('@/app/lib/data/queries', () => ({
  getClimb: vi.fn(async () => ({
    uuid: CLIMB_UUID,
    name: 'Tiny Crimp',
    frames: 'p1r12',
    layoutId: 1,
    compatibleSizeIds: climbCompatibleSizeIds,
  })),
  getClimbStatsForAllAngles: vi.fn(async () => []),
  getLayouts: vi.fn(() => [{ id: 1, name: 'Original' }]),
  getSizes: vi.fn(() => [
    { id: 1, name: '8x10', description: '' },
    { id: 2, name: '12x12', description: '' },
  ]),
  getSets: vi.fn(() => [{ id: 1, name: 'Standard' }]),
}));

vi.mock('@/app/lib/board-utils', () => ({
  getBoardDetailsForBoard: vi.fn((params: { board_name: string; layout_id: number; size_id: number }) => ({
    board_name: params.board_name,
    layout_id: params.layout_id,
    size_id: params.size_id,
    set_ids: [1],
  })),
}));

vi.mock('@/app/lib/warm-overlay-cache', () => ({ scheduleOgImageWarming: vi.fn() }));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({ t: (key: string) => key, locale: 'en-US' })),
}));
vi.mock('@/app/components/board-renderer/util', () => ({
  buildOgBoardRenderUrl: vi.fn(() => 'https://ws.boardsesh.com/og/climb'),
  buildOverlayPreloadUrls: vi.fn(() => []),
  buildOverlayUrl: vi.fn(() => '/api/internal/board-render'),
}));
vi.mock('@/app/lib/data/front-door-data.server', () => ({
  getFrontDoorSimilarClimbs: vi.fn(async () => ({ status: 'loaded', items: [] })),
  getFrontDoorBetaLinks: vi.fn(async () => ({ status: 'loaded', items: [] })),
}));
vi.mock('@/app/components/climb-front-door/climb-front-door', () => ({ default: () => null }));

const pageModule = await import('../page');
const { getBoardDetailsForBoard } = await import('@/app/lib/board-utils');

const renderPage = () =>
  pageModule.default({
    params: Promise.resolve({
      board_name: routeBoard,
      layout_id: '1',
      size_id: String(routeSizeId),
      set_ids: '1',
      angle: '40',
      // Slug-form, so the page's own uuid-only redirect does not fire.
      climb_uuid: `tiny-crimp-${CLIMB_UUID}`,
    }),
  });

beforeEach(() => {
  redirect.mockClear();
  permanentRedirect.mockClear();
  notFound.mockClear();
  vi.mocked(getBoardDetailsForBoard).mockClear();
  routeBoard = 'woods';
  routeSizeId = 2;
  routeIsNumeric = false;
  climbCompatibleSizeIds = [1];
});

describe('Woods climb on a size it does not fit', () => {
  it('redirects the 12x12 request to the 8x10 slug URL', async () => {
    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    const expected = tryConstructSlugViewUrl('woods', 1, 1, [1], 40, CLIMB_UUID, 'Tiny Crimp');
    expect(expected).toBeTruthy();
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith(expected);
    expect(permanentRedirect).not.toHaveBeenCalled();
  });

  it('goes straight to the 8x10 URL from a numeric request, in one hop', async () => {
    routeIsNumeric = true;
    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(permanentRedirect).not.toHaveBeenCalled();
    expect(redirect.mock.calls[0]![0]).toBe(tryConstructSlugViewUrl('woods', 1, 1, [1], 40, CLIMB_UUID, 'Tiny Crimp'));
  });

  it('404s when the climb fits no Woods size', async () => {
    climbCompatibleSizeIds = [99];
    await expect(renderPage()).rejects.toThrow('NOT_FOUND');
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe('metadata for a Woods climb on a size it does not fit', () => {
  const generateMetadata = () =>
    pageModule.generateMetadata({
      params: Promise.resolve({
        board_name: routeBoard,
        layout_id: '1',
        size_id: String(routeSizeId),
        set_ids: '1',
        angle: '40',
        climb_uuid: `tiny-crimp-${CLIMB_UUID}`,
      }),
    });

  it('builds the card and canonical from the size the page redirects to', async () => {
    await generateMetadata();
    expect(vi.mocked(getBoardDetailsForBoard)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getBoardDetailsForBoard).mock.calls[0]![0]).toMatchObject({ size_id: 1 });
  });

  it('keeps the URL size when the climb fits it', async () => {
    climbCompatibleSizeIds = [2];
    await generateMetadata();
    expect(vi.mocked(getBoardDetailsForBoard).mock.calls[0]![0]).toMatchObject({ size_id: 2 });
  });
});

describe('no redirect when the size is fine or unconstrained', () => {
  it('renders when the climb fits the requested size', async () => {
    climbCompatibleSizeIds = [2];
    await renderPage();
    expect(redirect).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
  });

  it.each([[[]], [null]])('renders when compatibleSizeIds is %j', async (ids) => {
    climbCompatibleSizeIds = ids as number[] | null;
    await renderPage();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('leaves other boards alone', async () => {
    routeBoard = 'kilter';
    routeSizeId = 10;
    await renderPage();
    expect(redirect).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
  });
});
