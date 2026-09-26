// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * An alias URL names a husk uuid that `getClimb` resolves to the canonical
 * climb. Every per-climb read after that — angle stats, similar climbs, beta —
 * must key on the uuid the climb resolved to, not the one in the URL: the husk
 * has none of its own, so keying on it renders an empty front door and an
 * angle-less canonical. The `/b/` tree pins the same contract in
 * `view-seo-fragment.test.tsx` and `page-metadata.test.tsx`.
 */
vi.mock('server-only', () => ({}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
  }),
  permanentRedirect: vi.fn(() => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/x;308;' });
  }),
}));

vi.mock('@/app/lib/data/queries', () => ({
  getClimb: vi.fn(async () => ({
    uuid: 'canonical-climb',
    name: 'Test Climb',
    difficulty: 'V5',
    setter_username: 'setter-person',
    quality_average: '4.20',
    ascensionist_count: 12,
    frames: 'p1r12',
  })),
  getClimbStatsForAllAngles: vi.fn(async () => []),
  getLayouts: vi.fn(() => []),
  getSizes: vi.fn(() => []),
  getSets: vi.fn(() => []),
}));

vi.mock('@/app/lib/data/front-door-data.server', () => ({
  getFrontDoorSimilarClimbs: vi.fn(async () => ({ status: 'loaded', items: [] })),
  getFrontDoorBetaLinks: vi.fn(async () => ({ status: 'loaded', items: [] })),
}));

vi.mock('@/app/lib/url-utils.server', () => ({
  parseRouteParams: vi.fn(async () => ({
    parsedParams: {
      board_name: 'kilter',
      layout_id: 8,
      size_id: 10,
      set_ids: [1, 2],
      angle: 40,
      climb_uuid: 'alias-climb',
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
  buildOverlayPreloadUrls: vi.fn(() => []),
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
  createBoardContentPageMetadata: vi.fn((input: unknown) => input),
}));

import { getClimbStatsForAllAngles } from '@/app/lib/data/queries';
import { getFrontDoorBetaLinks, getFrontDoorSimilarClimbs } from '@/app/lib/data/front-door-data.server';
import { createBoardContentPageMetadata } from '@/app/lib/seo/metadata';
import ClimbViewPage, { generateMetadata } from '../page';

const props = {
  params: Promise.resolve({
    board_name: 'kilter',
    layout_id: 'original',
    size_id: '12x12',
    set_ids: 'screw_bolt',
    angle: '40',
    climb_uuid: 'alias-climb',
  }),
} as unknown as Parameters<typeof ClimbViewPage>[0];

describe('an alias URL on the config-tuple tree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads angle stats, similar climbs and beta for the canonical climb, not the husk uuid', async () => {
    await ClimbViewPage(props);

    expect(vi.mocked(getClimbStatsForAllAngles)).toHaveBeenCalledWith('kilter', 'canonical-climb');
    expect(vi.mocked(getFrontDoorSimilarClimbs)).toHaveBeenCalledWith(
      expect.objectContaining({ climbUuid: 'canonical-climb' }),
    );
    expect(vi.mocked(getFrontDoorBetaLinks)).toHaveBeenCalledWith(
      expect.objectContaining({ climbUuid: 'canonical-climb' }),
    );
  });

  it('keys the metadata angle stats on the canonical climb', async () => {
    await generateMetadata(props);

    // Not the fallback metadata: a throw inside generateMetadata would be
    // swallowed into it and leave the stats assertion below unreached.
    expect(vi.mocked(createBoardContentPageMetadata)).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'metadata.view.title' }),
    );
    expect(vi.mocked(getClimbStatsForAllAngles)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getClimbStatsForAllAngles)).toHaveBeenCalledWith('kilter', 'canonical-climb');
  });
});
