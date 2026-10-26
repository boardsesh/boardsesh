import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
// Real (unmocked) slug builders, used to compute the expected self-redirect
// URL the same way `constructClimbViewUrlWithSlugs` does — rather than
// hardcoding a slug string that would silently drift from the real formatter.
import {
  generateLayoutSlug,
  generateSizeSlug,
  generateSetSlug,
  extractUuidFromSlug,
  tryConstructSlugViewUrl,
  constructClimbViewUrlWithSlugs,
} from '@/app/lib/url-utils';
import {
  permanentRedirect as nextPermanentRedirect,
  getRedirectStatusCodeFromError,
  getURLFromRedirectError,
} from 'next/dist/client/components/redirect';
import { isRedirectError } from 'next/dist/client/components/redirect-error';
import type { ParsedBoardRouteParametersWithUuid } from '@/app/lib/types';

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
const ALIAS_UUID = '11112222333344445555666677778888';

// Exercise the installed Next implementation: status and destination come from
// its real NEXT_REDIRECT error rather than a digest recreated in the test.
const permanentRedirect = vi.fn(nextPermanentRedirect);
const notFound = vi.fn(() => {
  throw new Error('NOT_FOUND');
});

vi.mock('next/navigation', () => ({ permanentRedirect, notFound }));

// Branches on the requested climb_uuid so a single mock can drive both the
// legacy-numeric-format redirect test and the self-redirect regression below
// without needing per-test module resets.
vi.mock('@/app/lib/url-utils.server', () => ({
  parseRouteParams: vi.fn(async (params: { climb_uuid?: string; layout_id?: string }) => {
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
        climb_uuid: extractUuidFromSlug(params.climb_uuid ?? CLIMB_UUID),
      },
      isNumericFormat: params.layout_id === '1',
    };
  }),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale: vi.fn(async () => 'en-US') }));

