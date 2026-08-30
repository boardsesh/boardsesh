// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * Same contract as the config-tuple twin: 404 only for a climb that is really
 * gone, 5xx for a read that failed. See the sibling test under
 * `app/[board_name]/…/view/[climb_uuid]/__tests__/` for the full rationale.
 */
const NOT_FOUND_DIGEST = 'NEXT_HTTP_ERROR_FALLBACK;404';

vi.mock('server-only', () => ({}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: NOT_FOUND_DIGEST });
  }),
}));

vi.mock('@/app/lib/data/queries', () => ({
  getClimb: vi.fn(),
  getClimbStatsForAllAngles: vi.fn(async () => []),
}));

vi.mock('@/app/lib/data/front-door-data.server', () => ({
  getFrontDoorSimilarClimbs: vi.fn(async () => []),
  getFrontDoorBetaLinks: vi.fn(async () => []),
}));

vi.mock('@/app/lib/board-slug-utils', () => ({
  resolveBoardBySlug: vi.fn(async () => ({ id: 'board-1', isUnlisted: false, isPublic: true })),
  boardToRouteParams: vi.fn(() => ({
    board_name: 'kilter',
    layout_id: 8,
    size_id: 10,
    set_ids: [1, 2],
    angle: 40,
  })),
}));

vi.mock('@/app/lib/board-utils', () => ({
  getBoardDetailsForBoard: vi.fn(() => ({ board_name: 'kilter' })),
}));

vi.mock('@/app/lib/url-utils', () => ({
  buildCanonicalClimbViewUrl: vi.fn(() => '/kilter/original/12x12/screw_bolt/40/view/x'),
  extractUuidFromSlug: vi.fn(() => 'climb-uuid-1'),
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
import { resolveBoardBySlug } from '@/app/lib/board-slug-utils';
import BoardSlugViewPage from '../page';
import { DbReadTimeoutError } from '@/app/lib/db/read-deadline';

const props = {
  params: Promise.resolve({ board_slug: 'marcos-garage', angle: '40', climb_uuid: 'a-climb-climb-uuid-1' }),
} as unknown as Parameters<typeof BoardSlugViewPage>[0];

describe('climb view read-failure status (/b slug tree)', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('404s when the climb genuinely does not exist', async () => {
    vi.mocked(getClimb).mockResolvedValue(null);

    await expect(BoardSlugViewPage(props)).rejects.toMatchObject({ digest: NOT_FOUND_DIGEST });
    expect(notFound).toHaveBeenCalled();
    // Control flow, not a failure. A 404 per stale sitemap entry in the error
    // log is exactly the volume that hides a real brownout.
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('404s when the board slug resolves cleanly to nothing', async () => {
    vi.mocked(resolveBoardBySlug).mockResolvedValueOnce(null);

    await expect(BoardSlugViewPage(props)).rejects.toMatchObject({ digest: NOT_FOUND_DIGEST });
    expect(notFound).toHaveBeenCalled();
  });

  it('rethrows a failed board-slug lookup instead of 404-ing an indexed URL', async () => {
    // The first read on the request, and it sits above the try — a backend blip
    // used to become a 404 that Vercel then CDN-cached for up to 24 hours.
    vi.mocked(resolveBoardBySlug).mockRejectedValueOnce(new Error('boardBySlug lookup failed with HTTP 502'));

    await expect(BoardSlugViewPage(props)).rejects.toThrow('HTTP 502');
    expect(notFound).not.toHaveBeenCalled();
  });

  it('rethrows a read deadline instead of 404-ing an indexed URL', async () => {
    vi.mocked(getClimb).mockRejectedValue(new DbReadTimeoutError('climb-select', 6000));

    await expect(BoardSlugViewPage(props)).rejects.toBeInstanceOf(DbReadTimeoutError);
    expect(notFound).not.toHaveBeenCalled();
  });

  it('rethrows any other read failure instead of 404-ing an indexed URL', async () => {
    vi.mocked(getClimb).mockRejectedValue(new Error('connection terminated unexpectedly'));

    await expect(BoardSlugViewPage(props)).rejects.toThrow('connection terminated unexpectedly');
    expect(notFound).not.toHaveBeenCalled();
  });
});
