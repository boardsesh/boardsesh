import { describe, expect, it, vi } from 'vite-plus/test';

// Regression for the legacy layout hijacking numeric climb-view URLs: the
// board `[angle]` layout used to 308 every numeric URL to the bare slug LIST
// URL, racing (and often beating) this view page's own redirect and dropping
// the climb. With the layout gated off for `/view/`, this page's redirect — to
// the slug VIEW URL that preserves the climb uuid — is the one that runs.

const CLIMB_UUID = 'abcdef1234567890abcdef1234567890';

// `permanentRedirect` throws a NEXT_REDIRECT error whose `digest` the page's
// catch block re-throws (rather than swallowing into a 404). Mirror that shape
// so the redirect propagates, and capture the target URL.
const permanentRedirect = vi.fn((url: string) => {
  const redirectError = new Error('NEXT_REDIRECT') as Error & { digest: string };
  redirectError.digest = `NEXT_REDIRECT;replace;${url};308;`;
  throw redirectError;
});
const notFound = vi.fn(() => {
  throw new Error('NOT_FOUND');
});

vi.mock('next/navigation', () => ({ permanentRedirect, notFound }));

vi.mock('@/app/lib/url-utils.server', () => ({
  parseRouteParams: vi.fn(async () => ({
    parsedParams: {
      board_name: 'kilter',
      layout_id: 1,
      size_id: 10,
      set_ids: [1, 20],
      angle: 40,
      climb_uuid: CLIMB_UUID,
    },
    isNumericFormat: true,
  })),
}));

vi.mock('@/app/lib/data/queries', () => ({
  getClimb: vi.fn(async () => ({ name: 'My Test Climb', frames: 'p1r12' })),
  getLayouts: vi.fn(async () => [{ id: 1, name: 'Kilter Board Original' }]),
  getSizes: vi.fn(async () => [{ id: 10, name: '12 x 12', description: 'Commercial' }]),
  getSets: vi.fn(async () => [
    { id: 1, name: 'Bolt Ons' },
    { id: 20, name: 'Screw Ons' },
  ]),
}));

vi.mock('@/app/lib/board-utils', () => ({
  getBoardDetailsForBoard: vi.fn(() => ({ board_name: 'kilter' })),
}));

// Body/metadata imports pulled in at module load but never exercised on the
// redirect path; stub the ones that reach server-only or client code.
vi.mock('@/app/lib/warm-overlay-cache', () => ({ scheduleOverlayWarming: vi.fn() }));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({ t: (key: string) => key, locale: 'en-US' })),
}));
vi.mock('@/app/components/board-renderer/util', () => ({
  buildOgBoardRenderUrl: vi.fn(() => 'https://ws.boardsesh.com/og/climb'),
  buildOverlayUrl: vi.fn(() => '/api/internal/board-render'),
}));
vi.mock('@/app/components/board-page/board-page-climbs-list', () => ({ default: () => null }));
vi.mock('@/app/components/climb-detail/climb-view-seo-fragment', () => ({ default: () => null }));

const pageModule = await import('../page');

describe('legacy numeric climb-view redirect', () => {
  it('redirects a numeric view URL to the slug VIEW URL preserving the climb uuid', async () => {
    await expect(
      pageModule.default({
        params: Promise.resolve({
          board_name: 'kilter',
          layout_id: '1',
          size_id: '10',
          set_ids: '1,20',
          angle: '40',
          climb_uuid: CLIMB_UUID,
        }),
      }),
    ).rejects.toThrow('NEXT_REDIRECT');

    expect(notFound).not.toHaveBeenCalled();
    expect(permanentRedirect).toHaveBeenCalledTimes(1);

    const target = permanentRedirect.mock.calls[0]![0];
    // The climb survives the redirect: a `/view/` URL carrying the uuid, never
    // the bare `/list` URL the layout used to send these links to.
    expect(target).toContain('/view/');
    expect(target).toContain(CLIMB_UUID);
    expect(target).not.toContain('/list');
  });
});