vi.mock('@/app/lib/data/queries', () => ({
  getClimb: vi.fn(async (parsedParams: { climb_uuid?: string }) =>
    parsedParams.climb_uuid === SELF_REDIRECT_UUID
      ? { uuid: SELF_REDIRECT_UUID, name: 'Скала', frames: 'p1r12' } // Cyrillic: generateSlugFromText's ASCII-only `\w` slugs this to ''
      : { uuid: CLIMB_UUID, name: 'My Test Climb', frames: 'p1r12' },
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
vi.mock('@/app/lib/warm-overlay-cache', () => ({ scheduleOgImageWarming: vi.fn() }));
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
  getFrontDoorSimilarClimbs: vi.fn(async () => ({ status: 'loaded', items: [] })),
  getFrontDoorBetaLinks: vi.fn(async () => ({ status: 'loaded', items: [] })),
}));
vi.mock('@/app/components/climb-front-door/climb-front-door', () => ({ default: () => null }));

function requireRedirectError(outcome: unknown) {
  expect(isRedirectError(outcome)).toBe(true);
  if (!isRedirectError(outcome)) throw new Error('Expected a Next redirect error');
  return outcome;
}

const pageModule = await import('../page');
const { getLocale } = await import('@/app/lib/i18n/get-locale');
const { getClimb } = await import('@/app/lib/data/queries');

beforeEach(() => {
  permanentRedirect.mockClear();
  notFound.mockClear();
  vi.mocked(getLocale).mockResolvedValue('en-US');
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

describe('resolved alias climb redirects', () => {
  const expectedPath = () => tryConstructSlugViewUrl('kilter', 1, 10, [1, 20], 40, CLIMB_UUID, 'My Test Climb');

  it.each([ALIAS_UUID, `old-name-${ALIAS_UUID}`])(
    '308s alias %s to the exact resolved climb URL',
    async (requestedClimb) => {
      const outcome = await pageModule
        .default({
          params: Promise.resolve({
            board_name: 'kilter',
            layout_id: 'kilter-board-original',
            size_id: '12x12',
            set_ids: 'bolt-ons_screw-ons',
            angle: '40',
            climb_uuid: requestedClimb,
          }),
        })
        .catch((error: unknown) => error);

      expect(getRedirectStatusCodeFromError(requireRedirectError(outcome))).toBe(308);
      expect(getURLFromRedirectError(requireRedirectError(outcome))).toBe(expectedPath());
      expect(getURLFromRedirectError(requireRedirectError(outcome))).not.toContain(ALIAS_UUID);
    },
  );

  it('renders the canonical landing instead of redirecting again', async () => {
    const target = expectedPath();
    if (!target) throw new Error('Expected canonical URL');
    const [board_name, layout_id, size_id, set_ids, angle, , climb_uuid] = target.slice(1).split('/');
    const rendered = await pageModule.default({
      params: Promise.resolve({ board_name, layout_id, size_id, set_ids, angle, climb_uuid }),
    });
    expect(rendered).toBeTruthy();
    expect(permanentRedirect).not.toHaveBeenCalled();
  });

  it('preserves the requested locale on an alias redirect', async () => {
    vi.mocked(getLocale).mockResolvedValueOnce('es');
    const outcome = await pageModule
      .default({
        params: Promise.resolve({
          board_name: 'kilter',
          layout_id: 'original',
          size_id: '12x12',
          set_ids: 'screw_bolt',
          angle: '40',
          climb_uuid: `old-${ALIAS_UUID}`,
        }),
      })
      .catch((error: unknown) => error);
    expect(getRedirectStatusCodeFromError(requireRedirectError(outcome))).toBe(308);
    expect(getURLFromRedirectError(requireRedirectError(outcome))).toBe(`/es${expectedPath()}`);
  });

  it('uses the resolved UUID in the numeric fallback builder too', async () => {
    const { parseRouteParams } = await import('@/app/lib/url-utils.server');
    const parsedParams: ParsedBoardRouteParametersWithUuid = {
      board_name: 'kilter',
      layout_id: 424242,
      size_id: 424242,
      set_ids: [424242],
      angle: 40,
      climb_uuid: ALIAS_UUID,
    };
    vi.mocked(parseRouteParams).mockResolvedValueOnce({ parsedParams, isNumericFormat: true });
    const outcome = await pageModule
      .default({
        params: Promise.resolve({
          board_name: 'kilter',
          layout_id: '424242',
          size_id: '424242',
          set_ids: '424242',
          angle: '40',
          climb_uuid: ALIAS_UUID,
        }),
      })
      .catch((error: unknown) => error);
    expect(getRedirectStatusCodeFromError(requireRedirectError(outcome))).toBe(308);
    expect(getURLFromRedirectError(requireRedirectError(outcome))).toBe(
      constructClimbViewUrlWithSlugs(
        'kilter',
        'Kilter Board Original',
        '12 x 12',
        'Commercial',
        ['Bolt Ons'],
        40,
        CLIMB_UUID,
        'My Test Climb',
      ),
    );
  });

  it('redirects a non-Latin alias to the bare canonical UUID once', async () => {
    vi.mocked(getClimb).mockResolvedValueOnce({ uuid: CLIMB_UUID, name: 'Скала', frames: 'p1r12' } as never);
    const outcome = await pageModule
      .default({
        params: Promise.resolve({
          board_name: 'kilter',
          layout_id: 'original',
          size_id: '12x12',
          set_ids: 'screw_bolt',
          angle: '40',
          climb_uuid: ALIAS_UUID,
        }),
      })
      .catch((error: unknown) => error);
    expect(getRedirectStatusCodeFromError(requireRedirectError(outcome))).toBe(308);
    expect(getURLFromRedirectError(requireRedirectError(outcome))).toBe(
      tryConstructSlugViewUrl('kilter', 1, 10, [1, 20], 40, CLIMB_UUID, 'Скала'),
    );
  });
});
