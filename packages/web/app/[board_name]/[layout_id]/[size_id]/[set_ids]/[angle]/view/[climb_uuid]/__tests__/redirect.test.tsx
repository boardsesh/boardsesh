import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
// Real (unmocked) slug builders, used to compute the expected self-redirect
// URL the same way `constructClimbViewUrlWithSlugs` does — rather than
// hardcoding a slug string that would silently drift from the real formatter.
import { generateLayoutSlug, generateSizeSlug, generateSetSlug } from '@/app/lib/url-utils';

// Regression for the legacy layout hijacking numeric climb-view URLs: the
// board `[angle]` layout used to 308 every numeric URL to the bare slug LIST
// URL, racing (and often beating) this view page's own redirect and dropping
// the climb. With the layout gated off for `/view/`, this page's redirect — to
// the slug VIEW URL that preserves the climb uuid — is the one that runs.

const CLIMB_UUID = 'abcdef1234567890abcdef1234567890';
// Distinct uuid for the self-redirect regression: a bare-uuid request whose
// climb name is entirely non-Latin, so it never collides with the real
// `board-constants` lookups the numeric-format test above exercises.
const SELF_REDIRECT_UUID = 'ffffffff000011112222333344445555';

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

// Branches on the requested climb_uuid so a single mock can drive both the
// legacy-numeric-format redirect test and the self-redirect regression below
// without needing per-test module resets.
vi.mock('@/app/lib/url-utils.server', () => ({
  parseRouteParams: vi.fn(async (params: { climb_uuid?: string }) => {
    if (params.climb_uuid === SELF_REDIRECT_UUID) {
      // Slug-format layout/size/set segments (not numeric), and ids that
      // don't resolve against the real `board-constants` tables — so
      // `tryConstructSlugViewUrl` falls through to the name-based builder,
      // whose fallback for a non-Latin name is the bare uuid this route was
      // already requested with.
      return {
        parsedParams: {
          board_name: 'kilter',
          layout_id: 424242,
          size_id: 424242,
          set_ids: [424242],
          angle: 40,
          climb_uuid: SELF_REDIRECT_UUID,
        },
        isNumericFormat: false,
      };
    }
    return {
      parsedParams: {
        board_name: 'kilter',
        layout_id: 1,
        size_id: 10,
        set_ids: [1, 20],
        angle: 40,
        climb_uuid: CLIMB_UUID,
      },
      isNumericFormat: true,
    };
  }),
}));

vi.mock('server-only', () => ({}));

vi.mock('@/app/lib/data/queries', () => ({
  getClimb: vi.fn(async (parsedParams: { climb_uuid?: string }) =>
    parsedParams.climb_uuid === SELF_REDIRECT_UUID
      ? { name: 'Скала', frames: 'p1r12' } // Cyrillic: generateSlugFromText's ASCII-only `\w` slugs this to ''
      : { name: 'My Test Climb', frames: 'p1r12' },
  ),
  getClimbStatsForAllAngles: vi.fn(async () => []),
  getLayouts: vi.fn(async (board_name: string) =>
    board_name === 'kilter'
      ? [
          { id: 1, name: 'Kilter Board Original' },
          { id: 424242, name: 'Kilter Board Original' },
        ]
      : [],
  ),
  getSizes: vi.fn(async () => [
    { id: 10, name: '12 x 12', description: 'Commercial' },
    { id: 424242, name: '12 x 12', description: 'Commercial' },
  ]),
  getSets: vi.fn(async () => [
    { id: 1, name: 'Bolt Ons' },
    { id: 20, name: 'Screw Ons' },
    { id: 424242, name: 'Bolt Ons' },
  ]),
}));

vi.mock('@/app/lib/board-utils', () => ({
  getBoardDetailsForBoard: vi.fn(
    (params: { board_name: string; layout_id: number; size_id: number; set_ids: number[] }) => ({
      board_name: params.board_name,
      layout_id: params.layout_id,
      size_id: params.size_id,
      set_ids: params.set_ids,
    }),
  ),
}));

// Body/metadata imports pulled in at module load but never exercised on the
// redirect path; stub the ones that reach server-only or client code.
vi.mock('@/app/lib/warm-overlay-cache', () => ({ scheduleOverlayWarming: vi.fn() }));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({ t: (key: string) => key, locale: 'en-US' })),
}));
vi.mock('@/app/components/board-renderer/util', () => ({
  buildOgBoardRenderUrl: vi.fn(() => 'https://ws.boardsesh.com/og/climb'),
  buildOverlayPreloadUrls: vi.fn((_bd: unknown, frames: string | null | undefined) =>
    frames ? ['/api/internal/board-render'] : [],
  ),
  buildOverlayUrl: vi.fn(() => '/api/internal/board-render'),
}));
vi.mock('@/app/lib/data/front-door-data.server', () => ({
  getFrontDoorSimilarClimbs: vi.fn(async () => []),
  getFrontDoorBetaLinks: vi.fn(async () => []),
}));
vi.mock('@/app/components/climb-front-door/climb-front-door', () => ({ default: () => null }));

const pageModule = await import('../page');

beforeEach(() => {
  permanentRedirect.mockClear();
  notFound.mockClear();
});

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

describe('non-Latin climb name self-redirect', () => {
  it('renders instead of 308ing to itself when the slug target equals the request', async () => {
    // `generateSlugFromText` is ASCII-only, so a Cyrillic-only climb name
    // slugs to '' and both slug builders fall back to the bare uuid — the
    // exact URL this page was requested with when the board/layout/size/set
    // segments are already slugs. This is the requested path built the same
    // way `constructClimbViewUrlWithSlugs` builds its target, so an unguarded
    // `permanentRedirect` here would 308 the page to itself forever.
    const layoutSlug = generateLayoutSlug('Kilter Board Original');
    const sizeSlug = generateSizeSlug('12 x 12', 'Commercial');
    const setSlug = generateSetSlug(['Bolt Ons']);

    const result = await pageModule.default({
      params: Promise.resolve({
        board_name: 'kilter',
        layout_id: layoutSlug,
        size_id: sizeSlug,
        set_ids: setSlug,
        angle: '40',
        climb_uuid: SELF_REDIRECT_UUID,
      }),
    });

    // No redirect fired, and the page rendered instead of throwing NOT_FOUND
    // or NEXT_REDIRECT.
    expect(permanentRedirect).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
    expect(result).toBeTruthy();
  });
});
