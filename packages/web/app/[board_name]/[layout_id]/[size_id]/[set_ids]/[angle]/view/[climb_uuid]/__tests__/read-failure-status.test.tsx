// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * The mass-deindexing guard.
 *
 * A climb URL that is in the sitemap must answer 404 only when the climb is
 * genuinely gone. When the read fails — a saturated pool, a read deadline, a
 * dead database — it has to be a 5xx, because Google retries a 5xx and keeps
 * the URL while a 404 tells it to drop the page. This page used to end its
 * catch in `notFound()`, which collapsed both cases into 404.
 */
const NOT_FOUND_DIGEST = 'NEXT_HTTP_ERROR_FALLBACK;404';

vi.mock('server-only', () => ({}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: NOT_FOUND_DIGEST });
  }),
  permanentRedirect: vi.fn(() => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/x;308;' });
  }),
}));

vi.mock('@/app/lib/data/queries', () => ({
  getClimb: vi.fn(),
  getClimbStatsForAllAngles: vi.fn(async () => []),
  getLayouts: vi.fn(() => []),
  getSizes: vi.fn(() => []),
  getSets: vi.fn(() => []),
}));

vi.mock('@/app/lib/data/front-door-data.server', () => ({
  getFrontDoorSimilarClimbs: vi.fn(async () => []),
  getFrontDoorBetaLinks: vi.fn(async () => []),
}));

vi.mock('@/app/lib/url-utils.server', () => ({
  parseRouteParams: vi.fn(async () => ({
    parsedParams: {
      board_name: 'kilter',
      layout_id: 8,
      size_id: 10,
      set_ids: [1, 2],
      angle: 40,
      climb_uuid: 'climb-uuid-1',
    },
    isNumericFormat: false,
  })),
}));

vi.mock('@/app/lib/board-utils', () => ({
  getBoardDetailsForBoard: vi.fn(() => ({ board_name: 'kilter' })),
}));

vi.mock('@/app/lib/url-utils', () => ({
  buildCanonicalClimbViewUrl: vi.fn(() => '/kilter/original/12x12/screw_bolt/40/view/x'),
  isUuidOnly: vi.fn(() => false),
  constructClimbViewUrlWithSlugs: vi.fn(() => '/x'),
  tryConstructSlugViewUrl: vi.fn(() => '/x'),
}));

vi.mock('@/app/components/board-renderer/util', () => ({
  buildOgBoardRenderUrl: vi.fn(() => 'https://ws.boardsesh.com/og/climb'),
  buildOverlayPreloadUrls: vi.fn((_bd: unknown, frames: string | null | undefined) =>
    frames ? ['/api/internal/board-render'] : [],
  ),
  buildOverlayUrl: vi.fn(() => '/api/internal/board-render'),
}));

vi.mock('@/app/lib/warm-overlay-cache', () => ({
  scheduleOgImageWarming: vi.fn(),
}));

vi.mock('@/app/components/climb-front-door/climb-front-door', () => ({
  default: () => null,
}));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({ t: (key: string) => key, locale: 'en-US' })),
}));

vi.mock('@/app/lib/seo/metadata', () => ({
  createPageMetadata: vi.fn((input: unknown) => input),
}));

import { notFound } from 'next/navigation';
import { getClimb } from '@/app/lib/data/queries';
import ClimbViewPage from '../page';
import { DbReadTimeoutError } from '@/app/lib/db/read-deadline';

const props = {
  params: Promise.resolve({
    board_name: 'kilter',
    layout_id: 'original',
    size_id: '12x12',
    set_ids: 'screw_bolt',
    angle: '40',
    climb_uuid: 'climb-uuid-1',
  }),
} as unknown as Parameters<typeof ClimbViewPage>[0];

describe('climb view read-failure status (config-tuple tree)', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('404s when the climb genuinely does not exist', async () => {
    vi.mocked(getClimb).mockResolvedValue(null);

    await expect(ClimbViewPage(props)).rejects.toMatchObject({ digest: NOT_FOUND_DIGEST });
    expect(notFound).toHaveBeenCalled();
  });

  it('does not log a 404 as an error', async () => {
    vi.mocked(getClimb).mockResolvedValue(null);

    await expect(ClimbViewPage(props)).rejects.toMatchObject({ digest: NOT_FOUND_DIGEST });
    // Stale sitemap entries and legacy-URL 308s are routine and high-volume on
    // the crawl path. Logging them at error level buries the read failures this
    // catch exists to surface.
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('rethrows a read deadline instead of 404-ing an indexed URL', async () => {
    vi.mocked(getClimb).mockRejectedValue(new DbReadTimeoutError('climb-select', 6000));

    await expect(ClimbViewPage(props)).rejects.toBeInstanceOf(DbReadTimeoutError);
    expect(notFound).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });

  it('rethrows any other read failure instead of 404-ing an indexed URL', async () => {
    vi.mocked(getClimb).mockRejectedValue(new Error('connection terminated unexpectedly'));

    await expect(ClimbViewPage(props)).rejects.toThrow('connection terminated unexpectedly');
    expect(notFound).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });
});
